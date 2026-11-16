import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeMetaBlock, extractMeta, stripMeta } from './github.ts';
import type { GithubClient } from './github.ts';
import type { GitClient } from './git.ts';
import type { Logger } from './log.ts';
import { buildIssueBody, buildRequirementMeta } from './reconciler.ts';
import { parseSpecs } from './specs.ts';
import type { StateStore } from './state.ts';
import type {
  JobState,
  ManagedIssue,
  ManagedPR,
  ManagedMeta,
  OrchestratorState,
  RequirementState,
  RetryBaselineState,
  Spec,
} from './types.ts';
import type { WorkerInput, WorkerOutcome } from './worker.ts';

const SHA_RE = /^[0-9a-f]{40}$/;
export const BASELINE_OPERATION_RE = /^retry-baseline-[0-9a-f]{24}$/;
export const BASELINE_JOB_RE = /^retry-baseline-[0-9a-f]{24}-job$/;
const PREPARED_FAILURE_STAGE = 'retry-baseline';
const PREPARED_RESUME_ACTION = 'retry-baseline';
const STALE_FAILURE_STAGE = 'retry-baseline-stale';

export interface RetryBaselineDeps {
  repoDir: string;
  state: StateStore;
  git: GitClient;
  github: GithubClient;
  logger: Logger;
  retryWorker?: (input: WorkerInput) => Promise<WorkerOutcome>;
  retryDeploy: (
    issueNumber: number,
    prNumber?: number,
  ) => Promise<{ status: 'deployed' | 'failed' | 'nothing'; error?: string }>;
  /** runtime 与统一 Worker 共用的交付预检，防止准备与执行使用两套 PR 判据。 */
  findExistingDelivery?: (input: WorkerInput) => Promise<ManagedPR | null>;
  /** 已部署控制器受管的可信测试资产根；绝不从候选规格 worktree 读取验收契约。 */
  trustedE2eRoot?: string;
  mainBranch?: string;
  hooks?: RetryBaselineHooks;
}

/** 仅用于测试持久阶段边界；生产调用不注入任何钩子。 */
export interface RetryBaselineHooks {
  beforePersistPrepared?: (baseline: RetryBaselineState) => void;
  afterPersistPrepared?: (baseline: RetryBaselineState) => void;
  beforeIssueUpdate?: (baseline: RetryBaselineState) => void;
  afterIssueUpdate?: (baseline: RetryBaselineState, error?: unknown) => void;
  beforeCommitReady?: (baseline: RetryBaselineState, state: OrchestratorState) => void;
  beforeWorker?: (input: WorkerInput) => void;
}

export interface RetryBaselineResult {
  status: 'ready' | 'blocked' | 'pending' | 'stale' | 'retry-required' | 'completed' | 'resume-delivery';
  message: string;
  baseline: RetryBaselineState | null;
}

interface Preflight {
  reqId: string;
  issueNumber: number;
  oldJob: JobState;
  requirement: RequirementState;
  issue: ManagedIssue;
  targetMainSha: string;
  spec: Spec;
  baseline: RetryBaselineState;
  newJob: JobState;
  /** 仅表示本次必须显式运行 ready 意图，不代表新 Job 已实际失败。 */
  executeReadyJob?: boolean;
}

type RemoteKind = 'old' | 'target' | 'prepared' | 'third';
type MainProgress = 'target' | 'drifted' | 'rewound' | 'invalid' | 'unknown';
export type RetryBaselinePreflight = Preflight;
type BaselineContext = Pick<Preflight, 'reqId' | 'targetMainSha' | 'spec' | 'baseline' | 'oldJob'>;
type ReadyContext = BaselineContext;

function errorText(error: unknown, limit = 500): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, ' ')
    .slice(0, limit);
}

function openOrMerged(pr: ManagedPR): boolean {
  return pr.state === 'open' || pr.merged;
}

function sameRevision(pr: ManagedPR, input: WorkerInput): boolean {
  return (
    pr.meta?.kind === 'code-pr' &&
    pr.meta.reqId === input.reqId &&
    pr.meta.specHash === input.spec.hash &&
    pr.meta.sourceMainSha === input.sourceMainSha
  );
}

function codeDeliveryMatches(pr: ManagedPR, input: WorkerInput): boolean {
  return sameRevision(pr, input) && openOrMerged(pr);
}

function prLink(number: number): string {
  return `PR #${number}`;
}

function sortedJobs(state: OrchestratorState, reqId: string, issueNumber: number): JobState[] {
  return Object.values(state.jobs)
    .filter((job) => job.reqId === reqId && job.issueNumber === issueNumber)
    .sort(
      (a, b) =>
        a.attempt - b.attempt ||
        (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0) ||
        (a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 : 0),
    );
}

function latestCurrentJob(
  state: OrchestratorState,
  reqId: string,
  issueNumber: number,
  requirement: RequirementState,
): JobState | undefined {
  return sortedJobs(state, reqId, issueNumber)
    .filter(
      (job) =>
        job.specHash === requirement.specHash &&
        job.sourceMainSha === requirement.sourceMainSha,
    )
    .at(-1);
}

function activeBaselines(state: OrchestratorState, reqId: string, issueNumber: number): RetryBaselineState[] {
  return Object.values(state.retryBaselines ?? {}).filter(
    (baseline) =>
      baseline.reqId === reqId &&
      baseline.issueNumber === issueNumber &&
      (baseline.stage === 'prepared' || baseline.stage === 'ready'),
  );
}

function currentBindingError(
  baseline: RetryBaselineState,
  requirement: RequirementState | undefined,
): string | null {
  if (!requirement) return '当前需求绑定已移除';
  if (
    requirement.issueNumber !== baseline.issueNumber ||
    requirement.specHash !== baseline.specHash ||
    requirement.specPath !== baseline.specPath
  ) {
    return '当前需求规格已切换';
  }
  if (baseline.stage === 'prepared') {
    return requirement.sourceMainSha === baseline.fromSourceMainSha ? null : '当前需求来源已切换';
  }
  if (baseline.stage === 'ready') {
    return requirement.sourceMainSha === baseline.targetSourceMainSha ? null : '当前需求来源已切换';
  }
  return null;
}

function exactIssue(issues: ManagedIssue[], issueNumber: number): ManagedIssue {
  const matches = issues.filter((issue) => issue.number === issueNumber);
  if (matches.length === 0) throw new Error(`读取 Issue #${issueNumber} 未返回目标记录`);
  if (matches.length > 1) throw new Error(`Issue #${issueNumber} 远端返回多条记录`);
  return matches[0]!;
}

function result(
  status: RetryBaselineResult['status'],
  message: string,
  baseline: RetryBaselineState | null = null,
): RetryBaselineResult {
  return { status, message, baseline };
}

function messageFor(baseline: RetryBaselineState, text: string): string {
  return `${text}（重试操作 ${baseline.operationId}，基线 ${baseline.fromSourceMainSha.slice(0, 8)} → ${baseline.targetSourceMainSha.slice(0, 8)}）`;
}

function expectedNewJob(baseline: RetryBaselineState): JobState {
  return {
    jobId: baseline.newJobId,
    reqId: baseline.reqId,
    issueNumber: baseline.issueNumber,
    specHash: baseline.specHash,
    sourceMainSha: baseline.targetSourceMainSha,
    attempt: baseline.attempt,
    status: 'failed',
    failureStage: PREPARED_FAILURE_STAGE,
    resumeAction: PREPARED_RESUME_ACTION,
    startedAt: baseline.createdAt,
    updatedAt: baseline.updatedAt,
  };
}

function isPreparedJob(job: JobState, baseline: RetryBaselineState): boolean {
  return (
    matchesBaselineJob(job, baseline) &&
    job.status === 'failed' &&
    job.failureStage === PREPARED_FAILURE_STAGE &&
    job.resumeAction === PREPARED_RESUME_ACTION
  );
}

function readyJob(baseline: RetryBaselineState, prepared: JobState): JobState {
  return { ...prepared };
}

