import type { GithubClient } from './github.ts';
import type { GitClient } from './git.ts';
import type { Logger } from './log.ts';
import { planReconciliation, type ReconcileOp } from './reconciler.ts';
import { diffSpecs, parseSpecs } from './specs.ts';
import type { StateStore } from './state.ts';
import type { ManagedPR, Spec } from './types.ts';

export const STATUS_LABELS = [
  'status:todo',
  'status:processing',
  'status:in-review',
  'status:done',
  'status:failed',
];

export interface ReconcileContext {
  repoDir: string;
  git: GitClient;
  github: GithubClient;
  state: StateStore;
  logger: Logger;
  mainBranch?: string;
}

export interface ReconcileSummary {
  targetMainSha: string;
  ops: ReconcileOp[];
  specs: Spec[];
}

export function previousSpecsFromState(
  requirements: Record<string, { specHash: string; specPath: string }>,
): Spec[] {
  return Object.entries(requirements).map(([id, r]) => ({
    id,
    title: '',
    path: r.specPath,
    body: '',
    hash: r.specHash,
  }));
}

export async function planForMain(ctx: ReconcileContext): Promise<ReconcileSummary | null> {
  const mainBranch = ctx.mainBranch ?? 'main';
  await ctx.git.fetch(ctx.repoDir, mainBranch);
  const targetMainSha = await ctx.git.revParse(ctx.repoDir, `origin/${mainBranch}`);
  const files = await ctx.git.readSpecSnapshot(ctx.repoDir, `origin/${mainBranch}`);
  const parsed = parseSpecs(files);
  if (parsed.errors.length > 0) {
    ctx.logger.warn(`需求解析失败，本轮不执行对账: ${parsed.errors.map((e) => e.reason).join('; ')}`);
    return null;
  }
  const state = ctx.state.snapshot();
  const cursor = state.cursorMainSha;
  let previous: Spec[] = [];
  if (cursor) {
    try {
      await ctx.git.revParse(ctx.repoDir, cursor);
    } catch {
      ctx.logger.warn(`游标 ${cursor} 无法解析，跳过本轮对账以保留未完成差量`);
      return null;
    }
    const baselineFiles = await ctx.git.readSpecSnapshot(ctx.repoDir, cursor);
    const baselineParsed = parseSpecs(baselineFiles);
    if (baselineParsed.errors.length > 0) {
      ctx.logger.warn(`游标基线解析失败，跳过本轮对账: ${baselineParsed.errors.map((e) => e.reason).join('; ')}`);
      return null;
    }
    previous = baselineParsed.specs;
  }
  const diff = diffSpecs(previous, parsed.specs);
  const issues = await ctx.github.listIssues();
  const prs = await ctx.github.listPRs();
  const ops = planReconciliation(diff, issues, targetMainSha, prs);
  return { targetMainSha, ops, specs: parsed.specs };
}

export async function applyReconciliation(
  ctx: ReconcileContext,
  ops: ReconcileOp[],
  targetMainSha: string,
): Promise<void> {
  let failed = false;
  for (const op of ops) {
    try {
      if (op.kind === 'create' && op.spec) {
        const number = await ctx.github.createIssue(op.title!, op.issueBody!, op.labels ?? []);
        await ctx.state.update((s) => {
          s.requirements[op.reqId] = {
            issueNumber: number,
            specHash: op.spec!.hash,
            specPath: op.spec!.path,
            sourceMainSha: targetMainSha,
          };
          return undefined;
        });
        ctx.logger.info(`创建任务 #${number}（${op.reqId}）`);
        continue;
      }

      if (op.kind === 'update' && op.spec && op.issueNumber) {
        await ctx.github.updateIssueBody(op.issueNumber, op.issueBody!);
        await ctx.github.reopenIssue(op.issueNumber!);
        await ctx.github.removeLabels(op.issueNumber!, STATUS_LABELS);
        await ctx.github.addLabels(op.issueNumber!, ['pi-task', 'status:todo']);
        await ctx.state.update((s) => {
          s.requirements[op.reqId] = {
            issueNumber: op.issueNumber!,
            specHash: op.spec!.hash,
            specPath: op.spec!.path,
            sourceMainSha: targetMainSha,
          };
          return undefined;
        });
        ctx.logger.info(`更新任务 #${op.issueNumber}（${op.reqId}）`);
        continue;
      }

      if (op.kind === 'close') {
        if (op.issueNumber) {
          await ctx.github.closeIssue(op.issueNumber!);
        }
        await ctx.state.update((s) => {
          delete s.requirements[op.reqId];
          return undefined;
        });
        ctx.logger.info(`关闭任务 #${op.issueNumber ?? '?'}（${op.reqId}）`);
        continue;
      }

      if (op.kind === 'close-pr' && op.prNumber) {
        const reason = op.reason;
        if (reason) await tolerant(() => ctx.github.comment(op.prNumber!, reason));
        await ctx.github.closePR(op.prNumber!);
        ctx.logger.info(`关闭过期 PR #${op.prNumber}（${op.reqId}）`);
        continue;
      }

      const backfill = op.backfill;
      if (op.kind === 'noop' && op.issueNumber && backfill) {
        await ctx.state.update((s) => {
          s.requirements[op.reqId] = {
            issueNumber: op.issueNumber!,
            ...backfill,
          };
          return undefined;
        });
        ctx.logger.info(`回填任务 #${op.issueNumber}（${op.reqId}）本地状态`);
        continue;
      }
    } catch (error) {
      failed = true;
      ctx.logger.warn(`对账操作 ${op.kind}(${op.reqId}) 失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (failed) {
    const message = '本轮对账存在失败操作，保留游标并停止后续派发，待下轮重试未完成差量';
    ctx.logger.warn(message);
    throw new Error(message);
  }
  await ctx.state.update((s) => {
    s.cursorMainSha = targetMainSha;
    return undefined;
  });
}

export async function reconcileOnce(ctx: ReconcileContext): Promise<ReconcileSummary | null> {
  const summary = await planForMain(ctx);
  if (!summary) return null;
  await applyReconciliation(ctx, summary.ops, summary.targetMainSha);
  return summary;
}

async function tolerant(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch {
    // Label/state transitions are best-effort; the operation itself is recorded by idempotent metadata.
  }
}
