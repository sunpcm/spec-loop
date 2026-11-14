import { join } from 'node:path';
import type { GithubClient } from './github.ts';
import type { GitClient } from './git.ts';
import type { Logger } from './log.ts';
import { STATUS_LABELS } from './scheduler.ts';
import type { StateStore } from './state.ts';
import type { ManagedIssue, ManagedPR } from './types.ts';

export interface DeployDeps {
  repoDir: string;
  runDir: string;
  git: GitClient;
  github: GithubClient;
  state: StateStore;
  logger: Logger;
  mainBranch?: string;
  publicUrl?: string;
  build: (sha: string) => Promise<{ ok: boolean; detail: string }>;
  healthCheck: (sha: string) => Promise<boolean>;
  switchPreview: (sha: string, releaseDir: string) => Promise<void>;
  notify?: (text: string) => Promise<void>;
}

export interface DeployResult {
  status: 'deployed' | 'failed' | 'nothing';
  sha?: string;
  prNumber?: number;
  issueNumber?: number;
  error?: string;
}

export async function discoverMergedCodePRs(ctx: DeployDeps): Promise<ManagedPR[]> {
  const prs = await ctx.github.listPRs();
  return prs.filter((p) => p.merged && p.meta?.kind === 'code-pr');
}

export function issueNumberForPR(ctx: DeployDeps, pr: ManagedPR): number | undefined {
  const reqId = typeof pr.meta?.reqId === 'string' ? pr.meta.reqId : undefined;
  if (!reqId) return undefined;
  return ctx.state.snapshot().requirements[reqId]?.issueNumber;
}

export function isCurrentDelivery(ctx: DeployDeps, pr: ManagedPR): boolean {
  const reqId = typeof pr.meta?.reqId === 'string' ? pr.meta.reqId : undefined;
  const specHash = typeof pr.meta?.specHash === 'string' ? pr.meta.specHash : undefined;
  const sourceMainSha = typeof pr.meta?.sourceMainSha === 'string' ? pr.meta.sourceMainSha : undefined;
  if (!reqId || !specHash || !sourceMainSha) return false;
  const requirement = ctx.state.snapshot().requirements[reqId];
  return (
    requirement !== undefined &&
    requirement.specHash === specHash &&
    requirement.sourceMainSha === sourceMainSha
  );
}

