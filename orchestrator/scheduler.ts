import {
  buildDeterministicDispatchTask,
  dispatchLabel,
  findUnpublishedRevision,
  freezeDispatchRevision,
  nextDispatchRevision,
  validateDispatchTask,
} from './dispatch-task.ts';
import {
  PANEL_REQ_ID,
  PANEL_SPEC_PATH,
  isValidPanelBinding,
  sameRepositoryId,
  type PanelBinding,
} from './delivery-profile.ts';
import type { GithubClient } from './github.ts';
import type { GitClient } from './git.ts';
import type { Logger } from './log.ts';
import { selectPanelIssue } from './panel-registration.ts';
import {
  buildDispatchIssueBody,
  buildDispatchRevisionComment,
  extractHumanArea,
  HUMAN_AREA_BEGIN,
  HUMAN_AREA_END,
  preserveHumanArea,
  planReconciliation,
  type ReconcileOp,
} from './reconciler.ts';
import {
  hasActiveRetryBaseline,
  resumeRetryBaselines,
  type PublishDispatchRevisionInput,
  type RetryBaselineDeps,
} from './retry-baseline.ts';
import { diffSpecs, parseSpecs } from './specs.ts';
import type { StateStore } from './state.ts';
import type { DispatchRevision, DispatchTask, ManagedPR, Spec } from './types.ts';

export const STATUS_LABELS = [
  'status:todo',
  'status:processing',
  'status:in-review',
  'status:done',
  'status:failed',
  'status:satisfied',
];

export interface ReconcileContext {
  repoDir: string;
  git: GitClient;
  github: GithubClient;
  state: StateStore;
  logger: Logger;
  mainBranch?: string;
  retryBaselines?: RetryBaselineDeps;
  /** 仅在显式受信配置下启用 REQ-PANEL-01；未配置时不得回退旧版面板处理。 */
  panelBinding?: PanelBinding;
  /** 派工门禁依赖；未配置时走旧版 Issue 对账，配置后门禁需求走冻结发布。 */
  dispatch?: DispatchReconcileDeps;
}

/**
 * 派工对账的运行时依赖。控制器只负责冻结、发布与记录版本，不决定谁来开工；
 * 开工许可由 runtime 用标签事件与持久化历史另行核对。
 */
