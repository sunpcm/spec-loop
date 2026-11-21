export interface Spec {
  id: string;
  title: string;
  path: string;
  body: string;
  hash: string;
}

export type SpecAction = 'add' | 'update' | 'remove' | 'move' | 'unchanged';

export interface SpecDiffEntry {
  action: SpecAction;
  id: string;
  spec?: Spec;
  previous?: Spec;
  pathChanged: boolean;
  contentChanged: boolean;
}

export interface SpecDiff {
  entries: SpecDiffEntry[];
  targetMainSha: string;
}

export type ManagedMeta = Record<string, unknown>;

export interface ManagedIssue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  meta: ManagedMeta | null;
  url?: string;
}

export interface ManagedPR {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt?: string;
  headRefName: string;
  headSHA?: string;
  baseRefName: string;
  mergeCommitSha?: string;
  meta: ManagedMeta | null;
  labels?: string[];
  url?: string;
}

export type StatusLabel = 'todo' | 'processing' | 'in-review' | 'done' | 'failed' | 'satisfied';

export interface JobState {
  jobId: string;
  reqId: string;
  issueNumber: number;
  specHash: string;
  sourceMainSha: string;
  attempt: number;
  status: StatusLabel;
  failureStage?: string;
  resumeAction?: string;
  prNumber?: number;
  /** Worker 实际提交并经控制器持久验证的完整 head SHA；缺失时合并必须 fail closed。 */
  headSHA?: string;
  /** 无代码变更验收（satisfied）时持久化的候选树 SHA；与浏览器/node:test 证据绑定。 */
  candidateTreeSha?: string;
  startedAt: string;
  updatedAt: string;
  /** 派工版本号；旧任务或无门禁需求可为空。 */
  dispatchRevision?: number;
  /** 领取本次作业的许可事件 ID，用于持久去重。 */
  grantEventId?: number;
}

export interface RequirementState {
  issueNumber: number;
  specHash: string;
  specPath: string;
  sourceMainSha: string;
}

/** 一次派工中的单个工作步骤，acceptanceRefs 必须引用 acceptance 内的键。 */
export interface DispatchStep {
  text: string;
  acceptanceRefs: string[];
}

/**
 * 已冻结、可交给 Worker 的结构化派工任务。来源、路径、版本与哈希由控制器固定，
 * 本结构只承载目标、步骤、验收与写入范围；allowedPaths 由仓库策略解析。
 */
export interface DispatchTask {
  goal: string;
  steps: DispatchStep[];
  acceptance: Record<string, string>;
  allowedPaths: string[];
  dependsOn: string[];
}

/** 本版开工许可的本地快照；grantEventId 由 GitHub labeled 事件 ID 持久去重。 */
export interface DispatchGrant {
  eventId: number;
  actorId: string;
  grantedAt: string;
}

/**
 * 一个 `repo + reqId` 的历版冻结派工记录。revision 单调递增、永久占用；
 * repoId 绑定受管仓库数字 ID，runtime 可据此核对 Issue 归属。
 */
export interface DispatchRevision {
  reqId: string;
  repoId: string;
  revision: number;
  issueNumber: number;
  specHash: string;
  specPath: string;
  sourceMainSha: string;
  task: DispatchTask;
  /** 发布评论/标签完成并回读后的时间；缺失表示尚未发布或发布结果未知。 */
  publishedAt?: string;
  /** 发布评论回读到的 GitHub 评论 ID。 */
  publicationCommentId?: number;
  /** 已观察到的有效本版许可（尚未领取或已领取）；由标签事件 ID 持久去重。 */
  grant?: DispatchGrant;
}

export type RetryBaselineStage = 'prepared' | 'ready' | 'stale' | 'completed';

