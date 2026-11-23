import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  BASELINE_JOB_RE,
  BASELINE_OPERATION_RE,
} from './retry-baseline.ts';
import {
  PANEL_REQ_ID,
  PANEL_SPEC_PATH,
  isRegisteredSpecPath,
} from './delivery-profile.ts';
import {
  emptyState,
  type DispatchRevision,
  type RetryBaselineState,
  type MergeRequestState,
  type OrchestratorState,
  type SpecRequest,
} from './types.ts';
import { validateDispatchRevision } from './dispatch-task.ts';

const SHA_RE = /^[0-9a-f]{40}$/;
const SPEC_HASH_RE = /^[0-9a-f]{64}$/;
const BASELINE_STAGES = new Set(['prepared', 'ready', 'stale', 'completed']);
const STALE_STAGE = 'retry-baseline-stale';
const READY_FAILURE_STAGES = new Set(['retry-baseline', 'recover', 'remote-delivery-check']);

export class StateStore {
  private state: OrchestratorState;
  private queue: Promise<void> = Promise.resolve();
  private readonly file: string;
  private static corruptBackupSeq = 0;

  constructor(file: string, initialState?: OrchestratorState) {
    this.file = file;
    this.state = initialState ?? emptyState();
  }

  load(): OrchestratorState {
    let raw: string;
    try {
      raw = readFileSync(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return this.snapshot();
      }
      throw error;
    }
    try {
      const parsed = JSON.parse(raw) as OrchestratorState;
      if (parsed && typeof parsed === 'object' && parsed.schemaVersion === 1) {
        // schemaVersion=1 的旧状态可能没有 requirements 字段，按空容器兼容；
        // 显式 null、数组或畸形容器仍由 normalizeRequirements fail closed。
        if (parsed.requirements === undefined) {
          parsed.requirements = {};
        }
        parsed.specRequests ??= {};
        for (const req of Object.values(parsed.specRequests)) {
          normalizeSpecRequest(req);
        }
        normalizeRequirements(parsed.requirements);
        parsed.mergeRequests ??= {};
        for (const merge of Object.values(parsed.mergeRequests)) {
          normalizeMergeRequest(merge);
        }
        if (parsed.retryBaselines === undefined) {
          parsed.retryBaselines = {};
        } else if (
          parsed.retryBaselines === null ||
          typeof parsed.retryBaselines !== 'object' ||
          Array.isArray(parsed.retryBaselines)
        ) {
          throw new Error('retryBaselines 必须是对象容器');
        }
        for (const baseline of Object.values(parsed.retryBaselines)) {
          normalizeRetryBaseline(baseline);
        }
        normalizeRetryBaselineLinks(parsed);
        normalizeDispatchRevisions(parsed);
        parsed.opLog ??= [];
        this.state = parsed;
      } else {
        throw new Error('schemaVersion 不是 1');
      }
    } catch (error) {
      const backup = `${this.file}.corrupt-${Date.now()}-${(StateStore.corruptBackupSeq += 1)}`;
      try {
        writeFileSync(backup, raw, 'utf8');
      } catch {
        // 备份失败时仍拒绝启动，避免覆盖原状态。
      }
      throw new Error(
        `状态文件损坏，已备份到 ${backup}，拒绝启动: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return this.snapshot();
  }

  snapshot(): OrchestratorState {
    return JSON.parse(JSON.stringify(this.state)) as OrchestratorState;
  }

  async update<T>(fn: (state: OrchestratorState) => T): Promise<{ state: OrchestratorState; result: T }> {
    const run = async (): Promise<{ state: OrchestratorState; result: T }> => {
      const working = JSON.parse(JSON.stringify(this.state)) as OrchestratorState;
      const result = fn(working);
      this.persist(working);
      this.state = working;
      return { state: this.snapshot(), result };
    };

    const resultPromise = this.queue.then(run, run);
    this.queue = resultPromise.then(
      () => undefined,
      () => undefined,
    );
    return resultPromise;
  }

  protected persist(state: OrchestratorState): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, this.file);
  }
}

/** 需求只能绑定直属规格或唯一受信 pending 面板路径；任何未登记子路径立即拒绝加载。 */
function normalizeRequirements(requirements: OrchestratorState['requirements']): void {
  if (!requirements || typeof requirements !== 'object' || Array.isArray(requirements)) {
    throw new Error('requirements 必须是对象容器');
  }
  for (const [reqId, requirement] of Object.entries(requirements)) {
    if (
      !reqId ||
      !requirement ||
      typeof requirement !== 'object' ||
      Array.isArray(requirement) ||
      typeof requirement.specPath !== 'string' ||
      !isRegisteredSpecPath(requirement.specPath) ||
      (requirement.specPath === PANEL_SPEC_PATH && reqId !== PANEL_REQ_ID) ||
      (reqId === PANEL_REQ_ID && requirement.specPath !== PANEL_SPEC_PATH)
    ) {
      throw new Error(`requirements 记录畸形或规格路径未登记: ${reqId || 'unknown'}`);
    }
  }
}

function normalizeSpecRequest(req: SpecRequest): void {
  req.hasValidDoc ??= Boolean(req.docContent);
  req.labelsSynced ??= false;
  if (req.stage === 'commit') req.stage = 'write';
  if (req.stage === 'review') req.stage = 'pr-open';
}

function normalizeMergeRequest(merge: MergeRequestState): void {
  merge.preflightMessageIds ??= [merge.originalMessageId];
  merge.confirmationMessageIds ??= [];
}

/** 派工历史必须按 revision 升序、键与 reqId 一致；任何畸形记录 fail closed。 */
function normalizeDispatchRevisions(state: OrchestratorState): void {
  if (state.dispatchRevisions === undefined) {
    state.dispatchRevisions = {};
    return;
  }
  if (
    state.dispatchRevisions === null
    || typeof state.dispatchRevisions !== 'object'
    || Array.isArray(state.dispatchRevisions)
  ) {
    throw new Error('dispatchRevisions 必须是对象容器');
  }
  for (const [reqId, list] of Object.entries(state.dispatchRevisions)) {
    if (!reqId || !Array.isArray(list)) {
      throw new Error(`dispatchRevisions 记录畸形: ${reqId}`);
    }
    const sorted = [...list].sort((a, b) => a.revision - b.revision);
    let previous = 0;
    for (const rev of sorted) {
      if (!validateDispatchRevision(rev) || rev.reqId !== reqId) {
        throw new Error(`dispatchRevisions 记录畸形: ${reqId}`);
      }
      if (rev.revision <= previous) {
        throw new Error(`dispatchRevisions 版本号必须严格升序且唯一: ${reqId}`);
      }
      previous = rev.revision;
    }
    state.dispatchRevisions![reqId] = sorted;
  }
}

function normalizeRetryBaseline(baseline: RetryBaselineState): void {
  if (
    !baseline ||
    typeof baseline !== 'object' ||
    typeof baseline.operationId !== 'string' ||
    !BASELINE_OPERATION_RE.test(baseline.operationId) ||
    typeof baseline.reqId !== 'string' ||
    !baseline.reqId ||
    !Number.isSafeInteger(baseline.issueNumber) ||
    baseline.issueNumber <= 0 ||
    typeof baseline.specPath !== 'string' ||
    !isRegisteredSpecPath(baseline.specPath) ||
    (baseline.specPath === PANEL_SPEC_PATH && baseline.reqId !== PANEL_REQ_ID) ||
    (baseline.reqId === PANEL_REQ_ID && baseline.specPath !== PANEL_SPEC_PATH) ||
    typeof baseline.specHash !== 'string' ||
    !SPEC_HASH_RE.test(baseline.specHash) ||
    typeof baseline.fromJobId !== 'string' ||
    !baseline.fromJobId ||
    typeof baseline.newJobId !== 'string' ||
    !BASELINE_JOB_RE.test(baseline.newJobId) ||
    baseline.newJobId !== `${baseline.operationId}-job` ||
    !SHA_RE.test(baseline.fromSourceMainSha ?? '') ||
    !SHA_RE.test(baseline.targetSourceMainSha ?? '') ||
    !Number.isSafeInteger(baseline.attempt) ||
    baseline.attempt <= 0 ||
    !BASELINE_STAGES.has(baseline.stage) ||
    typeof baseline.createdAt !== 'string' ||
    typeof baseline.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(baseline.createdAt)) ||
    !Number.isFinite(Date.parse(baseline.updatedAt)) ||
    (baseline.error !== undefined && typeof baseline.error !== 'string')
  ) {
    throw new Error(`retryBaselines 记录畸形: ${baseline?.operationId ?? 'unknown'}`);
  }
}

/** 新记录与旧 Job/requirement 的交叉校验；任何缺项都不能被恢复路径补造为成功。 */
export function normalizeRetryBaselineLinks(state: OrchestratorState): void {
  for (const [key, baseline] of Object.entries(state.retryBaselines ?? {})) {
    if (key !== baseline.operationId) {
      throw new Error(`retryBaselines 键与 operationId 不一致: ${key}`);
    }
    const sameSha = baseline.fromSourceMainSha === baseline.targetSourceMainSha;
    const requirement = state.requirements[baseline.reqId];
    const oldJob = state.jobs[baseline.fromJobId];
    const newJob = state.jobs[baseline.newJobId];
    if (
      !oldJob ||
      oldJob.reqId !== baseline.reqId ||
      oldJob.issueNumber !== baseline.issueNumber ||
      oldJob.specHash !== baseline.specHash ||
      oldJob.sourceMainSha !== baseline.fromSourceMainSha ||
      oldJob.status !== 'failed'
    ) {
      throw new Error(`retryBaselines 与新 Job/旧 Job 链接不完整: ${baseline.operationId}`);
    }
    // 准备/待执行仍依赖当前 Issue 绑定；历史记录只在当时校验，
    // 后续需求移除或切换不能阻止控制器启动。
    const activeRequirement = baseline.stage === 'prepared' || baseline.stage === 'ready';
    if (activeRequirement && !requirement) {
      throw new Error(`活动 retryBaselines 缺少当前需求绑定: ${baseline.operationId}`);
    }
    if (baseline.stage === 'prepared') {
      if (newJob !== undefined) {
        throw new Error(`prepared 阶段提前创建了新 Job: ${baseline.operationId}`);
      }
      if (
        requirement.issueNumber !== baseline.issueNumber ||
        requirement.specPath !== baseline.specPath ||
        requirement.specHash !== baseline.specHash ||
        requirement.sourceMainSha !== baseline.fromSourceMainSha
      ) {
        throw new Error(`prepared 阶段已提前创建 Job 或需求绑定被覆盖: ${baseline.operationId}`);
      }
      continue;
    }
    if (baseline.stage === 'stale' && newJob === undefined) {
      // prepared 在远端仍 old 时可由 main 漂移终止，从未生成 newJob。
      if (!newJob) continue;
    }
    if (!newJob || newJob.reqId !== baseline.reqId ||
      newJob.issueNumber !== baseline.issueNumber ||
      newJob.specHash !== baseline.specHash ||
      newJob.sourceMainSha !== baseline.targetSourceMainSha ||
      newJob.attempt !== baseline.attempt ||
      (baseline.stage === 'ready' &&
        (requirement.issueNumber !== baseline.issueNumber ||
          requirement.specPath !== baseline.specPath ||
          requirement.specHash !== baseline.specHash ||
          !(
            requirement.sourceMainSha === baseline.targetSourceMainSha ||
            (sameSha && requirement.sourceMainSha === baseline.fromSourceMainSha)
          ))) ||
      (baseline.stage === 'stale' &&
        (newJob.status !== 'failed' || newJob.failureStage !== STALE_STAGE)) ||
      (baseline.stage === 'completed' &&
        (newJob.status === 'todo' ||
          (newJob.status === 'failed' && newJob.failureStage === STALE_STAGE)))
    ) {
      throw new Error(`retryBaselines 阶段与 Job/需求绑定不一致: ${baseline.operationId}`);
    }
  }
}

export function backupState(stateFile: string): void {
  try {
    const raw = readFileSync(stateFile);
    writeFileSync(`${stateFile}.bak`, raw);
  } catch {
    // Nothing to back up.
  }
}