function matchesBaselineJob(job: JobState, baseline: RetryBaselineState): boolean {
  return (
    job.jobId === baseline.newJobId &&
    job.reqId === baseline.reqId &&
    job.issueNumber === baseline.issueNumber &&
    job.specHash === baseline.specHash &&
    job.sourceMainSha === baseline.targetSourceMainSha &&
    job.attempt === baseline.attempt
  );
}

function isAttemptedJob(job: JobState, baseline: RetryBaselineState): boolean {
  return (
    matchesBaselineJob(job, baseline) &&
    ((job.status === 'failed' &&
      job.failureStage !== PREPARED_FAILURE_STAGE &&
      job.failureStage !== STALE_FAILURE_STAGE) ||
      job.status === 'in-review' ||
      job.status === 'done' ||
      job.status === 'satisfied')
  );
}

function isUnstartedBaselineJob(job: JobState, baseline: RetryBaselineState): boolean {
  return isPreparedJob(job, baseline);
}

async function mainProgress(
  git: GitClient,
  repoDir: string,
  fromSha: string,
  targetSha: string,
): Promise<MainProgress> {
  let base: string;
  try {
    base = (await git.raw(['merge-base', fromSha, targetSha], repoDir)).trim();
  } catch {
    try {
      await git.raw(['cat-file', '-e', `${fromSha}^{commit}`], repoDir);
      await git.raw(['cat-file', '-e', `${targetSha}^{commit}`], repoDir);
    } catch {
      return 'unknown';
    }
    return 'unknown';
  }
  if (base === fromSha) return 'target';
  const reverse = (await git.raw(['merge-base', targetSha, fromSha], repoDir)).trim();
  return reverse === targetSha ? 'rewound' : 'drifted';
}

async function currentMain(deps: RetryBaselineDeps): Promise<string> {
  const mainBranch = deps.mainBranch ?? 'main';
  await deps.git.fetch(deps.repoDir, mainBranch);
  const sha = (await deps.git.revParse(deps.repoDir, `origin/${mainBranch}`)).trim().toLowerCase();
  if (!SHA_RE.test(sha)) throw new Error('origin/main 不是完整 SHA，拒绝继续');
  return sha;
}

function parsedSpec(files: Record<string, string>, reqId: string, specPath: string, specHash: string): Spec {
  const parsed = parseSpecs(files);
  if (parsed.errors.length > 0) throw new Error('固定来源的需求文档解析失败，拒绝继续');
  const spec = parsed.specs.find((candidate) => candidate.id === reqId);
  if (!spec || spec.path !== specPath || spec.hash !== specHash) {
    throw new Error(`需求 ${reqId} 的路径或内容已变化，需先由文档对账/文档请求建立新版本`);
  }
  return spec;
}

function parsedSpecs(files: Record<string, string>): Spec[] {
  const parsed = parseSpecs(files);
  if (parsed.errors.length > 0) throw new Error('固定 Git 快照的需求文档解析失败，拒绝继续');
  return parsed.specs;
}

/** 准备与恢复只从 Git 的完整 target SHA 读取，不信任候选 worktree 的旧基线。 */
async function validateUnchangedSpec(
  deps: RetryBaselineDeps,
  reqId: string,
  specPath: string,
  specHash: string,
  sha: string,
): Promise<Spec> {
  const spec = await validateLocalSpec(deps, reqId, specPath, specHash, sha);
  const contractError = trustedContractError(deps.trustedE2eRoot, spec);
  if (contractError) throw new Error(contractError);
  return spec;
}

/** Worker 执行前复读本地固定 SHA，作为 API 准备结果与 Worker 输入树之间的第二次核对。 */
async function validateLocalSpec(
  deps: RetryBaselineDeps,
  reqId: string,
  specPath: string,
  specHash: string,
  sha: string,
): Promise<Spec> {
  return parsedSpec(await deps.git.readSpecSnapshot(deps.repoDir, sha), reqId, specPath, specHash);
}

function issueBindingError(issue: ManagedIssue, reqId: string, requirement: RequirementState, oldJob: JobState): string | null {
  const meta = issue.meta ?? extractMeta(issue.body);
  if (
    !meta ||
    meta.schema !== 1 ||
    meta.system !== 'spec-loop' ||
    meta.kind !== 'requirement' ||
    meta.reqId !== reqId ||
    meta.specPath !== requirement.specPath ||
    meta.specHash !== requirement.specHash ||
    meta.specHash !== oldJob.specHash ||
    meta.sourceMainSha !== oldJob.sourceMainSha
  ) {
    return `#${issue.number} Issue 元数据与旧作业/需求绑定不一致，拒绝创建新基线`;
  }
  return null;
}

function targetMetadata(preflight: BaselineContext): Record<string, unknown> {
  const meta = buildRequirementMeta(preflight.spec, preflight.targetMainSha);
  meta.operationKey = `retry-baseline:${preflight.baseline.operationId}:${preflight.spec.hash}:${preflight.targetMainSha}`;
  meta.retryBaseline = {
    operationId: preflight.baseline.operationId,
    newJobId: preflight.baseline.newJobId,
    fromJobId: preflight.oldJob.jobId,
    fromSourceMainSha: preflight.oldJob.sourceMainSha,
    targetSourceMainSha: preflight.targetMainSha,
  };
  return meta;
}

function targetIssueBody(issue: ManagedIssue, preflight: ReadyContext): string {
  const human = stripMeta(issue.body).trim() || stripMeta(buildIssueBody(preflight.spec, preflight.targetMainSha)).trim();
  if (preflight.baseline.fromSourceMainSha === preflight.baseline.targetSourceMainSha) return issue.body;
  return `${human}\n\n${encodeMetaBlock(targetMetadata(preflight))}`;
}

function isExactTargetMeta(meta: Record<string, unknown> | null, preflight: ReadyContext): boolean {
  if (!meta) return false;
  const retry = meta.retryBaseline;
  if (!retry || typeof retry !== 'object' || Array.isArray(retry)) return false;
  const retryRecord = retry as Record<string, unknown>;
  return (
    JSON.stringify(meta) === JSON.stringify(targetMetadata(preflight)) &&
    retryRecord.operationId === preflight.baseline.operationId &&
    retryRecord.newJobId === preflight.baseline.newJobId &&
    retryRecord.fromJobId === preflight.oldJob.jobId &&
    retryRecord.fromSourceMainSha === preflight.oldJob.sourceMainSha &&
    retryRecord.targetSourceMainSha === preflight.targetMainSha
  );
}

function predecessorRetryMetaMatches(
  meta: ManagedMeta | null,
  preflight: ReadyContext & { requirement: RequirementState; issueNumber: number },
): boolean {
  if (!meta) return false;
  const retry = meta.retryBaseline;
  if (!retry || typeof retry !== 'object' || Array.isArray(retry)) return false;
  const record = retry as Record<string, unknown>;
  return (
    meta.schema === 1 &&
    meta.system === 'spec-loop' &&
    meta.kind === 'requirement' &&
    meta.reqId === preflight.reqId &&
    meta.specPath === preflight.requirement.specPath &&
    meta.specHash === preflight.baseline.specHash &&
    meta.sourceMainSha === preflight.baseline.fromSourceMainSha &&
    record.targetSourceMainSha === preflight.baseline.fromSourceMainSha &&
    record.newJobId === preflight.oldJob.jobId
  );
}

function remoteKind(
  issue: ManagedIssue,
  preflight: ReadyContext & { requirement: RequirementState; issueNumber: number },
): RemoteKind {
  if (issue.number !== preflight.issueNumber) return 'third';
  const meta = issue.meta ?? extractMeta(issue.body);
  if (preflight.baseline.fromSourceMainSha === preflight.baseline.targetSourceMainSha) {
    return isRequirementMeta(meta, preflight) ? 'target' : 'third';
  }
  if (isExactTargetMeta(meta, preflight) || isRequirementMeta(meta, preflight)) return 'target';
  if (meta?.retryBaseline && typeof meta.retryBaseline === 'object') {
    if (preparedBindingMatches(meta, preflight.baseline, preflight.baseline.specPath)) return 'prepared';
    if (predecessorRetryMetaMatches(meta, preflight)) return 'old';
    return 'third';
  }
  if (
    meta &&
    meta.schema === 1 &&
    meta.system === 'spec-loop' &&
    meta.kind === 'requirement' &&
    meta.reqId === preflight.reqId &&
    meta.specPath === preflight.requirement.specPath &&
    meta.specHash === preflight.baseline.specHash &&
    meta.sourceMainSha === preflight.baseline.fromSourceMainSha
  ) {
    return 'old';
  }
  return 'third';
}

