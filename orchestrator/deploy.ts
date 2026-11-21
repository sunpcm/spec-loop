import { join } from 'node:path';
import { latestDispatchRevision } from './dispatch-task.ts';
import type { GithubClient } from './github.ts';
import type { GitClient } from './git.ts';
import type { Logger } from './log.ts';
import { STATUS_LABELS } from './scheduler.ts';
import type { StateStore } from './state.ts';
import type {
  DispatchRevision,
  JobState,
  ManagedIssue,
  ManagedPR,
  OrchestratorState,
  RequirementState,
} from './types.ts';

const SHA_RE = /^[0-9a-f]{40}$/i;
const COUNTER_REQ_ID = 'REQ-CNT-01';

interface IssueEvent {
  id: number;
  event: 'closed' | 'reopened';
  commitId?: string;
  createdAt: string;
  createdAtMs: number;
}

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

export function jobDispatchRevision(job: JobState): number | undefined {
  const value = job.dispatchRevision;
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`job ${job.jobId} 的 dispatchRevision 必须是正整数`);
  }
  return value;
}

function deliveryJobs(state: OrchestratorState, pr: ManagedPR): JobState[] {
  const jobId = typeof pr.meta?.jobId === 'string' ? pr.meta.jobId : undefined;
  if (jobId) return state.jobs[jobId] ? [state.jobs[jobId]] : [];
  const reqId = typeof pr.meta?.reqId === 'string' ? pr.meta.reqId : undefined;
  return Object.values(state.jobs).filter(
    (job) => job.prNumber === pr.number && (!reqId || job.reqId === reqId),
  );
}

function revisionMatchesRequirement(
  revision: DispatchRevision,
  reqId: string,
  requirement: RequirementState,
): boolean {
  return (
    revision.reqId === reqId &&
    revision.issueNumber === requirement.issueNumber &&
    revision.specHash === requirement.specHash &&
    revision.specPath === requirement.specPath &&
    revision.sourceMainSha === requirement.sourceMainSha
  );
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
  return deliveryMatchesCurrentState(ctx.state.snapshot(), pr);
}