export interface DispatchReconcileDeps {
  /** 默认仅 REQ-CNT-01 走门禁，其余需求保持旧版兼容。 */
  isGated(reqId: string): boolean;
  /** 由仓库策略决定本需求的允许写入范围，注入冻结任务。 */
  allowedPaths(spec: Spec): string[];
  /** 可选：由仓库策略解析前置依赖。 */
  dependsOn?(spec: Spec): string[];
  /**
   * 可选：用真实 Planner 派生结构化任务；缺省或返回 null/无效时回退确定性最小任务。
   * runtime 用 deriveDispatchTask 闭包注入 Planner 依赖。
   */
  deriveTask?(
    spec: Spec,
    options: { allowedPaths: string[]; dependsOn: string[] },
  ): Promise<DispatchTask | null>;
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

function panelBindingForContext(ctx: ReconcileContext): PanelBinding | undefined {
  if (!ctx.panelBinding) return undefined;
  if (!isValidPanelBinding(ctx.panelBinding)) {
    ctx.logger.warn('面板绑定形态非法，本轮忽略面板需求；其他需求继续对账');
    return undefined;
  }
  return ctx.panelBinding;
}

function splitPanelSnapshot(
  files: Record<string, string>,
  panelEnabled: boolean,
): { direct: Record<string, string>; panelText?: string } {
  const direct: Record<string, string> = {};
  for (const [path, content] of Object.entries(files)) {
    if (path !== PANEL_SPEC_PATH) direct[path] = content;
  }
  return panelEnabled && files[PANEL_SPEC_PATH] !== undefined
    ? { direct, panelText: files[PANEL_SPEC_PATH] }
    : { direct };
}

function parsePanelText(
  ctx: ReconcileContext,
  panelText: string | undefined,
): Spec | undefined {
  if (panelText === undefined) return undefined;
  const parsed = parseSpecs({ [PANEL_SPEC_PATH]: panelText });
  if (parsed.errors.length > 0) {
    ctx.logger.warn(
      `面板需求解析失败，仅跳过面板: ${parsed.errors.map((error) => error.reason).join('; ')}`,
    );
    return undefined;
  }
  const matches = parsed.specs.filter((spec) => spec.id === PANEL_REQ_ID);
  if (matches.length !== 1) {
    ctx.logger.warn(`面板暂存文件必须恰含一个 ${PANEL_REQ_ID}，仅跳过面板`);
    return undefined;
  }
  return matches[0];
}

async function planPanelOperation(
  ctx: ReconcileContext,
  binding: PanelBinding,
  targetMainSha: string,
  spec: Spec,
  issues: Awaited<ReturnType<GithubClient['listIssues']>>,
): Promise<ReconcileOp | null> {
  try {
    if (!ctx.dispatch) {
      throw new Error('未配置统一派工门禁，不能登记或发布面板需求');
    }
    const mainBranch = ctx.mainBranch ?? 'main';
    if (mainBranch !== binding.mainBranch) {
      throw new Error(`当前主线 ${mainBranch} 与面板绑定 ${binding.mainBranch} 不一致`);
    }
    const state = ctx.state.snapshot();
    if (state.repo !== binding.repo) {
      throw new Error(`本地状态仓库 ${state.repo ?? '未设置'} 与面板绑定 ${binding.repo} 不一致`);
    }
    const repoId = await ctx.github.getDispatchRepositoryId();
    if (!sameRepositoryId(repoId, binding.repositoryId)) {
      throw new Error(`远端仓库 ID ${repoId} 与面板绑定 ${binding.repositoryId} 不一致`);
    }
    const selection = selectPanelIssue({ binding, issues, state });
    if (!selection.ok) throw new Error(selection.reason);
    // 来源 SHA/哈希只用于证明首次接续对象的可信性。登记后允许同一 Issue
    // 随主线改版，并由既有派工版本与第一父链变更检查约束。
    if (!selection.registered) {
      if (!(await ctx.git.isAncestor(ctx.repoDir, binding.confirmedMainSha, targetMainSha))) {
        throw new Error(`确认锚点 ${binding.confirmedMainSha} 不是当前主线的祖先`);
      }
      const anchorFiles = await ctx.git.readSpecSnapshot(ctx.repoDir, binding.confirmedMainSha);
      const anchorText = anchorFiles[PANEL_SPEC_PATH];
      if (anchorText === undefined) {
        throw new Error(`确认锚点未提供受信路径 ${PANEL_SPEC_PATH}`);
      }
      const anchorSpec = parsePanelText(ctx, anchorText);
      if (!anchorSpec || anchorSpec.hash !== binding.specHash) {
        throw new Error('确认锚点的面板需求块哈希与受信绑定不一致');
      }
    }
    return {
      kind: 'panel',
      reqId: PANEL_REQ_ID,
      issueNumber: selection.issue.number,
      spec,
      title: selection.issue.title,
      operationKey: `${spec.hash}:panel:${binding.issueNumber}`,
    };
  } catch (error) {
    ctx.logger.warn(
      `面板需求保持待核实，不影响其他需求: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

export async function planForMain(ctx: ReconcileContext): Promise<ReconcileSummary | null> {
  const mainBranch = ctx.mainBranch ?? 'main';
  const panelBinding = panelBindingForContext(ctx);
  const panelEnabled = panelBinding !== undefined;
  await ctx.git.fetch(ctx.repoDir, mainBranch);
  const targetMainSha = await ctx.git.revParse(ctx.repoDir, `origin/${mainBranch}`);
  const targetFiles = await ctx.git.readSpecSnapshot(ctx.repoDir, targetMainSha);
  const targetSnapshot = splitPanelSnapshot(targetFiles, panelEnabled);
  const parsed = parseSpecs(targetSnapshot.direct);
  if (parsed.errors.length > 0) {
    ctx.logger.warn(`需求解析失败，本轮不执行对账: ${parsed.errors.map((e) => e.reason).join('; ')}`);
    return null;
  }
  if (parsed.specs.some((spec) => spec.id === PANEL_REQ_ID)) {
    ctx.logger.warn(`${PANEL_REQ_ID} 出现在未受信路径，仅忽略该面板需求`);
  }
  const directSpecs = parsed.specs.filter((spec) => spec.id !== PANEL_REQ_ID);
  const panelSpec = parsePanelText(ctx, targetSnapshot.panelText);
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
    const baselineSnapshot = splitPanelSnapshot(baselineFiles, panelEnabled);
    const baselineParsed = parseSpecs(baselineSnapshot.direct);
    if (baselineParsed.errors.length > 0) {
      ctx.logger.warn(`游标基线解析失败，跳过本轮对账: ${baselineParsed.errors.map((e) => e.reason).join('; ')}`);
      return null;
    }
    previous = baselineParsed.specs.filter((spec) => spec.id !== PANEL_REQ_ID);
  }
  const diff = diffSpecs(previous, directSpecs);
  const issues = await ctx.github.listIssues();
  const prs = await ctx.github.listPRs();
  const ops = planReconciliation(diff, issues, targetMainSha, prs);
  let panelEligible = false;
  if (panelBinding && panelSpec) {
    const panelOp = await planPanelOperation(ctx, panelBinding, targetMainSha, panelSpec, issues);
    if (panelOp) {
      ops.push(panelOp);
      panelEligible = true;
    }
  }
  // 面板只有在本轮唯一核对通过并形成独立操作时才进入 Worker 候选。
  // 歧义、错卡或错来源不得借旧 requirement/rN 继续走普通派工。
  const specs = panelEligible && panelSpec ? [...directSpecs, panelSpec] : directSpecs;
  return { targetMainSha, ops, specs };
}

/** 单个旧版对账操作的落地；失败直接抛出，由外层统一决定是否推进游标。 */
async function applyLegacyOperation(
  ctx: ReconcileContext,
  op: ReconcileOp,
  targetMainSha: string,
): Promise<void> {
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
    return;
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
    return;
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
    return;
  }

  if (op.kind === 'close-pr' && op.prNumber) {
    const reason = op.reason;
    if (reason) await tolerant(() => ctx.github.comment(op.prNumber!, reason));
    await ctx.github.closePR(op.prNumber!);
    ctx.logger.info(`关闭过期 PR #${op.prNumber}（${op.reqId}）`);
    return;
  }

  const backfill = op.backfill;
  if (op.kind === 'noop' && op.issueNumber && backfill) {
    if (hasActiveRetryBaseline(ctx.state.snapshot(), op.reqId)) {
      ctx.logger.warn(`需求 ${op.reqId} 有未决显式重试准备，跳过普通 noop 回填`);
      return;
    }
    await ctx.state.update((s) => {
      s.requirements[op.reqId] = {
        issueNumber: op.issueNumber!,
        ...backfill,
      };
      return undefined;
    });
    ctx.logger.info(`回填任务 #${op.issueNumber}（${op.reqId}）本地状态`);
    return;
  }
}

export async function applyReconciliation(
  ctx: ReconcileContext,
  ops: ReconcileOp[],
  targetMainSha: string,
): Promise<void> {
  if (ctx.dispatch) {
    await applyReconciliationWithDispatch(ctx, ops, targetMainSha, ctx.dispatch);
    return;
  }

  const blocked = ops.find(
    (op) =>
      (op.kind === 'create' || op.kind === 'update' || op.kind === 'close') &&
      hasActiveRetryBaseline(ctx.state.snapshot(), op.reqId),
  );
  if (blocked) {
    const message = `需求 ${blocked.reqId} 有未决的显式重试准备，权威对账改动不能跳过；保留游标并停止本轮后续派发`;
    ctx.logger.warn(message);
    throw new Error(message);
  }
  let failed = false;
  for (const op of ops) {
    try {
      if (op.kind === 'panel') {
        ctx.logger.warn('未配置统一派工门禁，拒绝回退旧版面板处理');
        continue;
      }
      await applyLegacyOperation(ctx, op, targetMainSha);
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

/**
 * 派工对账正式入口。与 reconcileWithPlanner 同样返回 ReconcileSummary，
 * runtime 只需把调用从 reconcileWithPlanner 切到本函数并传入 dispatch 依赖。
 */
export async function reconcileWithDispatch(
  ctx: ReconcileContext,
  deps: DispatchReconcileDeps,
): Promise<ReconcileSummary | null> {
  const summary = await planForMain(ctx);
  if (!summary) return null;
  const panelEligible = await applyReconciliationWithDispatch(
    ctx,
    summary.ops,
    summary.targetMainSha,
    deps,
  );
  if (!panelEligible) {
    summary.specs = summary.specs.filter((spec) => spec.id !== PANEL_REQ_ID);
  }
  return summary;
}

/**
 * 供 retry-baseline 注入的唯一冻结发布入口。复用 applyGatedDispatch 的同一套
 * 冻结/落盘/发布流程，返回已带 publishedAt / publicationCommentId 且已落盘的 revision。
 */
export async function publishDispatchRevision(
  ctx: ReconcileContext,
  input: PublishDispatchRevisionInput,
): Promise<DispatchRevision> {
  const deps = ctx.dispatch;
  if (!deps) {
    throw new Error('未配置派工门禁依赖，无法发布派工版本');
  }
  // 发布入口独立核对受管仓库数字 ID，防止把冻结任务绑到错误的仓库；
  // runtime 传入的 repoId 必须与当前 GitHub 适配器所绑定的仓库一致。
  const actualRepoId = await ctx.github.getDispatchRepositoryId();
  if (actualRepoId !== input.repoId) {
    throw new Error(
      `派工仓库 ID 与适配器当前仓库不一致（${input.repoId} != ${actualRepoId}），保持待排期`,
    );
  }
  return applyGatedDispatch(ctx, deps, input.spec, input.issueNumber, input.targetMainSha, input.repoId);
}

/** 逐 op 落地派工对账：门禁需求冻结发布，非门禁需求沿用旧逻辑，close 删除派工历史。 */
async function applyReconciliationWithDispatch(
  ctx: ReconcileContext,
  ops: ReconcileOp[],
  targetMainSha: string,
  deps: DispatchReconcileDeps,
): Promise<boolean> {
  const blocked = ops.find(
    (op) =>
      (op.kind === 'create' || op.kind === 'update' || op.kind === 'close') &&
      hasActiveRetryBaseline(ctx.state.snapshot(), op.reqId),
  );
  if (blocked) {
    const message = `需求 ${blocked.reqId} 有未决的显式重试准备，权威对账改动不能跳过；保留游标并停止本轮后续派发`;
    ctx.logger.warn(message);
    throw new Error(message);
  }

  const state = ctx.state.snapshot();
  const cursor = state.cursorMainSha;
  const blockChangedInWindow = cursor && cursor !== targetMainSha
    ? await specBlockChangedInWindow(ctx, cursor, targetMainSha)
    : async () => false;

  const needsRepoId = ops.some(
    (op) => op.kind === 'panel' || isGatedDispatchOp(op, deps),
  );
  const repoId = needsRepoId ? await ctx.github.getDispatchRepositoryId() : undefined;

  let failed = false;
  let panelEligible = true;
  for (const op of ops) {
    try {
      if (op.kind === 'panel') {
        panelEligible = false;
        if (hasActiveRetryBaseline(ctx.state.snapshot(), op.reqId)) {
          ctx.logger.warn(`需求 ${op.reqId} 有未决显式重试准备，暂不接续面板卡`);
          continue;
        }
        await applyPanelRequirement(
          ctx,
          deps,
          op,
          targetMainSha,
          repoId!,
          blockChangedInWindow,
        );
        panelEligible = true;
        continue;
      }
      if (op.kind === 'close' && deps.isGated(op.reqId)) {
        await applyLegacyOperation(ctx, op, targetMainSha);
        ctx.logger.info(`关闭任务并保留派工历史 #${op.issueNumber ?? '?'}（${op.reqId}）`);
        continue;
      }
      if (isGatedDispatchOp(op, deps) && op.spec) {
        await applyGatedRequirement(ctx, deps, op, targetMainSha, repoId!, blockChangedInWindow);
        continue;
      }
      await applyLegacyOperation(ctx, op, targetMainSha);
    } catch (error) {
      if (op.kind === 'panel') {
        ctx.logger.warn(
          `面板对账失败，仅暂停面板并保留后续轮询修复: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
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
  return panelEligible;
}

function isGatedDispatchOp(op: ReconcileOp, deps: DispatchReconcileDeps): boolean {
  return (
    (op.kind === 'create' || op.kind === 'update' || op.kind === 'noop') &&
    deps.isGated(op.reqId) &&
    op.spec !== undefined
  );
}

/**
 * 返回一个按需求块判断变化的函数：在游标到目标的 first-parent 链上逐提交对比目标需求块的哈希，
 * 检测离线 A→B→A 等同哈希回退；git 读取或解析失败直接抛出（fail closed），阻止游标推进。
 */
async function specBlockChangedInWindow(
  ctx: ReconcileContext,
  from: string,
  to: string,
): Promise<(spec: Spec) => Promise<boolean>> {
  const commits = await ctx.git.firstParentCommits(ctx.repoDir, from, to);
  return async (spec: Spec): Promise<boolean> => {
    let previous = await specBlockHashAt(ctx, spec.path, spec.id, from);
    for (const sha of commits) {
      const current = await specBlockHashAt(ctx, spec.path, spec.id, sha);
      if (current !== previous) return true;
      previous = current;
    }
    return false;
  };
}

/** 读取某个提交下单个需求块的哈希；块缺失返回空串，解析失败抛出。 */
async function specBlockHashAt(
  ctx: ReconcileContext,
  path: string,
  id: string,
  sha: string,
): Promise<string> {
  // 明确缺失的路径应表达为空需求块；Git 执行或快照读取故障仍由 GitClient 抛出。
  const snapshot = await ctx.git.readSpecSnapshot(ctx.repoDir, sha);
  const content = snapshot[path];
  if (content === undefined) return '';
  const parsed = parseSpecs({ [path]: content });
  if (parsed.errors.length > 0) {
    throw new Error(`需求块解析失败（${id} @ ${sha}），拒绝推进对账`);
  }
  return parsed.specs.find((candidate) => candidate.id === id)?.hash ?? '';
}

/**
 * 面板独立对账：只接续受信编号上的既有卡，并复用统一冻结/发布。
 * 已完成同版发布时只修复本地绑定；尚未发布、改版或离线 A→B→A 时走原门禁。
 */
async function applyPanelRequirement(
  ctx: ReconcileContext,
  deps: DispatchReconcileDeps,
  op: ReconcileOp,
  _targetMainSha: string,
  repoId: string,
  blockChangedInWindow: (spec: Spec) => Promise<boolean>,
): Promise<void> {
  const binding = ctx.panelBinding;
  if (!binding || !isValidPanelBinding(binding)) {
    throw new Error('面板绑定缺失或非法，拒绝处理面板需求');
  }
  if ((ctx.mainBranch ?? 'main') !== binding.mainBranch) {
    throw new Error('当前主线与面板绑定不一致，拒绝处理面板需求');
  }
  const state = ctx.state.snapshot();
  if (state.repo !== binding.repo) {
    throw new Error('当前状态仓库与面板绑定不一致，拒绝处理面板需求');
  }
  if (!sameRepositoryId(repoId, binding.repositoryId)) {
    throw new Error('当前仓库数字 ID 与面板绑定不一致，拒绝处理面板需求');
  }
  if (
    op.reqId !== PANEL_REQ_ID
    || op.issueNumber !== binding.issueNumber
    || !op.spec
    || op.spec.id !== PANEL_REQ_ID
    || op.spec.path !== PANEL_SPEC_PATH
  ) {
    throw new Error('面板对账操作身份不完整或越出受信绑定');
  }

  const currentIssue = await ctx.github.getDispatchIssue(binding.issueNumber);
  const currentSelection = selectPanelIssue({
    binding,
    issues: [currentIssue],
    state,
  });
  if (!currentSelection.ok) throw new Error(currentSelection.reason);

  const latest = latestRevisionFor(ctx, PANEL_REQ_ID);
  if (latest && latest.issueNumber !== binding.issueNumber) {
    throw new Error(`面板历史绑定 #${latest.issueNumber}，与受信卡 #${binding.issueNumber} 不一致`);
  }
  const sameCurrentVersion = Boolean(
    latest
    && latest.specHash === op.spec.hash
    && latest.specPath === PANEL_SPEC_PATH,
  );
  const changedInWindow = sameCurrentVersion
    ? await blockChangedInWindow(op.spec)
    : false;

  if (
    latest
    && sameCurrentVersion
    && !changedInWindow
    && latest.publishedAt !== undefined
    && latest.publicationCommentId !== undefined
  ) {
    const requirement = state.requirements[PANEL_REQ_ID];
    if (
      !requirement
      || requirement.issueNumber !== binding.issueNumber
      || requirement.specHash !== latest.specHash
      || requirement.specPath !== latest.specPath
      || requirement.sourceMainSha !== latest.sourceMainSha
    ) {
      await persistRequirement(
        ctx,
        PANEL_REQ_ID,
        binding.issueNumber,
        op.spec,
        latest.sourceMainSha,
      );
    }
    return;
  }

  await applyGatedRequirement(
    ctx,
    deps,
    { ...op, kind: 'update' },
    _targetMainSha,
    repoId,
    blockChangedInWindow,
  );
}

/** 门禁需求的 create/update/noop 落地；create 先建 Issue，update 先修复状态，再冻结发布。 */
async function applyGatedRequirement(
  ctx: ReconcileContext,
  deps: DispatchReconcileDeps,
  op: ReconcileOp,
  targetMainSha: string,
  repoId: string,
  blockChangedInWindow: (spec: Spec) => Promise<boolean>,
): Promise<void> {
  const spec = op.spec!;

  if (op.kind === 'create') {
    // 先按仓库与需求 ID 建单拿到编号，再冻结本版任务并发布；发布失败时下轮按 update 修复。
    const number = await ctx.github.createIssue(op.title!, op.issueBody!, op.labels ?? []);
    await applyGatedDispatch(ctx, deps, spec, number, targetMainSha, repoId);
    await persistRequirement(ctx, op.reqId, number, spec, targetMainSha);
    ctx.logger.info(`创建并发布任务 #${number}（${op.reqId}）`);
    return;
  }

  if (op.kind === 'update' && op.issueNumber) {
    const currentIssue = await ctx.github.getDispatchIssue(op.issueNumber);
    if (currentIssue.state === 'closed') {
      if (!(await canReopenClosedIssue(ctx, op))) {
        throw new Error(`需求 ${op.reqId} 的 Issue #${op.issueNumber} 已关闭且关闭来源不可证，保持待核实`);
      }
      await ctx.github.reopenIssue(op.issueNumber);
    }
    await ctx.github.removeLabels(op.issueNumber, STATUS_LABELS);
    await ctx.github.addLabels(op.issueNumber, ['pi-task']);
    await applyGatedDispatch(ctx, deps, spec, op.issueNumber, targetMainSha, repoId);
    await persistRequirement(ctx, op.reqId, op.issueNumber, spec, targetMainSha);
    ctx.logger.info(`更新并发布任务 #${op.issueNumber}（${op.reqId}）`);
    return;
  }

  if (op.kind === 'noop' && op.issueNumber) {
    const latest = latestRevisionFor(ctx, op.reqId);
    const unchangedAndCurrent = latest
      && latest.specHash === spec.hash
      && !(await blockChangedInWindow(spec));
    if (unchangedAndCurrent) {
      // 无关主线提交不升版：仅补齐本地 requirement 绑定，保留冻结来源与历史。
      await applyLegacyOperation(ctx, op, targetMainSha);
      return;
    }
    // 旧库迁移或离线 A→B→A：分配新版本并重新冻结发布。
    await applyGatedDispatch(ctx, deps, spec, op.issueNumber, targetMainSha, repoId);
    await persistRequirement(ctx, op.reqId, op.issueNumber, spec, targetMainSha);
    ctx.logger.info(`回填并发布任务 #${op.issueNumber}（${op.reqId}）`);
    return;
  }

  await applyLegacyOperation(ctx, op, targetMainSha);
}

function latestRevisionFor(
  ctx: ReconcileContext,
  reqId: string,
): DispatchRevision | undefined {
  const list = ctx.state.snapshot().dispatchRevisions?.[reqId] ?? [];
  return list.length > 0 ? list[list.length - 1] : undefined;
}

async function persistRequirement(
  ctx: ReconcileContext,
  reqId: string,
  issueNumber: number,
  spec: Spec,
  targetMainSha: string,
): Promise<void> {
  await ctx.state.update((s) => {
    s.requirements[reqId] = {
      issueNumber,
      specHash: spec.hash,
      specPath: spec.path,
      sourceMainSha: targetMainSha,
    };
    return undefined;
  });
}

/** 与 dispatchCommentMarker 一致的版本评论 marker 形态，用于远端高水位回读。 */
const DISPATCH_MARKER_RE = /^spec-loop:dispatch:([^:\s]+):r(\d+)$/;

/** 开工标签形态；控制器只摘除过期版本标签，不得自行贴当前版本标签。 */
const DISPATCH_LABEL_RE = /^可开工\/r(\d+)$/;

/** 从 Issue 当前标签中挑出已被新版取代的开工标签（rN != currentRevision）。 */
function staleDispatchLabels(labels: string[], currentRevision: number): string[] {
  return labels.filter((label) => {
    const match = DISPATCH_LABEL_RE.exec(label);
    if (!match) return false;
    const revision = Number.parseInt(match[1], 10);
    return Number.isSafeInteger(revision) && revision !== currentRevision;
  });
}

/**
 * 从 Issue 既有评论回读本需求已使用的 rN 集合（仅控制器自有评论）。
 * 本地 receipt 遗失时据此恢复高水位；读取失败时抛错（fail closed）。
 * marker 是发布评论中的独占行，只按精确行匹配，不信任正文内任意子串。
 */
async function remoteDispatchRevisions(
  ctx: ReconcileContext,
  issueNumber: number,
  reqId: string,
): Promise<Set<number>> {
  let comments: Array<{ id: number; body: string }>;
  try {
    comments = await ctx.github.listTrustedDispatchComments(issueNumber);
  } catch (error) {
    throw new Error(
      `读取 Issue #${issueNumber} 评论失败，无法确认派工版本高水位: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const revisions = new Set<number>();
  for (const comment of comments) {
    for (const rawLine of comment.body.split(/\r?\n/)) {
      const line = rawLine.trim();
      const match = DISPATCH_MARKER_RE.exec(line);
      if (!match || match[1] !== reqId) continue;
      const revision = Number.parseInt(match[2], 10);
      if (Number.isSafeInteger(revision) && revision > 0) revisions.add(revision);
    }
  }
  return revisions;
}

/**
 * 本地历史 + 远端可信 marker 高水位取较大者，得到下一个不会撞号的版本号。
 * 远端已用号超前本地时必须能证明 (localMax, remoteHigh] 连续存在；有缺口
 * 无法排除撞号或旧标复用，直接抛错停止待核实。
 */
async function nextDispatchRevisionWithRemote(
  ctx: ReconcileContext,
  issueNumber: number,
  reqId: string,
): Promise<number> {
  const snapshot = ctx.state.snapshot();
  const localNext = nextDispatchRevision(snapshot, reqId);
  const localMax = localNext - 1;
  const remote = await remoteDispatchRevisions(ctx, issueNumber, reqId);
  let remoteHigh = 0;
  for (const revision of remote) {
    if (revision > remoteHigh) remoteHigh = revision;
  }
  if (remoteHigh <= localMax) return localNext;
  for (let revision = localMax + 1; revision <= remoteHigh; revision += 1) {
    if (!remote.has(revision)) {
      throw new Error(
        `需求 ${reqId} 远端已使用到 r${remoteHigh}，但缺少 r${revision} 的连续版本证据，停止待核实`,
      );
    }
  }
  return remoteHigh + 1;
}

/**
 * 冻结并发布一个派工版本。顺序保证：
 * 1. 优先复用同 (specHash, sourceMainSha) 的未发布冻结记录，避免重试撞号或重复调用 Planner；
 * 2. 先落盘冻结记录（publishedAt 缺失），再产生外部效果；
 * 3. 外部写回读后补记 publishedAt 与评论 ID。
 * 远端成功而本地落盘失败时，下轮仍按同一冻结记录复用同版任务。
 */
async function applyGatedDispatch(
  ctx: ReconcileContext,
  deps: DispatchReconcileDeps,
  spec: Spec,
  issueNumber: number,
  targetMainSha: string,
  repoId: string,
): Promise<DispatchRevision> {
  const snapshot = ctx.state.snapshot();
  const repo = snapshot.repo ?? '';
  let revision = findUnpublishedRevision(snapshot, spec.id, spec.hash, targetMainSha);
  if (revision && revision.repoId !== repoId) {
    throw new Error(`需求 ${spec.id} 的未发布冻结记录仓库 ID 与当前不一致，保持待排期`);
  }

  if (!revision) {
    const allowedPaths = deps.allowedPaths(spec);
    const dependsOn = deps.dependsOn ? deps.dependsOn(spec) : [];
    let task = deps.deriveTask
      ? await deps.deriveTask(spec, { allowedPaths, dependsOn })
      : buildDeterministicDispatchTask(spec, allowedPaths, dependsOn);
    if (!task) {
      throw new Error(`需求 ${spec.id} 无法生成派工任务（缺少验收项），保持待排期`);
    }
    if (!validateDispatchTask(task)) {
      throw new Error(`需求 ${spec.id} 派工任务未通过校验，保持待排期`);
    }
    const revisionNumber = await nextDispatchRevisionWithRemote(ctx, issueNumber, spec.id);
    revision = freezeDispatchRevision({
      reqId: spec.id,
      repoId,
      revision: revisionNumber,
      issueNumber,
      spec,
      sourceMainSha: targetMainSha,
      task,
    });
    // 先落盘冻结记录（尚未发布），再产生外部效果。
    await ctx.state.update((s) => {
      s.dispatchRevisions ??= {};
      const list = s.dispatchRevisions[spec.id] ?? [];
      list.push(revision!);
      list.sort((a, b) => a.revision - b.revision);
      s.dispatchRevisions[spec.id] = list;
      clearSupersededGrants(s, spec.id, revision!.revision);
      return undefined;
    });
  }

  const currentIssue = await ctx.github.getDispatchIssue(issueNumber);
  const generatedBody = buildDispatchIssueBody(spec, targetMainSha, revision);
  const nextBody = spec.id === PANEL_REQ_ID
    ? preservePanelHandover(currentIssue.body, generatedBody)
    : preserveHumanArea(currentIssue.body, generatedBody);
  await ctx.github.updateIssueBody(issueNumber, nextBody);
  await ctx.github.ensureDispatchLabel(dispatchLabel(revision.revision));
  const staleLabels = staleDispatchLabels(currentIssue.labels, revision.revision);
  if (staleLabels.length > 0) {
    await ctx.github.removeLabels(issueNumber, staleLabels);
  }
  const comment = buildDispatchRevisionComment(spec, revision, repo);
  const published = await ctx.github.ensureDispatchComment(issueNumber, comment.marker, comment.body);

  const persisted = await ctx.state.update((s) => {
    const target = s.dispatchRevisions?.[spec.id]?.find((rev) => rev.revision === revision!.revision);
    if (target) {
      target.publishedAt = published.createdAt;
      target.publicationCommentId = published.id;
    }
    return s.dispatchRevisions?.[spec.id]?.find((rev) => rev.revision === revision!.revision);
  });
  const finalRevision = persisted.result;
  if (!finalRevision || finalRevision.publishedAt === undefined || finalRevision.publicationCommentId === undefined) {
    throw new Error(`需求 ${spec.id} 发布后未能回读完整冻结记录`);
  }
  ctx.logger.info(`发布派工版本 r${revision.revision}（${spec.id}，Issue #${issueNumber}）`);
  return finalRevision;
}

/** 首次接续普通卡时把原正文完整收进人工区，后续版本继续按既有标记保留。 */
function preservePanelHandover(existingBody: string, nextBody: string): string {
  if (extractHumanArea(existingBody) !== null) {
    return preserveHumanArea(existingBody, nextBody);
  }
  const handover = existingBody.trim();
  if (!handover) return nextBody;
  const start = nextBody.indexOf(HUMAN_AREA_BEGIN);
  const end = nextBody.indexOf(HUMAN_AREA_END, start);
  if (start < 0 || end < 0) {
    throw new Error('面板派工正文缺少人工区标记，拒绝覆盖原卡');
  }
  return [
    nextBody.slice(0, start + HUMAN_AREA_BEGIN.length),
    '',
    handover,
    '',
    nextBody.slice(end),
  ].join('\n');
}

/**
 * 判断已关闭的受管 Issue 是否可以安全重开。仅接受可证明的来源：
 * 需求曾被控制器删除后恢复（本地已无 requirement 绑定但仍有历版记录），
 * 或存在已合并且已过期的受管代码 PR，其正文以 `Closes #N` 指向本卡。
 * 其余（含人工关单或原因未知）返回 false，调用方保持待核实。
 */
async function canReopenClosedIssue(
  ctx: ReconcileContext,
  op: ReconcileOp,
): Promise<boolean> {
  const state = ctx.state.snapshot();
  if (!state.requirements[op.reqId] && (state.dispatchRevisions?.[op.reqId] ?? []).length > 0) {
    return true;
  }
  const prs = await ctx.github.listPRs();
  const closes = new RegExp(`Closes\\s+#${String(op.issueNumber)}\\b`, 'i');
  return prs.some(
    (pr) =>
      pr.merged &&
      pr.meta?.reqId === op.reqId &&
      typeof pr.meta?.specHash === 'string' &&
      pr.meta.specHash !== op.spec!.hash &&
      closes.test(pr.body),
  );
}

function clearSupersededGrants(
  state: { dispatchRevisions?: Record<string, DispatchRevision[]> },
  reqId: string,
  currentRevision: number,
): void {
  const list = state.dispatchRevisions?.[reqId];
  if (!list) return;
  for (const rev of list) {
    if (rev.revision !== currentRevision && rev.grant) {
      delete rev.grant;
    }
  }
}

async function tolerant(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch {
    // Label/state transitions are best-effort; the operation itself is recorded by idempotent metadata.
  }
}