function isRequirementMeta(
  meta: ManagedMeta | null,
  preflight: ReadyContext & { issueNumber: number },
): boolean {
  return Boolean(
    meta &&
    meta.schema === 1 &&
    meta.system === 'spec-loop' &&
    meta.kind === 'requirement' &&
    meta.reqId === preflight.reqId &&
    meta.specPath === preflight.baseline.specPath &&
    meta.specHash === preflight.baseline.specHash &&
    meta.sourceMainSha === preflight.baseline.targetSourceMainSha,
  );
}

function preparedBindingMatches(
  meta: ManagedMeta | null,
  baseline: RetryBaselineState,
  specPath: string,
): boolean {
  if (!meta) return false;
  const retry = meta.retryBaseline;
  if (!retry || typeof retry !== 'object' || Array.isArray(retry)) return false;
  const record = retry as Record<string, unknown>;
  return (
    meta.schema === 1 &&
    meta.system === 'spec-loop' &&
    meta.kind === 'requirement' &&
    meta.reqId === baseline.reqId &&
    meta.specPath === specPath &&
    meta.specHash === baseline.specHash &&
    meta.sourceMainSha === baseline.targetSourceMainSha &&
    record.operationId === baseline.operationId &&
    record.newJobId === baseline.newJobId &&
    record.fromJobId === baseline.fromJobId &&
    record.fromSourceMainSha === baseline.fromSourceMainSha &&
    record.targetSourceMainSha === baseline.targetSourceMainSha
  );
}

function preparedSpecPath(state: OrchestratorState, baseline: RetryBaselineState): string {
  return state.requirements[baseline.reqId]?.specPath ?? baseline.specPath;
}

function latestBaseline(
  state: OrchestratorState,
  reqId: string,
  issueNumber: number,
): RetryBaselineState | undefined {
  return Object.values(state.retryBaselines ?? {})
    .filter((baseline) => baseline.reqId === reqId && baseline.issueNumber === issueNumber)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
    .at(-1);
}

/** 已终止准备只用于排除占槽；新目标仍需是可审计的旧准备后继。 */
function isRetiredForTarget(
  baseline: RetryBaselineState,
  targetSha: string,
): boolean {
  return (
    baseline.stage === 'stale' ||
    (baseline.stage === 'completed' && baseline.targetSourceMainSha !== targetSha)
  );
}

function predecessorAllows(
  state: OrchestratorState,
  oldJob: JobState,
  oldRequirement: RequirementState,
): boolean {
  const prior = latestBaseline(state, oldJob.reqId, oldJob.issueNumber);
  return Boolean(
    prior &&
    prior.stage === 'completed' &&
    prior.newJobId === oldJob.jobId &&
    prior.specHash === oldJob.specHash &&
    prior.targetSourceMainSha === oldJob.sourceMainSha &&
    prior.specPath === oldRequirement.specPath &&
    prior.issueNumber === oldRequirement.issueNumber,
  );
}

export function retryBaselineTargetBody(issue: ManagedIssue, preflight: ReadyContext): string {
  return targetIssueBody(issue, preflight);
}

async function readIssue(deps: RetryBaselineDeps, issueNumber: number): Promise<ManagedIssue> {
  return exactIssue(await deps.github.listIssues(), issueNumber);
}

function trustedContractError(trustedE2eRoot: string | undefined, spec: Spec): string | null {
  if (spec.id !== 'REQ-CNT-01') return null;
  if (!trustedE2eRoot) return '控制器未配置受管可信验收资产目录，拒绝创建新基线';
  try {
    const raw = readFileSync(join(trustedE2eRoot, 'tests', 'e2e', 'contracts', 'counter.json'), 'utf8');
    const contract = JSON.parse(raw) as Record<string, unknown>;
    if (
      contract.reqId !== spec.id ||
      contract.specPath !== spec.path ||
      contract.specHash !== spec.hash ||
      !Array.isArray(contract.caseIds) ||
      contract.caseIds.length === 0
    ) {
      return '当前 main 的需求与受管可信验收契约不匹配；契约由独立测试作者维护，暂不创建新基线';
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return '控制器受管可信验收资产缺少 counter 契约，拒绝创建新基线';
    }
    return '可信验收契约解析失败，拒绝创建新基线';
  }
  return null;
}

export function baselineOperationId(
  oldJob: Pick<JobState, 'jobId' | 'sourceMainSha' | 'specHash'>,
  targetMainSha: string,
): string {
  return `retry-baseline-${createHash('sha256')
    .update(`${oldJob.jobId}\n${oldJob.sourceMainSha}\n${oldJob.specHash}\n${targetMainSha}`)
    .digest('hex')
    .slice(0, 24)}`;
}

function deliveryInput(oldJob: JobState): WorkerInput {
  return {
    jobId: oldJob.jobId,
    reqId: oldJob.reqId,
    issueNumber: oldJob.issueNumber,
    spec: { id: oldJob.reqId, title: '', path: '', body: '', hash: oldJob.specHash },
    sourceMainSha: oldJob.sourceMainSha,
    attempt: oldJob.attempt,
  };
}

function remoteDeliveryPreflight(
  issueNumber: number,
  input: WorkerInput,
  prs: ManagedPR[],
): RetryBaselineResult | null {
  const reqId = input.reqId;
  const unknown = prs.find(
    (pr) =>
      pr.meta?.reqId === reqId &&
      pr.state !== 'open' &&
      pr.state !== 'closed',
  );
  if (unknown) {
    return result('blocked', `需求 ${reqId} 的 ${prLink(unknown.number)} 状态未知，拒绝继续`);
  }
  const targetDeliveries = prs.filter((pr) => codeDeliveryMatches(pr, input));
  if (targetDeliveries.length > 1) {
    return result('blocked', `#${issueNumber} 当前 target 存在多个受管代码 PR，拒绝继续`);
  }
  if (targetDeliveries.length === 1) {
    return result(
      'resume-delivery',
      `#${issueNumber} 已有 target 代码交付 ${prLink(targetDeliveries[0]!.number)}，请走既有交付恢复`,
    );
  }
  const otherActive = prs.find(
    (pr) =>
      pr.state === 'open' &&
      pr.meta?.reqId === reqId &&
      (pr.meta.kind === 'code-pr' || pr.meta.kind === 'spec-request' || pr.labels?.includes('spec-patch')),
  );
  if (otherActive) {
    return result(
      'blocked',
      `需求 ${reqId} 存在活动交付 ${prLink(otherActive.number)}，等待其完成或关闭后再继续`,
    );
  }
  return null;
}

