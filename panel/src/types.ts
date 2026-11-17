export type PanelStatus =
  | 'pending'
  | 'running'
  | 'waiting'
  | 'succeeded'
  | 'failed'
  | 'stale'
  | 'unknown';

export type PanelStateKind = 'ok' | 'missing' | 'invalid' | 'unsupported';

export type DeliveryDeployStatus = 'deployed' | 'deploy-failed' | 'receipt-pending' | 'none';

export type LinkBasis = 'exact' | 'hash-only' | 'unconfirmed' | 'none';

export interface PanelNode {
  id: string;
  label: string;
  status: PanelStatus;
  current: boolean;
  detail: string;
}

export interface PanelRequest {
  requestId: string;
  targetReqId: string;
  stage: string;
  status: PanelStatus;
  prNumber: number | null;
  prUrl: string | null;
  summary: string | null;
  mergedMainSha: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  superseded: boolean;
  linkedDeliveryIds: string[];
  nodes: PanelNode[];
}

export interface PanelDeliveryAttempt {
  attempt: number;
  status: PanelStatus;
  failureStage: string | null;
  prNumber: number | null;
  prUrl: string | null;
  issueNumber: number;
  isLatest: boolean;
  deployStatus: DeliveryDeployStatus;
  startedAt: string | null;
  updatedAt: string | null;
}

export interface PanelDeliveryGroup {
  id: string;
  reqId: string;
  specHash: string;
  sourceMainSha: string;
  issueNumber: number;
  createdAt: string | null;
  updatedAt: string | null;
  superseded: boolean;
  linkBasis: LinkBasis;
  linkedRequestId: string | null;
  attempts: PanelDeliveryAttempt[];
  nodes: PanelNode[];
}

export interface PanelDeploy {
  activeSha: string | null;
  deployedPRs: number[];
  deployFailedPRs: number[];
}

export interface PanelView {
  schemaVersion: 'panel/v1';
  observedAt: string;
  stateUpdatedAt: string | null;
  stateKind: PanelStateKind;
  repo: string | null;
  controllerOnline: boolean;
  cursorMainSha: string | null;
  requests: PanelRequest[];
  deliveryGroups: PanelDeliveryGroup[];
  deploy: PanelDeploy;
  nodes: PanelNode[];
}

export type Scope =
  | { type: 'request'; id: string }
  | { type: 'delivery'; id: string }
  | null;

export type TestRunStatus = 'passed' | 'failed' | 'unknown';
export type TestEvidenceStage = 'worker' | 'build' | 'manual' | 'browser';
export type TestRunnerName = 'node:test' | 'playwright' | 'manual' | 'unknown';
export type TestArtifactKind = 'screenshot' | 'video' | 'trace' | 'json';

export interface TestArtifactSummary {
  id: string;
  kind: TestArtifactKind;
  name: string;
  href: string;
}

export interface TestCaseSummary {
  id: string;
  title: string;
  status: TestRunStatus;
  durationMs: number | null;
  error: string | null;
  artifacts: TestArtifactSummary[];
}

export interface FixedTestSummary {
  runner: 'node:test';
  total: number | null;
  passed: number | null;
  failed: number | null;
  skipped: number | null;
  cancelled: number | null;
  todo: number | null;
  durationMs: number | null;
  unknown: boolean;
}

export interface BrowserTestSummary {
  runner: 'playwright';
  specCount: number | null;
  targetTestCount: number | null;
  resultCount: number | null;
  skipped: number | null;
  flaky: number | null;
  unexpected: number | null;
  errorCount: number | null;
  failedResultCount: number | null;
  retriedCount: number | null;
  unknown: boolean;
}

export type TestRunSummaryDetail = FixedTestSummary | BrowserTestSummary | null;

export interface TestRunSummary {
  id: string;
  stage: TestEvidenceStage;
  runner: TestRunnerName;
  version: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  jobId: string | null;
  reqId: string | null;
  specHash: string | null;
  sourceMainSha: string | null;
  candidateTreeSha: string | null;
  suiteFingerprint: string | null;
  ok: boolean | null;
  summary: TestRunSummaryDetail;
  cases: TestCaseSummary[];
  artifacts?: TestArtifactSummary[];
}

export interface TestRunsResponse {
  schemaVersion: 'test-runs/v1';
  runs: TestRunSummary[];
}
