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