async function deliveryConflict(
  deps: RetryBaselineDeps,
  state: OrchestratorState,
  oldJob: JobState,
  issueNumber: number,
  prs: ManagedPR[],
): Promise<RetryBaselineResult | null> {
  const reqId = oldJob.reqId;
  const unknown = prs.find(
    (pr) =>
      pr.meta?.reqId === reqId &&
      pr.state !== 'open' &&
      pr.state !== 'closed',
  );
  if (unknown) {
    return result('blocked', `需求 ${reqId} 的 ${prLink(unknown.number)} 状态未知，拒绝创建新基线`);
  }
  if (oldJob.prNumber !== undefined) {
    const associated = prs.filter((pr) => pr.number === oldJob.prNumber);
    if (associated.length !== 1) {
      return result(
        'blocked',
        `本地已关联 ${prLink(oldJob.prNumber)}，但远端读取不到唯一 PR，拒绝把未知当作不存在`,
      );
    }
    if (!sameRevision(associated[0]!, deliveryInput(oldJob))) {
      return result('blocked', `${prLink(oldJob.prNumber)} 的 revision 与旧 Job 不一致，拒绝创建新基线`);
    }
    if (openOrMerged(associated[0]!)) {
      return result(
        'resume-delivery',
        `#${issueNumber} 已有受管代码交付 ${prLink(oldJob.prNumber)}，请走既有交付/部署恢复`,
      );
    }
  }

  for (const job of Object.values(state.jobs)) {
    if (job.jobId === oldJob.jobId || job.status === 'failed' || job.status === 'todo') continue;
    if (job.status === 'in-review' || job.status === 'done' || job.status === 'satisfied') continue;
    if (job.reqId === reqId || job.issueNumber === issueNumber) {
      return result('blocked', `需求 ${reqId} 存在活动 Worker（${job.jobId}:${job.status}），暂不创建新基线`);
    }
  }

  const oldDeliveries = prs.filter((pr) => codeDeliveryMatches(pr, deliveryInput(oldJob)));
  if (oldDeliveries.length > 1) {
    return result('blocked', `旧 revision 存在多个活动代码 PR: ${oldDeliveries.map((p) => prLink(p.number)).join(', ')}`);
  }
  if (oldDeliveries.length === 1) {
    return result(
      'resume-delivery',
      `#${issueNumber} 旧 revision 已有代码交付 ${prLink(oldDeliveries[0]!.number)}，请走已有交付恢复，不创建新基线`,
    );
  }

  // 已结束的新基线是原失败 Job 的后继，不能在普通重试时再次派发；
  // 只有读取到其真实失败结局后，才建立新的一次受控恢复。
  const latestRetry = latestBaseline(state, reqId, issueNumber);
  if (latestRetry?.fromJobId === oldJob.jobId && latestRetry.stage === 'completed') {
    const successor = state.jobs[latestRetry.newJobId];
    if (successor && successor.status !== 'failed') {
      return pendingBaselineResult(
        latestRetry,
        successor,
        `#${issueNumber} 新基线已完成，复用已有生命周期`,
      );
    }
  }

  for (const pr of prs) {
    if (pr.state !== 'open' || pr.meta?.reqId !== reqId) continue;
    if (pr.meta.kind === 'code-pr' || pr.meta.kind === 'spec-request' || pr.labels?.includes('spec-patch')) {
      return result('blocked', `需求 ${reqId} 存在活动交付 ${prLink(pr.number)}，等待其完成或关闭后再重试`);
    }
  }

  return null;
}

function pendingBaselineResult(
  baseline: RetryBaselineState,
  job: JobState,
  message: string,
): RetryBaselineResult {
  if (job.status === 'processing') {
    return result('pending', messageFor(baseline, message), baseline);
  }
  if (job.status === 'in-review' || job.status === 'done' || job.status === 'satisfied') {
    return result(
      'resume-delivery',
      messageFor(
        baseline,
        `#${baseline.issueNumber} 新基线 Job 已结束（${job.status}${job.prNumber ? `，PR #${job.prNumber}` : ''}），请走既有交付恢复，不重复派发`,
      ),
      baseline,
    );
  }
  if (isAttemptedJob(job, baseline)) {
    return result(
      'retry-required',
      messageFor(baseline, `#${baseline.issueNumber} 新基线 Job 已实际执行并失败；请再次显式重试以恢复 Worker`),
      baseline,
    );
  }
  return result('pending', messageFor(baseline, message), baseline);
}

export async function prepareRetryBaseline(
  deps: RetryBaselineDeps,
  issueNumber: number,
): Promise<Preflight | RetryBaselineResult> {
  const snapshot = deps.state.snapshot();
  const entries = Object.entries(snapshot.requirements).filter(([, req]) => req.issueNumber === issueNumber);
  if (entries.length === 0) return result('blocked', `#${issueNumber} 无受管任务，不当作代码任务重跑`);
  if (entries.length !== 1) return result('blocked', `#${issueNumber} 需求绑定数量异常，拒绝创建新基线`);

  const [reqId, requirement] = entries[0]!;
  const active = activeBaselines(snapshot, reqId, issueNumber);
  if (active.length > 1) {
    return result('blocked', `需求 ${reqId} 存在多个未结束的新基线准备，停止重试`);
  }
  if (active.length === 1) {
    const pending = active[0]!;
    if (pending.stage === 'prepared') return resumePreparedBaseline(deps, pending, true);
    const bindingError = currentBindingError(pending, requirement);
    if (bindingError) {
      return result('blocked', `未决准备 ${pending.operationId} 与${bindingError}不一致，停止重试`, pending);
    }
    const pendingJob = snapshot.jobs[pending.newJobId];
    if (!pendingJob || !matchesBaselineJob(pendingJob, pending)) {
      return result('blocked', `未决准备 ${pending.operationId} 缺少可重用的新 Job，停止恢复`, pending);
    }
    if (!isUnstartedBaselineJob(pendingJob, pending)) {
      if (isAttemptedJob(pendingJob, pending)) {
        // 已真实执行并失败：先收尾 ready 准备，再沿用当前 requirement 的最新失败 Job
        // 创建普通新 attempt，不把失败当作“还需再 retry-required”的空转。
        await completeIfAttempted(deps, pending);
      } else {
        return pendingBaselineResult(pending, pendingJob, `#${issueNumber} 新基线 Job 已执行或已结束，不重复派发`);
      }
    } else {
      return runPreparedJob(deps, pending);
    }
  }
  // 当前 revision 的最新实际 attempt 是未完成的失败目标；已发布 Job
  // 保持原生命周期，不会因下一次普通重试被覆盖或重复派发。
  const oldJob = latestCurrentJob(snapshot, reqId, issueNumber, requirement);
  if (!oldJob) return result('blocked', `#${issueNumber} 无失败任务记录，不重跑`);
  if (oldJob.failureStage === 'deploy' && oldJob.resumeAction === 'deploy-only') {
    const deployResult = await deps.retryDeploy(issueNumber, oldJob.prNumber);
    return result(
      'completed',
      deployResult.status === 'deployed'
        ? `已重新部署 #${issueNumber}`
        : `重试部署 #${issueNumber} 失败: ${deployResult.error ?? '无待部署合并'}`,
    );
  }
  if (oldJob.status === 'satisfied') {
    return result(
      'completed',
      `#${issueNumber} 已验收无需代码变更，未创建代码 PR、未部署；GitHub 回执${oldJob.resumeAction === 'sync-satisfied-receipt' ? '待补，控制器会恢复回执，不会重跑 Pi' : '已完成'}`,
    );
  }
  const completed = Object.values(snapshot.retryBaselines ?? {})
    .filter((baseline) => baseline.reqId === reqId && baseline.fromJobId === oldJob.jobId && baseline.stage === 'completed')
    .at(-1);
  if (completed && snapshot.jobs[completed.newJobId]) {
    const completedJob = snapshot.jobs[completed.newJobId]!;
    if (!isAttemptedJob(completedJob, completed) || completedJob.status === 'failed') {
      // failed 的新基线是可恢复失败，继续按普通 attempt 递增建立新基线；
      // processing/in-review/done/satisfied 仍复用原生命周期，不重复派发。
      if (completedJob.status === 'processing' || completedJob.status === 'in-review' || completedJob.status === 'done' || completedJob.status === 'satisfied') {
        return pendingBaselineResult(
          completed,
          completedJob,
          `#${issueNumber} 新基线已完成，复用已有生命周期`,
        );
      }
    }
  }
  // 原始失败 Job 仍保留时，已交付/已验收的新基线可以先恢复自己的生命周期；
  // 仅在没有既有成功交付可复用时拒绝普通重试。
  if (oldJob.status !== 'failed') {
    return result('blocked', `#${issueNumber} 当前状态 ${oldJob.status}，仅最新失败任务可创建新基线`);
  }
  if (
    !SHA_RE.test(oldJob.sourceMainSha) ||
    !SHA_RE.test(requirement.sourceMainSha) ||
    oldJob.sourceMainSha !== requirement.sourceMainSha ||
    oldJob.specHash !== requirement.specHash
  ) {
    return result('blocked', `#${issueNumber} 最新失败作业与当前绑定不一致，拒绝创建新基线`);
  }

  let targetMainSha: string;
  try {
    targetMainSha = await currentMain(deps);
  } catch (error) {
    return result('blocked', `#${issueNumber} 当前 main 读取失败，拒绝创建新基线: ${errorText(error)}`);
  }
  const sameSha = targetMainSha === oldJob.sourceMainSha;
  const progress = sameSha
    ? 'target'
    : await mainProgress(deps.git, deps.repoDir, oldJob.sourceMainSha, targetMainSha);
  if (progress !== 'target') {
    return result(
      'blocked',
      `#${issueNumber} 旧来源 ${oldJob.sourceMainSha.slice(0, 8)} 不是当前 main 的祖先（${progress}），拒绝创建新基线`,
    );
  }

  let spec: Spec;
  try {
    spec = await validateUnchangedSpec(deps, reqId, requirement.specPath, requirement.specHash, targetMainSha);
  } catch (error) {
    return result('blocked', `#${issueNumber} ${errorText(error)}`);
  }
  let prs: ManagedPR[];
  try {
    prs = await deps.github.listPRs();
  } catch (error) {
    return result('blocked', `#${issueNumber} 远端 PR 状态读取失败，拒绝把未知当作不存在: ${errorText(error)}`);
  }
  const targetInput: WorkerInput = {
    jobId: '',
    reqId,
    issueNumber,
    spec,
    sourceMainSha: targetMainSha,
    attempt: oldJob.attempt + 1,
  };
  const targetDeliveries = prs.filter((pr) => codeDeliveryMatches(pr, targetInput));
  if (targetDeliveries.length > 1) {
    return result('blocked', `#${issueNumber} 当前 target 存在多个受管代码 PR，拒绝创建新基线`);
  }
  if (targetDeliveries.length === 1) {
    return result(
      'resume-delivery',
      `#${issueNumber} 已有 target 代码交付 ${prLink(targetDeliveries[0]!.number)}，请走既有交付恢复，未创建新基线`,
    );
  }

  const conflict = await deliveryConflict(deps, snapshot, oldJob, issueNumber, prs);
  if (conflict) return conflict;

  let issue: ManagedIssue;
  try {
    issue = await readIssue(deps, issueNumber);
  } catch (error) {
    return result('blocked', `#${issueNumber} Issue 读取失败，拒绝创建新基线: ${errorText(error)}`);
  }
  if (issue.state !== 'open') return result('blocked', `#${issueNumber} Issue 已关闭；若代码已合入请走既有交付/部署恢复`);
  const bindingError = issueBindingError(issue, reqId, requirement, oldJob);
  if (bindingError) return result('blocked', bindingError);

  const attempts = sortedJobs(snapshot, reqId, issueNumber).map((job) => job.attempt);
  const attempt = Math.max(0, ...attempts) + 1;
  const operationId = baselineOperationId(oldJob, targetMainSha);
  // 同毫秒的两次显式重试也必须保持持久化顺序，不能因排序并列而复用旧已结束 Job。
  const previousCreatedAt = Math.max(
    0,
    ...Object.values(snapshot.retryBaselines ?? {}).map((baseline) => Date.parse(baseline.createdAt)),
  );
  const now = new Date(Math.max(Date.now(), previousCreatedAt + 1)).toISOString();
  const baseline: RetryBaselineState = {
    operationId,
    reqId,
    issueNumber,
    specPath: requirement.specPath,
    specHash: requirement.specHash,
    fromJobId: oldJob.jobId,
    fromSourceMainSha: oldJob.sourceMainSha,
    targetSourceMainSha: targetMainSha,
    newJobId: `${operationId}-job`,
    attempt,
    stage: 'prepared',
    createdAt: now,
    updatedAt: now,
  };
  return {
    reqId,
    issueNumber,
    oldJob,
    requirement,
    issue,
    targetMainSha,
    spec,
    baseline,
    newJob: expectedNewJob(baseline),
  };
}