/** 显式重试旧 revision 到当前 main 的可恢复准备记录；旧 Job 与旧 requirement 不被改写。 */
export interface RetryBaselineState {
  operationId: string;
  reqId: string;
  issueNumber: number;
  specPath: string;
  specHash: string;
  fromJobId: string;
  fromSourceMainSha: string;
  targetSourceMainSha: string;
  newJobId: string;
  attempt: number;
  stage: RetryBaselineStage;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export interface DeployState {
  activeSha: string | null;
  releaseDir: string | null;
  deployedPRs: number[];
  deployFailedPRs?: number[];
}

export type SpecRequestStage =
  | 'pi'
  | 'write'
  | 'commit'
  | 'push'
  | 'pr'
  | 'pr-open'
  | 'pr-merged'
  | 'pr-closed'
  | 'review'
  | 'failed'
  | 'stale';

export interface SpecRequest {
  requestId: string;
  messageId: string;
  description: string;
  targetReqId: string;
  baseSHA: string;
  branch: string;
  stage: SpecRequestStage;
  /** Pi 已产出并通过控制器校验的文档内容；避免重试时重新调用 Pi 丢弃既有产物。 */
  hasValidDoc: boolean;
  docContent?: string;
  summary?: string;
  commitSHA?: string;
  prNumber?: number;
  prUrl?: string;
  /** 文档 PR 合并后落盘的 merge commit SHA；用于面板把文档请求与代码 job 严格关联，不参与调度/合并/恢复语义。 */
  mergedMainSha?: string;
  /** spec-patch 标签是否已经由控制器确认。false 时可从远端幂等补齐。 */
  labelsSynced?: boolean;
  error?: string;
  /** failed 前正在执行/下一步应恢复的阶段；用于少量稳定状态之外的失败定位。 */
  failureStage?: SpecRequestStage;
  createdAt: string;
  updatedAt: string;
}

export interface OpLogEntry {
  ts: string;
  stage: string;
  operationKey: string;
  detail: string;
}

export type MergePrType = 'docs' | 'code';

export type MergeRequestStage =
  | 'confirmable'
  | 'attempted'
  | 'unknown'
  | 'merged'
  | 'failed'
  | 'expired'
  | 'invalidated';

/**
 * 飞书合并许可的本地审计记录。确认码和操作者标识只保存在本地 state，
 * 不写入 GitHub，也不在 [MERGE] 日志中输出。
 */
export interface MergeRequestState {
  requestId: string;
  repo: string;
  prNumber: number;
  prTitle: string;
  prUrl: string;
  type: MergePrType;
  headSHA: string;
  baseSHA: string;
  operatorId: string;
  chatId: string;
  originalMessageId: string;
  preflightMessageIds: string[];
  confirmationMessageIds: string[];
  confirmationCode: string;
  checksSummary: string;
  localValidation: string;
  stage: MergeRequestStage;
  result?: string;
  mergeCommitSha?: string;
  error?: string;
  createdAt: string;
  expiresAt: string;
  updatedAt: string;
}

export interface OrchestratorState {
  schemaVersion: number;
  repo: string | null;
  cursorMainSha: string | null;
  requirements: Record<string, RequirementState>;
  jobs: Record<string, JobState>;
  deploy: DeployState;
  specRequests: Record<string, SpecRequest>;
  /** schema 1 的向后兼容可选扩展；旧 state 加载时补为空对象。 */
  mergeRequests?: Record<string, MergeRequestState>;
  /** schema 1 的向后兼容可选扩展；保留旧 Job，仅记录显式重试的新基线准备。 */
  retryBaselines?: Record<string, RetryBaselineState>;
  /** schema 1 的向后兼容可选扩展；每个 reqId 的历版冻结派工任务，按 revision 升序。 */
  dispatchRevisions?: Record<string, DispatchRevision[]>;
  opLog: OpLogEntry[];
}

export function emptyState(): OrchestratorState {
  return {
    schemaVersion: 1,
    repo: null,
    cursorMainSha: null,
    requirements: {},
    jobs: {},
    deploy: { activeSha: null, releaseDir: null, deployedPRs: [] },
    specRequests: {},
    mergeRequests: {},
    retryBaselines: {},
    dispatchRevisions: {},
    opLog: [],
  };
}