export function deliveryMatchesCurrentState(
  state: OrchestratorState,
  pr: ManagedPR,
): boolean {
  const reqId = typeof pr.meta?.reqId === 'string' ? pr.meta.reqId : undefined;
  const specHash = typeof pr.meta?.specHash === 'string' ? pr.meta.specHash : undefined;
  const specPath = typeof pr.meta?.specPath === 'string' ? pr.meta.specPath : undefined;
  const sourceMainSha = typeof pr.meta?.sourceMainSha === 'string' ? pr.meta.sourceMainSha : undefined;
  if (!reqId || !specHash || !sourceMainSha) return false;
  const requirement = state.requirements[reqId];
  if (
    !requirement ||
    requirement.specHash !== specHash ||
    requirement.sourceMainSha !== sourceMainSha ||
    (specPath !== undefined && requirement.specPath !== specPath)
  ) {
    return false;
  }

  const jobId = typeof pr.meta?.jobId === 'string' ? pr.meta.jobId : undefined;
  const job = jobId ? state.jobs[jobId] : undefined;
  if (jobId && !job) return false;
  const prRevision = pr.meta?.dispatchRevision;
  let jobRevision: number | undefined;
  try {
    jobRevision = job ? jobDispatchRevision(job) : undefined;
  } catch {
    return false;
  }
  const dispatchRevision = latestDispatchRevision(state, reqId);

  // 只有 PR/job 都没有版本证据的存量交付可走旧路径；任一出现版本都
  // 必须由当前冻结记录解释，不能从 job 或 PR 反推缺失状态。
  if (!dispatchRevision) {
    const sameDeliveryJobs = Object.values(state.jobs).filter(
      (candidate) => candidate.reqId === reqId && candidate.prNumber === pr.number,
    );
    const boundJobMatches = !job || (
      job.reqId === reqId
      && job.issueNumber === requirement.issueNumber
      && job.specHash === specHash
      && job.sourceMainSha === sourceMainSha
      && job.prNumber === pr.number
    );
    return (
      prRevision === undefined
      && jobRevision === undefined
      && sameDeliveryJobs.every((candidate) => candidate.dispatchRevision === undefined)
      && boundJobMatches
    );
  }
  if (
    pr.meta?.specPath !== dispatchRevision.specPath ||
    prRevision !== dispatchRevision.revision ||
    jobRevision !== dispatchRevision.revision ||
    !revisionMatchesRequirement(dispatchRevision, reqId, requirement) ||
    !job ||
    job.reqId !== reqId ||
    job.issueNumber !== dispatchRevision.issueNumber ||
    job.specHash !== dispatchRevision.specHash ||
    job.sourceMainSha !== dispatchRevision.sourceMainSha ||
    job.prNumber !== pr.number
  ) {
    return false;
  }
  return true;
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
): Promise<boolean> {
  if (!deliveryMatchesCurrentState(ctx.state.snapshot(), pr)) {
    ctx.logger.warn(`跳过过期交付的失败回调（PR #${pr.number}）：当前任务版本已变化`);
    return false;
  }
  if (issueNumber) {
    if (!deliveryMatchesCurrentState(ctx.state.snapshot(), pr)) return false;
    await reopenIssueIfClosedByPRs(ctx, issueNumber, [pr]);
    if (!deliveryMatchesCurrentState(ctx.state.snapshot(), pr)) return false;
    await tolerant(() => ctx.github.removeLabels(issueNumber, STATUS_LABELS));
    if (!deliveryMatchesCurrentState(ctx.state.snapshot(), pr)) return false;
    await tolerant(() => ctx.github.addLabels(issueNumber, ['pi-task', 'status:failed']));
    if (!deliveryMatchesCurrentState(ctx.state.snapshot(), pr)) return false;
    await tolerant(() => ctx.github.comment(issueNumber, `❌ 部署失败，保留旧预览，重试仅恢复部署阶段：\n${detail}`));
  }
  let applied = false;
  await ctx.state.update((s) => {
    if (!deliveryMatchesCurrentState(s, pr)) return;
    applied = true;
    if (!s.deploy.deployFailedPRs) s.deploy.deployFailedPRs = [];
    if (!s.deploy.deployFailedPRs.includes(pr.number)) s.deploy.deployFailedPRs.push(pr.number);
    for (const job of deliveryJobs(s, pr)) {
      job.status = 'failed';
      job.failureStage = 'deploy';
      job.resumeAction = 'deploy-only';
      job.updatedAt = new Date().toISOString();
    }
    return undefined;
  });
  if (!applied) {
    ctx.logger.warn(`跳过过期交付的失败状态落盘（PR #${pr.number}）：当前任务版本已变化`);
    return false;
  }
  ctx.logger.warn(`部署失败（PR #${pr.number}）: ${detail}`);
  return true;
}

async function markDeployed(
  ctx: DeployDeps,
  pr: ManagedPR,
  issueNumber: number | undefined,
  sha: string,
): Promise<boolean> {
  let applied = false;
  await ctx.state.update((s) => {
    if (!deliveryMatchesCurrentState(s, pr)) return;
    applied = true;
    s.deploy.activeSha = sha;
    s.deploy.releaseDir = join(ctx.runDir, 'releases', sha);
    if (!s.deploy.deployedPRs.includes(pr.number)) s.deploy.deployedPRs.push(pr.number);
    s.deploy.deployFailedPRs = (s.deploy.deployFailedPRs ?? []).filter((n) => n !== pr.number);
    for (const job of deliveryJobs(s, pr)) {
      job.status = 'done';
      job.resumeAction = undefined;
      job.updatedAt = new Date().toISOString();
    }
    return undefined;
  });
  if (!applied) {
    ctx.logger.warn(`跳过过期交付的成功状态落盘（PR #${pr.number}）：当前任务版本已变化`);
    return false;
  }
  const receiptOk = await syncDeployReceipt(ctx, pr, issueNumber, sha, true);
  if (!deliveryMatchesCurrentState(ctx.state.snapshot(), pr)) {
    ctx.logger.warn(`部署状态落盘后任务版本已变化（PR #${pr.number}），撤销旧交付的本地完成标记`);
    return false;
  }
  if (!receiptOk && issueNumber !== undefined) {
    await ctx.state.update((s) => {
      if (!deliveryMatchesCurrentState(s, pr)) return;
      for (const job of deliveryJobs(s, pr)) {
        if (job.status === 'done') {
          job.resumeAction = 'sync-deploy-receipt';
        }
      }
      return undefined;
    });
    ctx.logger.warn(`部署成功（PR #${pr.number}）但 GitHub 回执同步失败，待下轮补同步`);
  }
  ctx.logger.info(`部署成功（PR #${pr.number} → ${sha}）`);
  return true;
}