function restoreBase(
  baseline: RetryBaselineState,
  newJob: JobState,
  requirement: RequirementState,
  oldJob: JobState,
  spec: Spec,
  issue: ManagedIssue,
): Preflight {
  return {
    reqId: baseline.reqId,
    issueNumber: baseline.issueNumber,
    oldJob,
    requirement,
    issue,
    targetMainSha: baseline.targetSourceMainSha,
    spec,
    baseline,
    newJob,
  };
}

async function restoreIssueAndSpec(
  deps: RetryBaselineDeps,
  baseline: RetryBaselineState,
  newJob: JobState,
  oldJob: JobState,
): Promise<Preflight | RetryBaselineResult> {
  let spec: Spec;
  let issue: ManagedIssue;
  try {
    spec = await validateUnchangedSpec(
      deps,
      baseline.reqId,
      baseline.specPath,
      baseline.specHash,
      baseline.targetSourceMainSha,
    );
    issue = await readIssue(deps, baseline.issueNumber);
  } catch (error) {
    return result(
      'pending',
      messageFor(baseline, `#${baseline.issueNumber} Issue/固定需求读取失败，保留未决准备: ${errorText(error)}`),
      baseline,
    );
  }
  const requirement: RequirementState = {
    issueNumber: baseline.issueNumber,
    specHash: baseline.specHash,
    specPath: baseline.specPath,
    sourceMainSha: baseline.fromSourceMainSha,
  };
  return restoreBase(baseline, newJob, requirement, oldJob, spec, issue);
}

async function restoreReady(
  deps: RetryBaselineDeps,
  baseline: RetryBaselineState,
  newJob: JobState,
  requirement: RequirementState,
  oldJob: JobState,
): Promise<Preflight | RetryBaselineResult> {
  if (
    requirement.issueNumber !== baseline.issueNumber ||
    requirement.specPath !== baseline.specPath ||
    requirement.specHash !== baseline.specHash ||
    requirement.sourceMainSha !== baseline.targetSourceMainSha
  ) {
    return result('blocked', messageFor(baseline, 'ready 新基线缺少本地目标绑定，停止自动恢复'), baseline);
  }
  const restored = await restoreIssueAndSpec(deps, baseline, newJob, oldJob);
  if (!('oldJob' in restored)) return restored;
  const issueMeta = restored.issue.meta ?? extractMeta(restored.issue.body);
  if (
    baseline.stage === 'ready' &&
    !(
      isRequirementMeta(issueMeta, restored) ||
      isExactTargetMeta(issueMeta, restored)
    )
  ) {
    try {
      await markStale(deps, baseline, 'ready 后本地目标绑定被回退，未派发新 Job');
    } catch (error) {
      deps.logger.warn(`标记失效重试失败: ${errorText(error)}`);
    }
  }
  if (remoteKind(restored.issue, { ...restored, requirement }) !== 'target') {
    return result('blocked', messageFor(baseline, 'ready 新基线的远端 Issue 未确认 target 元数据，未调用 Worker'), baseline);
  }
  return { ...restored, requirement };
}

