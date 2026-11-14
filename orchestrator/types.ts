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

export type StatusLabel = 'todo' | 'processing' | 'in-review' | 'done' | 'failed';

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
  startedAt: string;
  updatedAt: string;
}

export interface RequirementState {
  issueNumber: number;
  specHash: string;
  specPath: string;
  sourceMainSha: string;
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
    opLog: [],
  };
}
