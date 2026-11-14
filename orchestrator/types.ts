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
  baseRefName: string;
  mergeCommitSha?: string;
  meta: ManagedMeta | null;
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

export interface OpLogEntry {
  ts: string;
  stage: string;
  operationKey: string;
  detail: string;
}

export interface OrchestratorState {
  schemaVersion: number;
  repo: string | null;
  cursorMainSha: string | null;
  requirements: Record<string, RequirementState>;
  jobs: Record<string, JobState>;
  deploy: DeployState;
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
    opLog: [],
  };
}