async function resumePreparedBaseline(
  deps: RetryBaselineDeps,
  stored: RetryBaselineState,
  explicit: boolean,
): Promise<RetryBaselineResult> {
  const snapshot = deps.state.snapshot();
  const requirement = snapshot.requirements[stored.reqId];
  const oldJob = snapshot.jobs[stored.fromJobId];
  const newJob = snapshot.jobs[stored.newJobId];
  const bindingError = currentBindingError(stored, requirement);
  if (
    !oldJob ||
    bindingError ||
    oldJob.sourceMainSha !== stored.fromSourceMainSha ||
    oldJob.specHash !== stored.specHash ||
    oldJob.issueNumber !== stored.issueNumber
  ) {
    return result('blocked', messageFor(stored, '持久化重试准备记录与旧作业/需求或新 Job 不一致，停止恢复'), stored);
  }
  if (stored.stage !== 'prepared') {
    return result('blocked', messageFor(stored, '准备记录已终止或本地绑定已被取代，停止远端恢复'), stored);
  }

  const restored = await restoreIssueAndSpec(deps, stored, newJob ?? expectedNewJob(stored), oldJob);
  if (!('oldJob' in restored)) return restored;
  const binding: Preflight = { ...restored, requirement };
  const kind = remoteKind(restored.issue, binding);
  if (kind === 'target') {
    const ready = await finishReady(deps, {
      ...restored,
      issue: restored.issue,
      newJob: newJob ?? expectedNewJob(stored),
    });
    if (!('oldJob' in ready)) return ready;
    let currentSha: string | null = null;
    try {
      currentSha = await currentMain(deps);
    } catch {
      // 本地 ready 仍可提交；执行前的固定 SHA 检查会让未核验的作业留待重试。
    }
    let hasMoved = false;
    try {
      hasMoved = currentSha !== null &&
        currentSha !== stored.targetSourceMainSha &&
        await mainProgress(deps.git, deps.repoDir, stored.targetSourceMainSha, currentSha) === 'target';
    } catch {
      hasMoved = false;
    }
    if (hasMoved) {
      // 远端已经提交 target，先可靠落本地 ready/newJob/target requirement，
      // 再终止尚未派发的本地准备；不能留下 Issue target 但本地仍是 old。
      const stale = await markStale(deps, ready.baseline, '已确认的 target 不再是当前 main，远端绑定保留');
      return result('stale', stale.error ?? '重试准备已过期', stale);
    }
    if (!explicit) return result('ready', messageFor(ready.baseline, '远端已确认 target，本地新基线已完成准备'), ready.baseline);
    return runPreparedJob(deps, ready.baseline);
  }
  if (stored.fromSourceMainSha === stored.targetSourceMainSha) {
    const ready = await finishReady(deps, { ...restored, issue: restored.issue });
    if (!('oldJob' in ready)) return ready;
    if (!explicit) return result('ready', messageFor(stored, '同 SHA 原需求元数据即为 target，本地新基线已完成准备'), ready.baseline);
    return runPreparedJob(deps, ready.baseline);
  }
  if (kind !== 'old') {
    return result('pending', messageFor(stored, '# Issue 出现第三种绑定，保留未决准备并停止'), stored);
  }

  let targetSha: string;
  try {
    targetSha = await currentMain(deps);
  } catch (error) {
    return result('pending', messageFor(stored, `# Issue 仍为旧绑定，main 读取失败，保留未决准备: ${errorText(error)}`), stored);
  }
  const progress = await mainProgress(deps.git, deps.repoDir, stored.fromSourceMainSha, targetSha);
  if (progress === 'target' && targetSha !== stored.targetSourceMainSha) {
    const stale = await markStale(deps, stored, 'main 已前进，远端仍为旧绑定；旧绑定保留，请重新显式重试');
    return result('stale', stale.error ?? '重试准备已过期', stale);
  }
  if (progress !== 'target') {
    const stale = await markStale(
      deps,
      stored,
      progress === 'drifted'
        ? 'main 已前进，远端仍为旧绑定；旧绑定保留，请重新显式重试'
        : 'main 不再包含旧来源或不可比较，旧绑定保留；请检查基线后重新显式重试',
    );
    return result('stale', stale.error ?? '重试准备已过期', stale);
  }
  if (targetSha !== stored.targetSourceMainSha) {
    return result('pending', messageFor(stored, '固定 target main 在本操作中变化，未修改远端绑定；请重新显式重试'), stored);
  }

  let prs: ManagedPR[];
  try {
    prs = await deps.github.listPRs();
  } catch (error) {
    return result('pending', messageFor(stored, `Issue 尚未更新，远端 PR 状态读取失败，保留未决准备: ${errorText(error)}`), stored);
  }
  const targetInput: WorkerInput = {
    jobId: stored.newJobId,
    reqId: stored.reqId,
    issueNumber: stored.issueNumber,
    spec: restored.spec,
    sourceMainSha: stored.targetSourceMainSha,
    attempt: stored.attempt,
  };
  const remoteConflict = remoteDeliveryPreflight(stored.issueNumber, targetInput, prs);
  if (remoteConflict) return remoteConflict;

  let remoteForUpdate = restored.issue;

  let updateError: unknown;
  deps.hooks?.beforeIssueUpdate?.(stored);
  try {
    await deps.github.updateIssueBody(
      stored.issueNumber,
      retryBaselineTargetBody(remoteForUpdate, restored),
    );
  } catch (error) {
    updateError = error;
  }
  deps.hooks?.afterIssueUpdate?.(stored, updateError);

  let readback: ManagedIssue;
  try {
    readback = await readIssue(deps, stored.issueNumber);
  } catch (error) {
    const warning = updateError
      ? `#${stored.issueNumber} Issue 更新失败且回读失败，保留未决准备: ${errorText(updateError)}`
      : `#${stored.issueNumber} Issue 更新后回读失败，保留未决准备`;
    await recordWarning(deps, stored, messageFor(stored, warning), error);
    return result('pending', warning, stored);
  }
  const readbackKind = remoteKind(readback, binding);
  if (readbackKind === 'target') {
    const ready = await finishReady(deps, { ...restored, issue: readback });
    if (!('oldJob' in ready)) return ready;
    if (!explicit) return result('ready', messageFor(stored, '远端已确认 target，本地新基线已完成准备'), ready.baseline);
    return runPreparedJob(deps, ready.baseline);
  }
  if (readbackKind === 'old') {
    const warning = updateError
      ? `#${stored.issueNumber} Issue 未更新，保留准备记录等待显式重试: ${errorText(updateError)}`
      : `#${stored.issueNumber} Issue 回读仍为旧绑定，保留准备记录`;
    if (updateError) await recordWarning(deps, stored, warning, updateError);
    return result('pending', warning, stored);
  }
  return result('pending', messageFor(stored, '# Issue 出现第三种绑定，保留未决准备并停止'), stored);
}

async function finishReady(
  deps: RetryBaselineDeps,
  preflight: Preflight,
): Promise<Preflight | RetryBaselineResult> {
  deps.hooks?.beforeCommitReady?.(preflight.baseline, deps.state.snapshot());
  const nextJob = readyJob(preflight.baseline, preflight.newJob);
  try {
    await deps.state.update((s) => {
      const baseline = s.retryBaselines?.[preflight.baseline.operationId];
      const current = s.requirements[preflight.reqId];
      const old = s.jobs[preflight.oldJob.jobId];
      const job = s.jobs[preflight.baseline.newJobId];
      if (
        !baseline ||
        !current ||
        !old ||
        baseline.stage !== 'prepared' ||
        current.issueNumber !== preflight.issueNumber ||
        current.specHash !== baseline.specHash ||
        current.specPath !== baseline.specPath ||
        current.sourceMainSha !== baseline.fromSourceMainSha ||
        old.sourceMainSha !== baseline.fromSourceMainSha ||
        old.specHash !== baseline.specHash ||
        (job !== undefined && !isPreparedJob(job, baseline))
      ) {
        throw new Error('本地准备记录与新 Job 绑定不完整');
      }
      s.requirements[preflight.reqId] = {
        issueNumber: preflight.issueNumber,
        specHash: baseline.specHash,
        specPath: baseline.specPath,
        sourceMainSha: baseline.targetSourceMainSha,
      };
      s.jobs[baseline.newJobId] = nextJob;
      baseline.stage = 'ready';
      baseline.error = undefined;
      baseline.updatedAt = new Date().toISOString();
      s.opLog.push({
        ts: baseline.updatedAt,
        stage: 'retry-baseline',
        operationKey: baseline.operationId,
        detail: `${baseline.fromSourceMainSha} -> ${baseline.targetSourceMainSha}; ready`,
      });
      return undefined;
    });
  } catch (error) {
    return result(
      'pending',
      messageFor(preflight.baseline, `#${preflight.issueNumber} 远端已更新但本地 ready 提交失败，保留未决准备: ${errorText(error)}`),
      preflight.baseline,
    );
  }
  const next = deps.state.snapshot();
  return {
    ...preflight,
    requirement: preflight.requirement,
    baseline: next.retryBaselines![preflight.baseline.operationId]!,
    newJob: next.jobs[preflight.baseline.newJobId]!,
  };
}