function publicEntryNotice(publicUrl?: string): string {
  if (!publicUrl) return '';
  return `公网入口（Vercel独立发布）：${publicUrl}`;
}

async function syncDeployReceipt(
  ctx: DeployDeps,
  pr: ManagedPR,
  issueNumber: number | undefined,
  sha: string,
  includeComment: boolean,
): Promise<boolean> {
  if (!deliveryMatchesCurrentState(ctx.state.snapshot(), pr)) return false;
  if (issueNumber === undefined) return true;
  const reqId = typeof pr.meta?.reqId === 'string' ? pr.meta.reqId : undefined;
  const state = ctx.state.snapshot();
  const dispatchRevision = reqId ? latestDispatchRevision(state, reqId) : undefined;
  const versionText = dispatchRevision ? `（r${dispatchRevision.revision}）` : '';
  const marker = `已部署：\`${sha}\`${versionText}`;
  const results: boolean[] = [];
  const issue = await findManagedIssue(ctx, issueNumber);
  if (!deliveryMatchesCurrentState(ctx.state.snapshot(), pr)) return false;
  if (issue) {
    // 远端可见时做幂等同步：只修缺失/过期的部分，避免重复回执覆盖真实状态。
    const staleStatus = issue.labels.filter((l) => STATUS_LABELS.includes(l) && l !== 'status:done');
    if (staleStatus.length > 0) {
      if (!deliveryMatchesCurrentState(ctx.state.snapshot(), pr)) return false;
      results.push(await tryGithub(() => ctx.github.removeLabels(issueNumber, staleStatus)));
    }
    if (!issue.labels.includes('pi-task')) {
      if (!deliveryMatchesCurrentState(ctx.state.snapshot(), pr)) return false;
      results.push(await tryGithub(() => ctx.github.addLabels(issueNumber, ['pi-task'])));
    }
    if (!issue.labels.includes('status:done')) {
      if (!deliveryMatchesCurrentState(ctx.state.snapshot(), pr)) return false;
      results.push(await tryGithub(() => ctx.github.addLabels(issueNumber, ['status:done'])));
    }
    if (issue.state !== 'closed') {
      if (!deliveryMatchesCurrentState(ctx.state.snapshot(), pr)) return false;
      results.push(await tryGithub(() => ctx.github.closeIssue(issueNumber)));
    }
  } else {
    if (!deliveryMatchesCurrentState(ctx.state.snapshot(), pr)) return false;
    results.push(await tryGithub(() => ctx.github.removeLabels(issueNumber, STATUS_LABELS)));
    if (!deliveryMatchesCurrentState(ctx.state.snapshot(), pr)) return false;
    results.push(await tryGithub(() => ctx.github.addLabels(issueNumber, ['pi-task', 'status:done'])));
    if (!deliveryMatchesCurrentState(ctx.state.snapshot(), pr)) return false;
    results.push(await tryGithub(() => ctx.github.closeIssue(issueNumber)));
  }
  if (includeComment) {
    const alreadyCommented = await hasDeployComment(ctx, issueNumber, marker);
    if (!alreadyCommented) {
      if (!deliveryMatchesCurrentState(ctx.state.snapshot(), pr)) return false;
      const publicNotice = publicEntryNotice(ctx.publicUrl);
      const receipt = [
        `🚀 本地已部署：\`${sha}\`${versionText}，健康检查通过，本地预览 http://127.0.0.1:5173`,
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

async function listIssueEvents(ctx: DeployDeps, issueNumber: number): Promise<IssueEvent[]> {
  const repo = ctx.state.snapshot().repo;
  if (!repo || typeof ctx.github.runApi !== 'function') {
    throw new Error('缺少仓库绑定或 Issue 事件读取能力');
  }
  const result = await ctx.github.runApi([
    'api',
    '--paginate',
    '--slurp',
    `repos/${repo}/issues/${issueNumber}/events?per_page=100`,
  ]);
  if (result.code !== 0) {
    throw new Error(`读取 Issue #${issueNumber} 事件失败: ${result.stderr.trim() || `退出码 ${result.code}`}`);
  }
  let pages: unknown;
  try {
    pages = JSON.parse(result.stdout);
  } catch {
    throw new Error(`Issue #${issueNumber} 事件响应不是合法 JSON`);
  }
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
    throw new Error(`Issue #${issueNumber} 事件分页结构非法`);
  }
  const events: IssueEvent[] = [];
  for (const value of pages.flat()) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Issue #${issueNumber} 事件记录非法`);
    }
    const raw = value as Record<string, unknown>;
    if (raw.event !== 'closed' && raw.event !== 'reopened') continue;
    if (!Number.isSafeInteger(raw.id) || (raw.id as number) <= 0) {
      throw new Error(`Issue #${issueNumber} 状态事件缺少有效 id`);
    }
    if (typeof raw.created_at !== 'string' || !Number.isFinite(Date.parse(raw.created_at))) {
      throw new Error(`Issue #${issueNumber} 状态事件缺少有效 created_at`);
    }
    const commitId =
      typeof raw.commit_id === 'string' && SHA_RE.test(raw.commit_id)
        ? raw.commit_id.toLowerCase()
        : undefined;
    events.push({
      id: raw.id as number,
      event: raw.event,
      commitId,
      createdAt: raw.created_at,
      createdAtMs: Date.parse(raw.created_at),
    });
  }
  return events;
}

async function reopenIssueIfClosedByPRs(
  ctx: DeployDeps,
  issueNumber: number,
  candidates: ManagedPR[],
  clearStaleStatus = false,
): Promise<boolean> {
  const mergeShas = new Set(
    candidates
      .map((pr) => pr.mergeCommitSha?.toLowerCase())
      .filter((sha): sha is string => typeof sha === 'string' && SHA_RE.test(sha)),
  );
  if (mergeShas.size === 0) return false;
  const issue = await findManagedIssue(ctx, issueNumber);
  if (!issue || issue.state !== 'closed') return false;
  let latest: IssueEvent | undefined;
  try {
    const stateEvents = await listIssueEvents(ctx, issueNumber);
    // GitHub 只保证事件 id 唯一，不保证时序；先后只能由 created_at 证明。
    const latestTime = stateEvents.reduce<number | undefined>(
      (maximum, event) =>
        maximum === undefined || event.createdAtMs > maximum
          ? event.createdAtMs
          : maximum,
      undefined,
    );
    const latestEvents = latestTime === undefined
      ? []
      : stateEvents.filter((event) => event.createdAtMs === latestTime);
    if (latestEvents.length > 1) {
      ctx.logger.warn(
        `Issue #${issueNumber} 最新状态事件时间并列，无法排除人工关单，保持关闭`,
      );
      return false;
    }
    [latest] = latestEvents;
  } catch (error) {
    ctx.logger.warn(
      `Issue #${issueNumber} 关单来源无法核实，保持关闭: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
  if (latest?.event !== 'closed' || !latest.commitId || !mergeShas.has(latest.commitId)) {
    ctx.logger.warn(`Issue #${issueNumber} 最新关闭事件不是已知 PR 自动关单，保持关闭`);
    return false;
  }
  const matched = candidates.find(
    (pr) => pr.mergeCommitSha?.toLowerCase() === latest!.commitId,
  );
  try {
    await ctx.github.reopenIssue(issueNumber);
    if (clearStaleStatus) {
      await tryGithub(() => ctx.github.removeLabels(issueNumber, STATUS_LABELS));
    }
    const marker = `已恢复任务卡：旧 PR #${matched?.number ?? '?'}`;
    const alreadyCommented = await hasDeployComment(ctx, issueNumber, marker);
    if (!alreadyCommented) {
      await tryGithub(() =>
        ctx.github.comment(
          issueNumber,
          `${marker} 合并提交 \`${latest!.commitId}\` 通过 \`Closes\` 自动关闭；当前需求版本已接管，恢复待处理状态。`,
        ),
      );
    }
    ctx.logger.info(`Issue #${issueNumber} 已从旧 PR #${matched?.number ?? '?'} 的可证明自动关单恢复`);
    return true;
  } catch (error) {
    ctx.logger.warn(
      `Issue #${issueNumber} 证据已确认但恢复失败: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

async function restoreIssuesClosedBySupersededPRs(
  ctx: DeployDeps,
  merged: ManagedPR[],
): Promise<void> {
  const state = ctx.state.snapshot();
  const requirement = state.requirements[COUNTER_REQ_ID];
  const currentRevision = latestDispatchRevision(state, COUNTER_REQ_ID);
  if (
    !requirement
    || !currentRevision
    || currentRevision.reqId !== COUNTER_REQ_ID
    || !currentRevision.publishedAt
    || !currentRevision.publicationCommentId
    || !revisionMatchesRequirement(currentRevision, COUNTER_REQ_ID, requirement)
  ) {
    return;
  }
  const currentDeliveryDeployed = merged.some(
    (pr) =>
      deliveryMatchesCurrentState(state, pr)
      && state.deploy.deployedPRs.includes(pr.number),
  );
  const currentJobDeployed = Object.values(state.jobs).some(
    (job) =>
      job.reqId === COUNTER_REQ_ID
      && job.dispatchRevision === currentRevision.revision
      && job.status === 'done',
  );
  if (currentDeliveryDeployed || currentJobDeployed) return;
  const stale = merged.filter(
    (pr) =>
      pr.meta?.reqId === COUNTER_REQ_ID
      && !deliveryMatchesCurrentState(state, pr),
  );
  if (stale.length === 0 || typeof ctx.github.listIssues !== 'function') return;
  let issues: ManagedIssue[];
  try {
    issues = await ctx.github.listIssues();
  } catch (error) {
    ctx.logger.warn(
      `读取 Issue 以恢复旧 PR 自动关单失败: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
  const issue = issues.find((candidate) => candidate.number === requirement.issueNumber);
  if (!issue || issue.state !== 'closed') return;
  await reopenIssueIfClosedByPRs(ctx, issue.number, stale, true);
}

async function syncPendingReceipts(ctx: DeployDeps, merged: ManagedPR[]): Promise<void> {
  const state = ctx.state.snapshot();
  const pending = Object.values(state.jobs).filter(
    (job) => job.resumeAction === 'sync-deploy-receipt' && job.prNumber !== undefined,
  );
  for (const job of pending) {
    const pr = merged.find((p) => p.number === job.prNumber);
    if (!pr) continue;
    const current = ctx.state.snapshot();
    const stillCurrent =
      deliveryMatchesCurrentState(current, pr) &&
      current.deploy.activeSha === pr.mergeCommitSha;
    if (!stillCurrent) {
      await ctx.state.update((s) => {
        const target = s.jobs[job.jobId];
        if (
          target
          && target.resumeAction === 'sync-deploy-receipt'
          && !deliveryMatchesCurrentState(s, pr)
        ) {
          target.resumeAction = undefined;
        }
        return undefined;
      });
      ctx.logger.warn(`跳过过期部署回执（PR #${pr.number}）：需求版本已变化，不再用旧回执改任务状态`);
      continue;
    }
    const sha = pr.mergeCommitSha ?? '';
    if (!sha) continue;
    const ok = await syncDeployReceipt(ctx, pr, job.issueNumber, sha, true);
    if (!ok) continue;
    await ctx.state.update((s) => {
      const target = s.jobs[job.jobId];
      if (
        target
        && deliveryMatchesCurrentState(s, pr)
        && s.deploy.activeSha === pr.mergeCommitSha
      ) {
        target.resumeAction = undefined;
      }
      return undefined;
    });
    ctx.logger.info(`补同步部署回执完成（PR #${pr.number}）`);
  }
}

async function rollbackSupersededPreview(
  ctx: DeployDeps,
  pr: ManagedPR,
  deployedSha: string,
  previous: OrchestratorState['deploy'],
): Promise<void> {
  try {
    if (previous.activeSha && previous.releaseDir) {
      const activeSha = ctx.state.snapshot().deploy.activeSha;
      if (activeSha !== deployedSha) return;
      await ctx.switchPreview(previous.activeSha, previous.releaseDir);
      ctx.logger.warn(`已恢复任务版本切换前的预览 ${previous.activeSha}`);
    } else {
      await ctx.state.update((s) => {
        if (s.deploy.activeSha !== deployedSha) return;
        s.deploy.activeSha = null;
        s.deploy.releaseDir = null;
        return undefined;
      });
      ctx.logger.warn(`任务版本切换前无可用基线，已撤销过期预览指针 ${deployedSha}`);
    }
    await ctx.state.update((s) => {
      s.deploy.deployedPRs = s.deploy.deployedPRs.filter((number) => number !== pr.number);
      for (const job of deliveryJobs(s, pr)) {
        if (job.status !== 'done' || job.resumeAction !== undefined) continue;
        job.status = 'in-review';
        job.updatedAt = new Date().toISOString();
      }
      return undefined;
    });
  } catch (error) {
    ctx.logger.error(
      `恢复任务版本切换前预览失败（${deployedSha}）: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function deployMergedPR(
  ctx: DeployDeps,
  pr: ManagedPR,
  issueNumber: number | undefined,
): Promise<DeployResult> {
  if (!isCurrentDelivery(ctx, pr)) {
    return {
      status: 'nothing',
      prNumber: pr.number,
      issueNumber,
      error: '该 PR 对应的当前任务版本已变化，不构建、不切换、不写回执',
    };
  }
  // GitClient.fetch 的第二参数为目标分支（内部固定 origin，更新 origin/<branch>）；
  // 自定义主分支时也必须拉取正确的 origin/<branch>。
  await ctx.git.fetch(ctx.repoDir, ctx.mainBranch ?? 'main');
  if (!isCurrentDelivery(ctx, pr)) {
    return {
      status: 'nothing',
      prNumber: pr.number,
      issueNumber,
      error: '拉取主线期间任务版本已变化',
    };
  }
  if (!pr.mergeCommitSha) {
    const detail = '缺少 merge commit SHA，不猜测部署目标';
    const marked = await markDeployFailed(ctx, pr, issueNumber, detail);
    if (!marked) return { status: 'nothing', prNumber: pr.number, issueNumber, error: detail };
    return { status: 'failed', prNumber: pr.number, issueNumber, error: detail };
  }
  const sha = pr.mergeCommitSha;
  const previous = ctx.state.snapshot().deploy;

  const built = await ctx.build(sha);
  if (!built.ok) {
    const marked = await markDeployFailed(ctx, pr, issueNumber, built.detail);
    if (!marked) return { status: 'nothing', sha, prNumber: pr.number, issueNumber, error: built.detail };
    return { status: 'failed', sha, prNumber: pr.number, issueNumber, error: built.detail };
  }
  if (!isCurrentDelivery(ctx, pr)) {
    return {
      status: 'nothing',
      sha,
      prNumber: pr.number,
      issueNumber,
      error: '构建期间任务版本已变化，不执行健康切换',
    };
  }

  const healthy = await ctx.healthCheck(sha);
  if (!healthy) {
    const marked = await markDeployFailed(ctx, pr, issueNumber, '健康检查失败');
    if (!marked) {
      return { status: 'nothing', sha, prNumber: pr.number, issueNumber, error: '健康检查失败' };
    }
    return { status: 'failed', sha, prNumber: pr.number, issueNumber, error: '健康检查失败' };
  }
  if (!isCurrentDelivery(ctx, pr)) {
    return {
      status: 'nothing',
      sha,
      prNumber: pr.number,
      issueNumber,
      error: '健康检查期间任务版本已变化，不切换预览',
    };
  }

  try {
    await ctx.switchPreview(sha, join(ctx.runDir, 'releases', sha));
  } catch (error) {
    const detail = `预览切换失败：${error instanceof Error ? error.message : String(error)}`;
    const marked = await markDeployFailed(ctx, pr, issueNumber, detail);
    return {
      status: marked ? 'failed' : 'nothing',
      sha,
      prNumber: pr.number,
      issueNumber,
      error: detail,
    };
  }
  if (!isCurrentDelivery(ctx, pr)) {
    await rollbackSupersededPreview(ctx, pr, sha, previous);
    return {
      status: 'nothing',
      sha,
      prNumber: pr.number,
      issueNumber,
      error: '切换期间任务版本已变化，已恢复旧预览且不写 done 或旧回执',
    };
  }
  const marked = await markDeployed(ctx, pr, issueNumber, sha);
  if (!marked) {
    await rollbackSupersededPreview(ctx, pr, sha, previous);
    return {
      status: 'nothing',
      sha,
      prNumber: pr.number,
      issueNumber,
      error: '部署状态落盘前任务版本已变化，已恢复旧预览且未发送旧回执',
    };
  }
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
  await restoreIssuesClosedBySupersededPRs(ctx, merged);
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