function mergeTime(pr: ManagedPR): number {
  const time = Date.parse(pr.mergedAt ?? '');
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

async function tryGithub(fn: () => Promise<void>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch {
    return false;
  }
}

async function markDeployFailed(
  ctx: DeployDeps,
  pr: ManagedPR,
  issueNumber: number | undefined,
  detail: string,
): Promise<void> {
  if (issueNumber) {
    await tolerant(() => ctx.github.removeLabels(issueNumber, STATUS_LABELS));
    await tolerant(() => ctx.github.addLabels(issueNumber, ['pi-task', 'status:failed']));
    await tolerant(() => ctx.github.comment(issueNumber, `❌ 部署失败，保留旧预览，重试仅恢复部署阶段：\n${detail}`));
  }
  await ctx.state.update((s) => {
    if (!s.deploy.deployFailedPRs) s.deploy.deployFailedPRs = [];
    if (!s.deploy.deployFailedPRs.includes(pr.number)) s.deploy.deployFailedPRs.push(pr.number);
    for (const job of Object.values(s.jobs)) {
      if (job.prNumber === pr.number) {
        job.status = 'failed';
        job.failureStage = 'deploy';
        job.resumeAction = 'deploy-only';
        job.updatedAt = new Date().toISOString();
      }
    }
    return undefined;
  });
  ctx.logger.warn(`部署失败（PR #${pr.number}）: ${detail}`);
}

async function markDeployed(
  ctx: DeployDeps,
  pr: ManagedPR,
  issueNumber: number | undefined,
  sha: string,
): Promise<void> {
  await ctx.state.update((s) => {
    s.deploy.activeSha = sha;
    s.deploy.releaseDir = join(ctx.runDir, 'releases', sha);
    if (!s.deploy.deployedPRs.includes(pr.number)) s.deploy.deployedPRs.push(pr.number);
    s.deploy.deployFailedPRs = (s.deploy.deployFailedPRs ?? []).filter((n) => n !== pr.number);
    for (const job of Object.values(s.jobs)) {
      if (job.prNumber === pr.number) {
        job.status = 'done';
        job.resumeAction = undefined;
        job.updatedAt = new Date().toISOString();
      }
    }
    return undefined;
  });
  const receiptOk = await syncDeployReceipt(ctx, issueNumber, sha, true);
  if (!receiptOk && issueNumber !== undefined) {
    await ctx.state.update((s) => {
      for (const job of Object.values(s.jobs)) {
        if (job.prNumber === pr.number && job.status === 'done') {
          job.resumeAction = 'sync-deploy-receipt';
        }
      }
      return undefined;
    });
    ctx.logger.warn(`部署成功（PR #${pr.number}）但 GitHub 回执同步失败，待下轮补同步`);
  }
  ctx.logger.info(`部署成功（PR #${pr.number} → ${sha}）`);
}

function publicEntryNotice(publicUrl?: string): string {
  if (!publicUrl) return '';
  return `公网入口（Vercel独立发布）：${publicUrl}`;
}

async function syncDeployReceipt(
  ctx: DeployDeps,
  issueNumber: number | undefined,
  sha: string,
  includeComment: boolean,
): Promise<boolean> {
  if (issueNumber === undefined) return true;
  const marker = `已部署：\`${sha}\``;
  const results: boolean[] = [];
  const issue = await findManagedIssue(ctx, issueNumber);
  if (issue) {
    // 远端可见时做幂等同步：只修缺失/过期的部分，避免重复回执覆盖真实状态。
    const staleStatus = issue.labels.filter((l) => STATUS_LABELS.includes(l) && l !== 'status:done');
    if (staleStatus.length > 0) {
      results.push(await tryGithub(() => ctx.github.removeLabels(issueNumber, staleStatus)));
    }
    if (!issue.labels.includes('pi-task')) {
      results.push(await tryGithub(() => ctx.github.addLabels(issueNumber, ['pi-task'])));
    }
    if (!issue.labels.includes('status:done')) {
      results.push(await tryGithub(() => ctx.github.addLabels(issueNumber, ['status:done'])));
    }
    if (issue.state !== 'closed') {
      results.push(await tryGithub(() => ctx.github.closeIssue(issueNumber)));
    }
  } else {
    results.push(await tryGithub(() => ctx.github.removeLabels(issueNumber, STATUS_LABELS)));
    results.push(await tryGithub(() => ctx.github.addLabels(issueNumber, ['pi-task', 'status:done'])));
    results.push(await tryGithub(() => ctx.github.closeIssue(issueNumber)));
  }
  if (includeComment) {
    const alreadyCommented = await hasDeployComment(ctx, issueNumber, marker);
    if (!alreadyCommented) {
      const publicNotice = publicEntryNotice(ctx.publicUrl);
      const receipt = [
        `🚀 本地已部署：\`${sha}\`，健康检查通过，本地预览 http://127.0.0.1:5173`,
        publicNotice,
      ].filter(Boolean).join('\n\n');
      results.push(await tryGithub(() => ctx.github.comment(issueNumber, receipt)));
    }
  }
  return results.every(Boolean);
}

async function findManagedIssue(ctx: DeployDeps, issueNumber: number): Promise<ManagedIssue | null> {
  try {
    const issues = await ctx.github.listIssues();
    return issues.find((i) => i.number === issueNumber) ?? null;
  } catch {
    return null;
  }
}

async function hasDeployComment(ctx: DeployDeps, issueNumber: number, marker: string): Promise<boolean> {
  try {
    const comments = await ctx.github.listIssueComments(issueNumber);
    return comments.some((c) => c.body.includes(marker));
  } catch {
    return false;
  }
}

async function syncPendingReceipts(ctx: DeployDeps, merged: ManagedPR[]): Promise<void> {
  const state = ctx.state.snapshot();
  const pending = Object.values(state.jobs).filter(
    (job) => job.resumeAction === 'sync-deploy-receipt' && job.prNumber !== undefined,
  );
  for (const job of pending) {
    const pr = merged.find((p) => p.number === job.prNumber);
    if (!pr) continue;
    const requirement = state.requirements[job.reqId];
    const stillCurrent =
      requirement !== undefined &&
      requirement.issueNumber === job.issueNumber &&
      requirement.specHash === job.specHash &&
      requirement.sourceMainSha === job.sourceMainSha;
    if (!stillCurrent) {
      await ctx.state.update((s) => {
        const target = s.jobs[job.jobId];
        if (target && target.resumeAction === 'sync-deploy-receipt') target.resumeAction = undefined;
        return undefined;
      });
      ctx.logger.warn(`跳过过期部署回执（PR #${pr.number}）：需求版本已变化，不再用旧回执改任务状态`);
      continue;
    }
    const sha = pr.mergeCommitSha ?? state.deploy.activeSha ?? '';
    if (!sha) continue;
    const ok = await syncDeployReceipt(ctx, job.issueNumber, sha, true);
    if (!ok) continue;
    await ctx.state.update((s) => {
      const target = s.jobs[job.jobId];
      if (target) target.resumeAction = undefined;
      return undefined;
    });
    ctx.logger.info(`补同步部署回执完成（PR #${pr.number}）`);
  }
}

export async function deployMergedPR(
  ctx: DeployDeps,
  pr: ManagedPR,
  issueNumber: number | undefined,
): Promise<DeployResult> {
  // GitClient.fetch 的第二参数为目标分支（内部固定 origin，更新 origin/<branch>）；
  // 自定义主分支时也必须拉取正确的 origin/<branch>。
  await ctx.git.fetch(ctx.repoDir, ctx.mainBranch ?? 'main');
  if (!pr.mergeCommitSha) {
    const detail = '缺少 merge commit SHA，不猜测部署目标';
    await markDeployFailed(ctx, pr, issueNumber, detail);
    return { status: 'failed', prNumber: pr.number, issueNumber, error: detail };
  }
  const sha = pr.mergeCommitSha;

  const built = await ctx.build(sha);
  if (!built.ok) {
    await markDeployFailed(ctx, pr, issueNumber, built.detail);
    return { status: 'failed', sha, prNumber: pr.number, issueNumber, error: built.detail };
  }

  const healthy = await ctx.healthCheck(sha);
  if (!healthy) {
    await markDeployFailed(ctx, pr, issueNumber, '健康检查失败');
    return { status: 'failed', sha, prNumber: pr.number, issueNumber, error: '健康检查失败' };
  }

  await ctx.switchPreview(sha, join(ctx.runDir, 'releases', sha));
  await markDeployed(ctx, pr, issueNumber, sha);
  const publicNotice = publicEntryNotice(ctx.publicUrl);
  await ctx.notify?.(
    [`🚀 本地已部署：${sha}（健康检查通过）`, publicNotice].filter(Boolean).join('\n\n'),
  );
  return { status: 'deployed', sha, prNumber: pr.number, issueNumber };
}

export async function deployOnce(ctx: DeployDeps): Promise<DeployResult> {
  const state = ctx.state.snapshot();
  const deployed = new Set(state.deploy.deployedPRs ?? []);
  const failed = new Set(state.deploy.deployFailedPRs ?? []);
  const merged = await discoverMergedCodePRs(ctx);
  const pending = merged
    .filter((p) => !deployed.has(p.number))
    .filter((p) => {
      if (!failed.has(p.number)) return true;
      ctx.logger.warn(`跳过部署失败的 PR #${p.number}，等待“重试”显式恢复`);
      return false;
    })
    .filter((p) => {
      if (isCurrentDelivery(ctx, p)) return true;
      ctx.logger.warn(`跳过非当前需求版本的 PR #${p.number}，不部署不关单`);
      return false;
    })
    .sort((a, b) => mergeTime(a) - mergeTime(b));

  let last: DeployResult = { status: 'nothing' };
  for (const pr of pending) {
    last = await deployMergedPR(ctx, pr, issueNumberForPR(ctx, pr));
  }
  await syncPendingReceipts(ctx, merged);
  return last;
}

export async function retryDeployForIssue(
  ctx: DeployDeps,
  issueNumber: number,
  prNumber?: number,
): Promise<DeployResult> {
  const state = ctx.state.snapshot();
  const reqId = Object.entries(state.requirements).find(([, r]) => r.issueNumber === issueNumber)?.[0];
  const merged = await discoverMergedCodePRs(ctx);
  const pr = prNumber !== undefined
    ? merged.find((p) => p.number === prNumber)
    : merged.find((p) => p.meta?.reqId === reqId);
  if (!pr) return { status: 'nothing', issueNumber };
  if (typeof pr.meta?.reqId === 'string' && pr.meta.reqId !== reqId) {
    return { status: 'nothing', issueNumber, error: 'PR 与该任务的需求不匹配' };
  }
  if (!isCurrentDelivery(ctx, pr)) {
    ctx.logger.warn(`重试跳过 PR #${pr.number}：对应需求版本已过期`);
    return { status: 'nothing', issueNumber, error: '该 PR 对应的需求版本已过期，不再部署' };
  }
  return deployMergedPR(ctx, pr, issueNumber);
}

async function tolerant(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch {
    // GitHub state updates are best-effort here; local state carries the durable truth.
  }
}