async function completeIfAttempted(
  deps: RetryBaselineDeps,
  baseline: RetryBaselineState,
): Promise<void> {
  const currentBaseline = deps.state.snapshot().retryBaselines?.[baseline.operationId];
  const job = deps.state.snapshot().jobs[baseline.newJobId];
  if (!job) return;
  if (job.status === 'processing') {
    // ready 生命周期已经进入 Worker；即使最终结局还需恢复，也不再属于
    // 未派发的准备。之后的显式重试只修复该 Job 或按普通失败建立新 attempt。
    if (currentBaseline?.stage === 'ready' || currentBaseline?.stage === 'completed') {
      await deps.state.update((s) => {
        const target = s.retryBaselines?.[baseline.operationId];
        if (!target || target.stage !== 'ready' || s.jobs[target.newJobId]?.status !== 'processing') return undefined;
        target.stage = 'completed';
        target.updatedAt = new Date().toISOString();
        target.error = undefined;
        s.opLog.push({
          ts: target.updatedAt,
          stage: 'retry-baseline',
          operationKey: target.operationId,
          detail: `${target.fromSourceMainSha} -> ${target.targetSourceMainSha}; processing`,
        });
        return undefined;
      });
    }
    return;
  }
  if (isAttemptedJob(job, baseline)) {
    await deps.state.update((s) => {
      const target = s.retryBaselines?.[baseline.operationId];
      const current = target ? s.jobs[target.newJobId] : undefined;
      if (!target || !current || !isAttemptedJob(current, target) || target.stage === 'stale') return undefined;
      target.stage = 'completed';
      target.error = undefined;
      target.updatedAt = new Date().toISOString();
      s.opLog.push({
        ts: target.updatedAt,
        stage: 'retry-baseline',
        operationKey: target.operationId,
        detail: `${target.fromSourceMainSha} -> ${target.targetSourceMainSha}; ${current.status}`,
      });
      return undefined;
    });
  }
}

async function runPreparedJob(deps: RetryBaselineDeps, stored: RetryBaselineState): Promise<RetryBaselineResult> {
  const snapshot = deps.state.snapshot();
  const baseline = snapshot.retryBaselines?.[stored.operationId];
  const requirement = snapshot.requirements[stored.reqId];
  const oldJob = snapshot.jobs[stored.fromJobId];
  const newJob = snapshot.jobs[stored.newJobId];
  if (!baseline || !requirement || oldJob?.jobId !== stored.fromJobId) {
    return result('blocked', messageFor(stored, '本地基线绑定不完整，停止派发'), stored);
  }
  if (baseline.stage !== 'ready') {
    return result('pending', messageFor(stored, '本地新基线尚未完成 ready 提交，未调用 Worker'), baseline);
  }
  if (!newJob) {
    return result('blocked', messageFor(stored, '本地 ready 新基线缺少新 Job，停止派发'), baseline);
  }
  if (!isUnstartedBaselineJob(newJob, baseline)) {
    return pendingBaselineResult(baseline, newJob, '新基线 Job 状态发生变化，未重复派发');
  }
  const currentSha = await currentMain(deps).catch(() => null);
  let hasMoved = false;
  try {
    hasMoved = currentSha !== null &&
      currentSha !== baseline.targetSourceMainSha &&
      await mainProgress(deps.git, deps.repoDir, baseline.targetSourceMainSha, currentSha) === 'target';
  } catch {
    hasMoved = false;
  }
  if (hasMoved) {
    const stale = await markStale(
      deps,
      baseline,
      '执行前 main 已前进；新 Job 未派发，请重新显式重试以建立新基线',
    );
    return result('stale', stale.error ?? '重试准备已过期', stale);
  }

  const restored = await restoreReady(deps, baseline, newJob, requirement, oldJob);
  if (!('oldJob' in restored)) return restored;
  if (baseline.stage !== 'ready' || !isUnstartedBaselineJob(newJob, baseline)) {
    return pendingBaselineResult(baseline, newJob, '新基线 Job 已开始或结束，沿用统一生命周期恢复');
  }
  const fixedTarget = currentSha === baseline.targetSourceMainSha;
  if (!fixedTarget && !hasMoved) {
    return result('pending', messageFor(baseline, '执行前 main 无法核验为固定 target，未调用 Worker'), baseline);
  }

  let prs: ManagedPR[];
  try {
    prs = await deps.github.listPRs();
  } catch (error) {
    return result('pending', messageFor(baseline, `执行前远端 PR 状态读取失败，未调用 Worker: ${errorText(error)}`), baseline);
  }
  const input: WorkerInput = {
    jobId: baseline.newJobId,
    reqId: baseline.reqId,
    issueNumber: baseline.issueNumber,
    spec: restored.spec,
    sourceMainSha: baseline.targetSourceMainSha,
    attempt: baseline.attempt,
  };
  const remoteConflict = remoteDeliveryPreflight(baseline.issueNumber, input, prs);
  if (remoteConflict) return { ...remoteConflict, baseline };
  if (deps.findExistingDelivery) {
    let existing: ManagedPR | null;
    try {
      existing = await deps.findExistingDelivery(input);
    } catch (error) {
      return result('blocked', messageFor(baseline, `执行前远端交付预检失败，未调用 Worker: ${errorText(error)}`), baseline);
    }
    if (existing) {
      return result(
        'resume-delivery',
        `#${baseline.issueNumber} 已有 target 代码交付 ${prLink(existing.number)}，请走既有交付恢复，未调用 Worker`,
        baseline,
      );
    }
  }
  if (await deps.github.branchExists(baseline.newJobId)) {
    return result('blocked', messageFor(baseline, '新 Job 的受管分支已存在但无匹配 PR，未调用 Worker'), baseline);
  }

  deps.hooks?.beforeWorker?.(input);
  if (!deps.retryWorker) {
    return result('blocked', messageFor(baseline, '统一 Worker 重试生命周期未接线，未调用 Worker'), baseline);
  }
  let outcome: WorkerOutcome;
  try {
    outcome = await deps.retryWorker(input);
  } finally {
    await completeIfAttempted(deps, baseline);
  }
  const finalState = deps.state.snapshot().jobs[baseline.newJobId];
  if (outcome.status === 'failed' && finalState?.status === 'failed' && isAttemptedJob(finalState, baseline)) {
    return result(
      'retry-required',
      `#${baseline.issueNumber} 新基线 Worker 已实际执行并失败（${finalState.failureStage ?? 'unknown'}）；再次显式重试只会恢复该 Job`,
      baseline,
    );
  }
  if (finalState?.status === 'processing') {
    return result(
      'pending',
      `#${baseline.issueNumber} 新基线 Worker 已开始处理，等待统一生命周期完成（来源 ${finalState.sourceMainSha.slice(0, 8)}）`,
      baseline,
    );
  }
  return result(
    'completed',
    outcome.status === 'published'
      ? `#${baseline.issueNumber} 已在新 main 基线上重新进入 review（PR #${outcome.prNumber}）`
      : outcome.status === 'satisfied'
        ? `#${baseline.issueNumber} 已在新 main 基线通过验收，无需代码变更，未创建 PR、未部署`
        : outcome.status === 'stale'
          ? `#${baseline.issueNumber} 新基线 Worker 检测到主线漂移或过期，请再次显式重试`
          : `#${baseline.issueNumber} 新基线 Worker 失败: ${outcome.error ?? outcome.status}`,
    baseline,
  );
}

async function markStale(
  deps: RetryBaselineDeps,
  baseline: RetryBaselineState,
  reason: string,
): Promise<RetryBaselineState> {
  const { state } = await deps.state.update((s) => {
    const target = s.retryBaselines?.[baseline.operationId];
    if (!target || (target.stage !== 'prepared' && target.stage !== 'ready')) {
      throw new Error('仅未派发的新基线准备可标记过期');
    }
    const job = s.jobs[target.newJobId];
    if (job !== undefined && (!isUnstartedBaselineJob(job, target) || job.status === 'processing')) {
      throw new Error('新基线 Job 已执行或状态不一致，拒绝覆盖');
    }
    target.stage = 'stale';
    target.error = messageFor(target, reason).slice(0, 500);
    target.updatedAt = new Date().toISOString();
    if (job) {
      job.failureStage = STALE_FAILURE_STAGE;
      job.updatedAt = target.updatedAt;
    }
    s.opLog.push({
      ts: target.updatedAt,
      stage: 'retry-baseline',
      operationKey: target.operationId,
      detail: `${target.fromSourceMainSha} -> ${target.targetSourceMainSha}; stale`,
    });
    return undefined;
  });
  return state.retryBaselines![baseline.operationId]!;
}

/** 重启/runOnce/recover 恢复 ready 生命周期，避免 active ready 阻塞权威对账。 */
async function resumeReadyBaseline(
  deps: RetryBaselineDeps,
  baseline: RetryBaselineState,
): Promise<void> {
  const snapshot = deps.state.snapshot();
  const requirement = snapshot.requirements[baseline.reqId];
  const newJob = snapshot.jobs[baseline.newJobId];
  const bindingError = currentBindingError(baseline, requirement);
  if (
    bindingError ||
    !snapshot.jobs[baseline.fromJobId] ||
    !newJob ||
    !matchesBaselineJob(newJob, baseline)
  ) {
    deps.logger.warn(`重试 ready ${baseline.operationId} 本地绑定不完整，保留待人工检查`);
    return;
  }
  if (!isUnstartedBaselineJob(newJob, baseline)) {
    // Job 已进入实际 Worker 生命周期：只收尾 operation，不改 Job/不调模型；
    // 真正结局由后续恢复流程或显式重试继续处理。
    await completeIfAttempted(deps, baseline);
    return;
  }
  // 未运行 ready 只有 main 明确漂移时终止，让权威对账重放；
  // main 未变时继续等待显式 retry，不能自动派发 Worker。
  let currentSha: string | null = null;
  try {
    currentSha = await currentMain(deps);
  } catch {
    deps.logger.warn(`重试 ready ${baseline.operationId} 读取 main 失败，保留等待显式重试`);
    return;
  }
  let hasMoved = false;
  try {
    hasMoved = currentSha !== null &&
      currentSha !== baseline.targetSourceMainSha &&
      await mainProgress(deps.git, deps.repoDir, baseline.targetSourceMainSha, currentSha) === 'target';
  } catch {
    hasMoved = false;
  }
  if (!hasMoved) return;
  const stale = await markStale(
    deps,
    baseline,
    '未运行 ready 的 target 不再是当前 main，终止本地准备并等待权威对账重放',
  );
  deps.logger.warn(`重试 ready ${baseline.operationId}: ${stale.error ?? '已标记过期'}`);
}

async function recordWarning(
  deps: RetryBaselineDeps,
  baseline: RetryBaselineState,
  message: string,
  error: unknown,
): Promise<void> {
  deps.logger.warn(`${message}: ${errorText(error)}`);
  await deps.state.update((s) => {
    const target = s.retryBaselines?.[baseline.operationId];
    if (target && target.stage === 'prepared') {
      target.error = message.slice(0, 500);
      target.updatedAt = new Date().toISOString();
    }
    return undefined;
  });
}

async function persistPrepared(deps: RetryBaselineDeps, preflight: RetryBaselinePreflight): Promise<void> {
  deps.hooks?.beforePersistPrepared?.(preflight.baseline);
  await deps.state.update((s) => {
    const requirement = s.requirements[preflight.reqId];
    const oldJob = s.jobs[preflight.oldJob.jobId];
    if (
      !requirement ||
      !oldJob ||
      requirement.issueNumber !== preflight.issueNumber ||
      requirement.specHash !== preflight.baseline.specHash ||
      requirement.sourceMainSha !== preflight.baseline.fromSourceMainSha ||
      oldJob.status !== 'failed' ||
      oldJob.sourceMainSha !== preflight.baseline.fromSourceMainSha ||
      oldJob.specHash !== preflight.baseline.specHash ||
      latestCurrentJob(s, preflight.reqId, preflight.issueNumber, requirement)?.jobId !== oldJob.jobId
    ) {
      throw new Error('持久提交前绑定已变化，拒绝覆盖');
    }
    if (
      activeBaselines(s, preflight.reqId, preflight.issueNumber).length > 0 ||
      s.jobs[preflight.baseline.newJobId] ||
      s.retryBaselines?.[preflight.baseline.operationId]
    ) {
      throw new Error('新基线准备或新 Job 已存在，拒绝重复提交');
    }
    s.retryBaselines ??= {};
    s.retryBaselines[preflight.baseline.operationId] = preflight.baseline;
    s.opLog.push({
      ts: new Date().toISOString(),
      stage: 'retry-baseline',
      operationKey: preflight.baseline.operationId,
      detail: `${preflight.baseline.fromSourceMainSha} -> ${preflight.baseline.targetSourceMainSha}; prepared`,
    });
    return undefined;
  });
  deps.hooks?.afterPersistPrepared?.(preflight.baseline);
}

/** 只持久化 prepared 意图；供新需求入口在写文档前做同一冲突门禁。 */
export async function persistRetryBaselinePrepared(
  deps: RetryBaselineDeps,
  preflight: RetryBaselinePreflight,
): Promise<void> {
  await persistPrepared(deps, preflight);
}

/** 只触发已登记 prepared 的受控恢复；不调用 Worker。 */
export async function syncRetryBaselinePrepared(deps: RetryBaselineDeps, issueNumber: number): Promise<void> {
  const baseline = Object.values(deps.state.snapshot().retryBaselines ?? {}).find(
    (candidate) => candidate.issueNumber === issueNumber && candidate.stage === 'prepared',
  );
  if (baseline) await resumePreparedBaseline(deps, baseline, false);
}

export async function retryWithBaseline(deps: RetryBaselineDeps, issueNumber: number): Promise<string> {
  try {
    const checked = await prepareRetryBaseline(deps, issueNumber);
    if (!('oldJob' in checked)) return checked.message;
    const existing = deps.state.snapshot().retryBaselines?.[checked.baseline.operationId];
    try {
      await persistPrepared(deps, checked);
    } catch (error) {
      if (!existing || existing.stage !== 'prepared') {
        throw new Error(`持久化新基线准备失败: ${errorText(error)}`);
      }
    }
    const resumed = await resumePreparedBaseline(deps, checked.baseline, true);
    return resumed.message;
  } catch (error) {
    deps.logger.warn(`显式重试准备失败: ${errorText(error)}`);
    return `#${issueNumber} 显式重试准备失败: ${errorText(error)}`;
  }
}

/** 启动/runOnce/recover 只恢复既有外部准备；不创建准备、不调用 Worker。 */
export async function resumeRetryBaselines(deps: RetryBaselineDeps): Promise<void> {
  const state = deps.state.snapshot();
  const pending = Object.values(state.retryBaselines ?? {})
    .filter((baseline) => baseline.stage === 'prepared' || baseline.stage === 'ready')
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  for (const baseline of pending) {
    try {
      const current = deps.state.snapshot();
      // 重启/对账只读恢复既有准备，不能因一次恢复新增未登记的新 Job。
      if (!current.jobs[baseline.fromJobId]) {
        deps.logger.warn(`重试准备 ${baseline.operationId} 旧 Job 链接缺失，保留待人工检查`);
        continue;
      }
      if (currentBindingError(baseline, current.requirements[baseline.reqId])) {
        deps.logger.warn(`重试准备 ${baseline.operationId} 已被当前需求绑定取代，保留待人工检查`);
        continue;
      }
      if (baseline.stage === 'ready') {
        await resumeReadyBaseline(deps, baseline);
        continue;
      }
      const resumed = await resumePreparedBaseline(deps, baseline, false);
      if (resumed.status === 'pending' || resumed.status === 'blocked' || resumed.status === 'stale') {
        deps.logger.warn(`重试准备 ${baseline.operationId}: ${resumed.message}`);
      }
    } catch (error) {
      deps.logger.warn(`恢复显式重试准备 ${baseline.operationId} 失败: ${errorText(error)}`);
    }
  }
}

/** 供 spec-intake 用同一绑定规则检查未决准备，避免新需求绕过受控重试。 */
export function hasActiveRetryBaseline(state: OrchestratorState, reqId: string): boolean {
  return Object.values(state.retryBaselines ?? {}).some(
    (baseline) =>
      baseline.reqId === reqId && (baseline.stage === 'prepared' || baseline.stage === 'ready'),
  );
}
