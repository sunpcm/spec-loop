import { createHash } from 'node:crypto';
import { redact } from './log.ts';
import {
  projectPanelWait,
  type PanelDispatchObservation,
  type PanelEvidenceRef,
  type PanelVersionIdentity,
  type PanelWaitPrimaryJob,
  type PanelWaitProjection,
  type PanelWaitRevision,
} from './panel-wait.ts';
import {
  COUNTER_REQ_ID,
  COUNTER_SPEC_PATH,
  PANEL_REQ_ID,
  PANEL_SPEC_PATH,
} from './delivery-profile.ts';
import { SPEC_REQUEST_ID_RE } from './spec-identity.ts';
import { parseSpecs } from './specs.ts';

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
  version: PanelVersionIdentity;
  waiting: PanelWaitProjection;
  evidence: PanelEvidenceRef[];
  observedAt: string;
  nodes: PanelNode[];
}

export interface PanelDeliveryAttempt {
  jobId: string;
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
  version: PanelVersionIdentity;
  waiting: PanelWaitProjection;
  evidence: PanelEvidenceRef[];
  observedAt: string;
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
  /** 已通过健康检查并切换的只读面板活动版本；与计数器 activeSha 分离。 */
  panelActiveSha: string | null;
  panelActiveObservedAt: string | null;
  requests: PanelRequest[];
  deliveryGroups: PanelDeliveryGroup[];
  deploy: PanelDeploy;
  nodes: PanelNode[];
}

export interface PanelMeta {
  observedAt: string;
  stateUpdatedAt: string | null;
  stateKind: PanelStateKind;
  controllerOnline: boolean;
  /** 来自已校验 panel-active.json 的当前活动版本；缺失时不得按计数器状态猜测。 */
  panelActiveSha?: string | null;
  panelActiveObservedAt?: string | null;
}

export const FLOW_NODES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'receive', label: '接收需求' },
  { id: 'docs-pr', label: '生成文档PR' },
  { id: 'docs-confirm', label: '文档人工确认' },
  { id: 'sync-task', label: '同步开发任务' },
  { id: 'code-verify', label: '编码与验证' },
  { id: 'code-confirm', label: '代码人工确认' },
  { id: 'build-deploy', label: '构建与部署' },
  { id: 'health-receipt', label: '健康检查与回执' },
];

const SHA40_RE = /^[0-9a-f]{40}$/;
const SHA64_RE = /^[0-9a-f]{64}$/;
const REQ_ID_RE = /^REQ-[A-Z0-9]+-[0-9]{2,}$/;
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const DISPATCH_REPO_ID_RE = /^(?:github-repository-id:)?[1-9][0-9]*$/;
const SPEC_PATH_RE = /^docs\/specs\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.md$/;
const MAX_TITLE = 200;

const KNOWN_SPEC_STAGES = new Set([
  'pi',
  'write',
  'commit',
  'push',
  'pr',
  'review',
  'pr-open',
  'pr-merged',
  'pr-closed',
  'failed',
  'stale',
]);
const KNOWN_JOB_STATUSES = new Set(['todo', 'processing', 'in-review', 'done', 'failed', 'satisfied']);
const KNOWN_FAILURE_STAGES = new Set([
  'plan',
  'write',
  'verify',
  'commit',
  'publish',
  'deploy',
  'sync-status-label',
  'remote-delivery-check',
  'sync-deploy-receipt',
  'retry-baseline',
  'retry-baseline-stale',
]);
const KNOWN_MERGE_STAGES = new Set(['confirmable', 'attempted', 'merged', 'failed', 'expired', 'invalidated', 'unknown']);
const KNOWN_MERGE_TYPES = new Set(['docs', 'code']);

const FAILURE_STAGE_LABELS: Record<string, string> = {
  plan: '规划',
  write: '编码',
  verify: '验证',
  commit: '提交',
  publish: '发布',
  deploy: '部署',
  'sync-status-label': '同步状态标签',
  'remote-delivery-check': '远端交付预检',
  'sync-deploy-receipt': '同步部署回执',
  'retry-baseline': '等待显式重试',
  'retry-baseline-stale': '重试准备已过期',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asPositiveInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return null;
  return value;
}

function asSha40(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return SHA40_RE.test(normalized) ? normalized : null;
}

function asSha64(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return SHA64_RE.test(normalized) ? normalized : null;
}

function safeTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const time = Date.parse(trimmed);
  if (!Number.isFinite(time)) return null;
  return new Date(time).toISOString();
}

function normalizeDeployReceipt(value: unknown): NormDeployReceipt | null {
  if (!isRecord(value)) return null;
  const issueNumber = asPositiveInt(value.issueNumber);
  const prNumber = asPositiveInt(value.prNumber);
  const mergeSha = asSha40(value.mergeSha);
  const commentId = asPositiveInt(value.commentId);
  const recordedAt = safeTimestamp(value.recordedAt);
  const dispatchRevision = value.dispatchRevision === undefined
    ? null
    : asPositiveInt(value.dispatchRevision);
  if (
    issueNumber === null
    || prNumber === null
    || !mergeSha
    || commentId === null
    || !recordedAt
    || (value.dispatchRevision !== undefined && dispatchRevision === null)
  ) {
    return null;
  }
  return { issueNumber, prNumber, dispatchRevision, mergeSha, commentId, recordedAt };
}

function shortSha(sha: string | null | undefined): string | null {
  if (typeof sha !== 'string') return null;
  const normalized = sha.trim().toLowerCase();
  if (!SHA40_RE.test(normalized) && !SHA64_RE.test(normalized)) return null;
  return normalized.slice(0, 8);
}

export function sanitizeRepo(repo: string | null | undefined): string | null {
  if (typeof repo !== 'string') return null;
  const trimmed = repo.trim();
  if (!REPO_RE.test(trimmed)) return null;
  return trimmed;
}

export function safeTitle(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null;
  const cleaned = text
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  const redactedText = redact(cleaned);
  return redactedText.length > MAX_TITLE ? `${redactedText.slice(0, MAX_TITLE)}…` : redactedText;
}

function safePrUrl(repo: string | null, prNumber: number | null): string | null {
  const cleanRepo = sanitizeRepo(repo);
  if (!cleanRepo || prNumber === null || !Number.isInteger(prNumber) || prNumber <= 0) return null;
  return `https://github.com/${cleanRepo}/pull/${prNumber}`;
}

function safeRequestId(requestId: unknown): string | null {
  if (typeof requestId !== 'string') return null;
  if (!SPEC_REQUEST_ID_RE.test(requestId)) return null;
  return requestId;
}

function safeReqId(reqId: unknown): string | null {
  if (typeof reqId !== 'string') return null;
  if (!REQ_ID_RE.test(reqId)) return null;
  return reqId;
}

function safeSpecPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (!SPEC_PATH_RE.test(value)) return null;
  if (value.split('/').includes('..')) return null;
  return value;
}

function normalizeDispatchObservation(value: unknown): PanelDispatchObservation | null {
  if (!isRecord(value)) return null;
  const state = value.state;
  const observedAt = safeTimestamp(value.observedAt);
  if (state !== 'awaiting-label' && state !== 'authorized' && state !== 'unverified') return null;
  if (!observedAt) return null;
  return { state, observedAt };
}

function requestStatus(stage: string): PanelStatus {
  switch (stage) {
    case 'pi':
    case 'write':
    case 'commit':
    case 'push':
    case 'pr':
      return 'running';
    case 'review':
    case 'pr-open':
      return 'waiting';
    case 'pr-merged':
      return 'succeeded';
    case 'pr-closed':
      return 'stale';
    case 'failed':
      return 'failed';
    case 'stale':
      return 'stale';
    default:
      return 'unknown';
  }
}

function jobStatus(status: string): PanelStatus {
  switch (status) {
    case 'todo':
      return 'pending';
    case 'processing':
      return 'running';
    case 'in-review':
      return 'waiting';
    case 'done':
      return 'succeeded';
    case 'satisfied':
      return 'succeeded';
    case 'failed':
      return 'failed';
    default:
      return 'unknown';
  }
}

interface NormRequirement {
  reqId: string;
  issueNumber: number;
  specHash: string;
  specPath: string | null;
  sourceMainSha: string;
}

interface NormJob {
  jobId: string;
  reqId: string;
  issueNumber: number;
  specHash: string;
  sourceMainSha: string;
  attempt: number;
  status: string;
  candidateTreeSha: string | null;
  failureStage: string | null;
  resumeAction: string | null;
  prNumber: number | null;
  headSHA: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  dispatchRevision: number | null;
  deployReceipt: NormDeployReceipt | null;
  deployReceiptInvalid: boolean;
}

interface NormDeployReceipt {
  issueNumber: number;
  prNumber: number;
  dispatchRevision: number | null;
  mergeSha: string;
  commentId: number;
  recordedAt: string;
}

interface NormRequest {
  requestId: string;
  targetReqId: string;
  stage: string;
  failureStage: string | null;
  prNumber: number | null;
  summary: string | null;
  mergedMainSha: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  docContent: string | null;
}

interface NormMerge {
  type: string;
  stage: string;
  prNumber: number | null;
  headSHA: string | null;
}

interface NormDeploy {
  activeSha: string | null;
  deployedPRs: number[];
  deployFailedPRs: number[];
}

interface NormDispatchRevision {
  reqId: string;
  repoId: string;
  revision: number;
  issueNumber: number;
  specHash: string;
  specPath: string;
  sourceMainSha: string;
  publishedAt: string | null;
  publicationCommentId: number | null;
  observation: PanelDispatchObservation | null;
  hasGrant: boolean;
  grantObservedAt: string | null;
}

interface NormState {
  schemaVersion: 1;
  repo: string | null;
  cursorMainSha: string | null;
  requirements: Record<string, NormRequirement>;
  jobs: NormJob[];
  deploy: NormDeploy;
  requests: NormRequest[];
  merges: NormMerge[];
  dispatchRevisions: Record<string, NormDispatchRevision[]>;
}

function positiveIntArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  const seen = new Set<number>();
  for (const item of value) {
    if (typeof item === 'number' && Number.isInteger(item) && item > 0 && !seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

function normalizeRequirement(reqId: unknown, value: unknown): NormRequirement | null {
  if (!isRecord(value)) return null;
  const cleanReqId = safeReqId(reqId);
  const issueNumber = asPositiveInt(value.issueNumber);
  const specHash = asSha64(value.specHash);
  const specPath = value.specPath === undefined ? null : safeSpecPath(value.specPath);
  const sourceMainSha = asSha40(value.sourceMainSha);
  if (
    !cleanReqId
    || issueNumber === null
    || !specHash
    || !sourceMainSha
    || (value.specPath !== undefined && specPath === null)
  ) {
    return null;
  }
  return { reqId: cleanReqId, issueNumber, specHash, specPath, sourceMainSha };
}

function normalizeJob(value: unknown): NormJob | null {
  if (!isRecord(value)) return null;
  const jobId = asString(value.jobId);
  const reqId = safeReqId(value.reqId);
  const issueNumber = asPositiveInt(value.issueNumber);
  const specHash = asSha64(value.specHash);
  const sourceMainSha = asSha40(value.sourceMainSha);
  const attempt = asPositiveInt(value.attempt);
  const status = asString(value.status);
  if (!jobId || !reqId || issueNumber === null || !specHash || !sourceMainSha || attempt === null || !status) {
    return null;
  }
  if (!KNOWN_JOB_STATUSES.has(status)) return null;
  const failureStageRaw = asString(value.failureStage);
  const resumeActionRaw = asString(value.resumeAction);
  const deployReceipt = value.deployReceipt === undefined ? null : normalizeDeployReceipt(value.deployReceipt);
  return {
    jobId,
    reqId,
    issueNumber,
    specHash,
    sourceMainSha,
    attempt,
    status,
    candidateTreeSha: asSha40(value.candidateTreeSha),
    failureStage: failureStageRaw && KNOWN_FAILURE_STAGES.has(failureStageRaw) ? failureStageRaw : null,
    resumeAction: resumeActionRaw === 'sync-deploy-receipt' || resumeActionRaw === 'sync-satisfied-receipt'
      || resumeActionRaw === 'retry-baseline' || resumeActionRaw === 'retry-baseline-stale'
      ? resumeActionRaw
      : null,
    prNumber: asPositiveInt(value.prNumber),
    headSHA: asSha40(value.headSHA),
    startedAt: safeTimestamp(value.startedAt),
    updatedAt: safeTimestamp(value.updatedAt),
    dispatchRevision: asPositiveInt(value.dispatchRevision),
    deployReceipt,
    deployReceiptInvalid: value.deployReceipt !== undefined && deployReceipt === null,
  };
}

function normalizeRequest(value: unknown): NormRequest | null {
  if (!isRecord(value)) return null;
  const requestId = safeRequestId(value.requestId);
  const targetReqId = safeReqId(value.targetReqId);
  const stageRaw = asString(value.stage);
  if (!requestId || !targetReqId || !stageRaw) return null;
  const stage = KNOWN_SPEC_STAGES.has(stageRaw) ? stageRaw : 'unknown';
  const failureStageRaw = asString(value.failureStage);
  return {
    requestId,
    targetReqId,
    stage,
    failureStage: failureStageRaw && KNOWN_SPEC_STAGES.has(failureStageRaw) ? failureStageRaw : null,
    prNumber: asPositiveInt(value.prNumber),
    summary: asString(value.summary),
    mergedMainSha: asSha40(value.mergedMainSha),
    createdAt: safeTimestamp(value.createdAt),
    updatedAt: safeTimestamp(value.updatedAt),
    docContent: asString(value.docContent),
  };
}

function normalizeMerge(value: unknown, repo: string | null): NormMerge | null {
  if (!isRecord(value)) return null;
  if (repo === null) return null;
  if (sanitizeRepo(asString(value.repo)) !== repo) return null;
  const type = asString(value.type);
  const stage = asString(value.stage);
  if (!type || !KNOWN_MERGE_TYPES.has(type) || !stage || !KNOWN_MERGE_STAGES.has(stage)) return null;
  return {
    type,
    stage,
    prNumber: asPositiveInt(value.prNumber),
    headSHA: asSha40(value.headSHA),
  };
}

function normalizeDispatchRevision(reqId: string, value: unknown): NormDispatchRevision | null {
  if (!isRecord(value)) return null;
  if (value.reqId !== reqId) return null;
  const repoId = asString(value.repoId);
  const revision = asPositiveInt(value.revision);
  const issueNumber = asPositiveInt(value.issueNumber);
  const specHash = asSha64(value.specHash);
  const specPath = safeSpecPath(value.specPath);
  const sourceMainSha = asSha40(value.sourceMainSha);
  if (
    !repoId
    || !DISPATCH_REPO_ID_RE.test(repoId)
    || revision === null
    || issueNumber === null
    || !specHash
    || !specPath
    || !sourceMainSha
    || !isRecord(value.task)
  ) {
    return null;
  }

  const publishedAt = value.publishedAt === undefined ? null : safeTimestamp(value.publishedAt);
  if (value.publishedAt !== undefined && publishedAt === null) return null;
  const publicationCommentId = value.publicationCommentId === undefined
    ? null
    : asPositiveInt(value.publicationCommentId);
  if (value.publicationCommentId !== undefined && publicationCommentId === null) return null;

  const observation = value.observation === undefined ? null : normalizeDispatchObservation(value.observation);
  if (value.observation !== undefined && observation === null) return null;

  let hasGrant = false;
  let grantObservedAt: string | null = null;
  if (value.grant !== undefined) {
    if (!isRecord(value.grant)) return null;
    const eventId = asPositiveInt(value.grant.eventId);
    const actorId = asString(value.grant.actorId);
    const grantedAt = safeTimestamp(value.grant.grantedAt);
    if (eventId === null || !actorId?.trim() || !grantedAt) return null;
    hasGrant = true;
    grantObservedAt = grantedAt;
  }

  return {
    reqId,
    repoId,
    revision,
    issueNumber,
    specHash,
    specPath,
    sourceMainSha,
    publishedAt,
    publicationCommentId,
    observation,
    hasGrant,
    grantObservedAt,
  };
}

function normalizeDeploy(value: unknown): NormDeploy {
  const rec = isRecord(value) ? value : {};
  return {
    activeSha: asSha40(rec.activeSha),
    deployedPRs: positiveIntArray(rec.deployedPRs),
    deployFailedPRs: positiveIntArray(rec.deployFailedPRs),
  };
}

export function normalizeState(raw: unknown): NormState | null {
  if (!isRecord(raw)) return null;
  if (raw.schemaVersion !== 1) return null;

  if (!isRecord(raw.requirements)) return null;
  if (!isRecord(raw.jobs)) return null;
  if (!isRecord(raw.specRequests)) return null;
  if (!isRecord(raw.deploy)) return null;
  if (raw.mergeRequests !== undefined && !isRecord(raw.mergeRequests)) return null;
  if (raw.dispatchRevisions !== undefined && !isRecord(raw.dispatchRevisions)) return null;

  // 任一容器元素为 null / 非对象，视为损坏状态，整体 invalid（前端保留旧快照），不静默过滤成空列表。
  for (const value of Object.values(raw.requirements)) if (!isRecord(value)) return null;
  for (const value of Object.values(raw.jobs)) if (!isRecord(value)) return null;
  for (const value of Object.values(raw.specRequests)) if (!isRecord(value)) return null;
  for (const value of Object.values(raw.mergeRequests ?? {})) if (!isRecord(value)) return null;
  for (const value of Object.values(raw.dispatchRevisions ?? {})) {
    if (!Array.isArray(value)) return null;
    for (const revision of value) if (!isRecord(revision)) return null;
  }

  const repo = sanitizeRepo(asString(raw.repo));

  const requirements: Record<string, NormRequirement> = Object.create(null);
  for (const [key, value] of Object.entries(raw.requirements)) {
    const item = normalizeRequirement(key, value);
    if (item) requirements[item.reqId] = item;
  }

  const jobs: NormJob[] = [];
  for (const value of Object.values(raw.jobs)) {
    const item = normalizeJob(value);
    if (item) jobs.push(item);
  }

  const requests: NormRequest[] = [];
  for (const value of Object.values(raw.specRequests)) {
    const item = normalizeRequest(value);
    if (item) requests.push(item);
  }

  const merges: NormMerge[] = [];
  for (const value of Object.values(raw.mergeRequests ?? {})) {
    const item = normalizeMerge(value, repo);
    if (item) merges.push(item);
  }

  const dispatchRevisions: Record<string, NormDispatchRevision[]> = Object.create(null);
  for (const [reqId, value] of Object.entries(raw.dispatchRevisions ?? {})) {
    if (!Array.isArray(value) || !safeReqId(reqId)) return null;
    const revisions: NormDispatchRevision[] = [];
    for (const rawRevision of value) {
      const item = normalizeDispatchRevision(reqId, rawRevision);
      if (!item) return null;
      revisions.push(item);
    }
    revisions.sort((left, right) => left.revision - right.revision);
    for (let index = 1; index < revisions.length; index += 1) {
      if (revisions[index]!.revision <= revisions[index - 1]!.revision) return null;
    }
    dispatchRevisions[reqId] = revisions;
  }

  return {
    schemaVersion: 1,
    repo,
    cursorMainSha: asSha40(asString(raw.cursorMainSha)),
    requirements,
    jobs,
    deploy: normalizeDeploy(raw.deploy),
    requests,
    merges,
    dispatchRevisions,
  };
}

export function parsePanelState(raw: string): { state: NormState | null; kind: PanelStateKind } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { state: null, kind: 'invalid' };
  }
  if (!isRecord(parsed)) return { state: null, kind: 'invalid' };
  if (parsed.schemaVersion !== 1) return { state: null, kind: 'unsupported' };
  const state = normalizeState(parsed);
  return { state, kind: state ? 'ok' : 'invalid' };
}

function trustedSpecPathForRequest(reqId: string): string | null {
  if (reqId === COUNTER_REQ_ID) return COUNTER_SPEC_PATH;
  if (reqId === PANEL_REQ_ID) return PANEL_SPEC_PATH;
  return null;
}

function uniqueGroupSpecPath(groups: GroupAcc[]): string | null {
  const paths = new Set(
    groups
      .map((group) => group.specPath)
      .filter((path): path is string => path !== null),
  );
  return paths.size === 1 ? [...paths][0]! : null;
}

function requestParseSpecPath(req: NormRequest, groups: GroupAcc[]): string | null {
  const matchedGroups = groups.filter(
    (group) =>
      group.reqId === req.targetReqId
      && (req.mergedMainSha === null || group.sourceMainSha === req.mergedMainSha),
  );
  return uniqueGroupSpecPath(matchedGroups) ?? trustedSpecPathForRequest(req.targetReqId);
}

function specHashForRequest(req: NormRequest, specPath: string | null): string | null {
  if (!req.docContent || specPath === null) return null;
  try {
    const parsed = parseSpecs({ [specPath]: req.docContent });
    if (parsed.errors.length > 0) return null;
    const spec = parsed.specs.find((s) => s.id === req.targetReqId);
    return spec ? spec.hash : null;
  } catch {
    return null;
  }
}

function groupId(reqId: string, specHash: string, sourceMainSha: string, revision: number | null = null): string {
  const identity = revision === null
    ? `${reqId}\n${specHash}\n${sourceMainSha}`
    : `${reqId}\n${specHash}\n${sourceMainSha}\nr${revision}`;
  return createHash('sha256').update(identity).digest('hex').slice(0, 16);
}

function failureStageLabel(stage: string | null): string | null {
  if (!stage) return null;
  return FAILURE_STAGE_LABELS[stage] ?? null;
}

function codeVerifyStatus(job: NormJob): PanelStatus {
  if (job.status === 'todo') return 'pending';
  if (job.status === 'processing') return 'running';
  if (job.status === 'in-review' || job.status === 'done') return 'succeeded';
  if (job.status === 'satisfied') return 'succeeded';
  if (job.status === 'failed') {
    if (job.failureStage && ['plan', 'write', 'verify'].includes(job.failureStage)) return 'failed';
    if (job.failureStage && ['commit', 'publish'].includes(job.failureStage)) return 'succeeded';
    return 'unknown';
  }
  return 'unknown';
}

function codeConfirmDetail(status: PanelStatus, prNumber: number | null): string {
  switch (status) {
    case 'succeeded':
      return '已合并';
    case 'waiting':
      return prNumber !== null ? `等待人工确认代码 PR #${prNumber}` : '等待人工确认';
    case 'unknown':
      return '结果未知';
    case 'failed':
      return '合并失败';
    case 'pending':
      return '尚未执行';
    default:
      return '代码 PR 未确认';
  }
}

function codeMergedEvidence(merges: NormMerge[], job: NormJob | undefined, deploy: NormDeploy): 'merged' | 'unknown' | false {
  if (!job) return false;
  // 已存在对应 PR 的部署（成功或失败）是更强的后续证据，优先于旧 unknown merge 记录。
  if (deploy.deployedPRs.includes(job.prNumber ?? -1) || deploy.deployFailedPRs.includes(job.prNumber ?? -1)) {
    return 'merged';
  }
  let hasUnknown = false;
  for (const merge of merges) {
    if (merge.type !== 'code' || merge.prNumber !== job.prNumber) continue;
    if (!merge.headSHA || !job.headSHA || merge.headSHA !== job.headSHA) continue;
    if (merge.stage === 'merged') {
      return 'merged';
    }
    if (merge.stage === 'unknown') hasUnknown = true;
  }
  if (hasUnknown) return 'unknown';
  return false;
}

function markCurrent(nodes: PanelNode[]): PanelNode[] {
  let currentIndex = -1;
  for (let i = 0; i < nodes.length; i += 1) {
    const status = nodes[i]!.status;
    if (status === 'running' || status === 'waiting' || status === 'failed') {
      currentIndex = i;
      break;
    }
  }
  if (currentIndex < 0) {
    const lastSucceeded = nodes.map((n) => n.status).lastIndexOf('succeeded');
    currentIndex = lastSucceeded >= 0 ? lastSucceeded : 0;
  }
  return nodes.map((node, index) => ({ ...node, current: index === currentIndex }));
}

function emptyNodes(detail = '暂无数据'): PanelNode[] {
  return FLOW_NODES.map((node) => ({ id: node.id, label: node.label, status: 'pending', current: false, detail }));
}

interface FlowInput {
  req: NormRequest | null;
  requirement: NormRequirement | null;
  jobs: NormJob[];
  deploy: NormDeploy;
  merges: NormMerge[];
}

function computeNodes(input: FlowInput): PanelNode[] {
  const { req, requirement, jobs, deploy, merges } = input;
  const primary = jobs.reduce<NormJob | undefined>(
    (latest, job) =>
      !latest || job.attempt > latest.attempt || (job.attempt === latest.attempt && job.status !== 'failed')
        ? job
        : latest,
    undefined,
  );

  const stage = req?.stage ?? 'unknown';
  const prNumber = req?.prNumber ?? null;

  const nodes: PanelNode[] = [
    {
      id: 'receive',
      label: '接收需求',
      status: req ? 'succeeded' : 'unknown',
      current: false,
      detail: req ? `请求 ${req.requestId.slice(0, 8)}` : '无文档请求记录',
    },
  ];

  const docGenerated =
    prNumber !== null || ['pr-open', 'pr-merged', 'pr-closed', 'review'].includes(stage);
  nodes.push({
    id: 'docs-pr',
    label: '生成文档PR',
    status: docGenerated ? 'succeeded' : stage === 'failed' ? 'failed' : stage === 'stale' ? 'stale' : req ? 'running' : 'unknown',
    current: false,
    detail: prNumber !== null ? `文档 PR #${prNumber}` : '文档 PR 尚未生成',
  });

  let docsConfirm: PanelStatus = 'unknown';
  if (stage === 'pr-open' || stage === 'review') docsConfirm = 'waiting';
  else if (stage === 'pr-merged') docsConfirm = 'succeeded';
  else if (stage === 'pr-closed' || stage === 'stale') docsConfirm = 'stale';
  else if (stage === 'failed') docsConfirm = 'pending';
  else if (req) docsConfirm = 'pending';
  nodes.push({
    id: 'docs-confirm',
    label: '文档人工确认',
    status: docsConfirm,
    current: false,
    detail: stage === 'pr-open' ? '等待人工合并文档 PR' : stage === 'pr-merged' ? '文档 PR 已合并' : '文档 PR 未确认',
  });

  const taskSynced = jobs.length > 0 || requirement !== null;
  const issueNumber = primary?.issueNumber ?? requirement?.issueNumber ?? null;
  nodes.push({
    id: 'sync-task',
    label: '同步开发任务',
    status: taskSynced ? 'succeeded' : stage === 'pr-merged' ? 'running' : req ? 'pending' : 'unknown',
    current: false,
    detail: issueNumber !== null ? `任务 #${issueNumber}` : '开发任务尚未同步',
  });

  nodes.push({
    id: 'code-verify',
    label: '编码与验证',
    status: primary ? codeVerifyStatus(primary) : requirement ? 'pending' : 'unknown',
    current: false,
    detail: primary ? `attempt ${primary.attempt}` : '尚无代码交付',
  });

  const mergedEvidence = codeMergedEvidence(merges, primary, deploy);
  let codeConfirm: PanelStatus = 'unknown';
  if (!primary) {
    codeConfirm = requirement || jobs.length > 0 ? 'pending' : 'unknown';
  } else if (mergedEvidence === 'merged') {
    codeConfirm = 'succeeded';
  } else if (mergedEvidence === 'unknown') {
    codeConfirm = 'unknown';
  } else if (primary.status === 'satisfied') {
    codeConfirm = primary.resumeAction === 'sync-satisfied-receipt' ? 'waiting' : 'succeeded';
  } else if (primary.status === 'in-review') {
    codeConfirm = 'waiting';
  } else if (primary.status === 'failed' && primary.failureStage && ['commit', 'publish'].includes(primary.failureStage)) {
    codeConfirm = 'failed';
  } else if (primary.status === 'failed') {
    codeConfirm = 'pending';
  } else {
    codeConfirm = 'pending';
  }
  nodes.push({
    id: 'code-confirm',
    label: '代码人工确认',
    status: codeConfirm,
    current: false,
    detail: primary?.status === 'satisfied'
      ? primary.resumeAction === 'sync-satisfied-receipt'
        ? '已验收无需代码变更；GitHub 回执待补'
        : '已验收无需代码变更，无代码 PR'
      : codeConfirmDetail(codeConfirm, primary?.prNumber ?? null),
  });

  const primaryPr = primary?.prNumber ?? null;
  let buildDeploy: PanelStatus = 'pending';
  if (deploy.deployedPRs.includes(primaryPr ?? -1)) buildDeploy = 'succeeded';
  else if (deploy.deployFailedPRs.includes(primaryPr ?? -1)) buildDeploy = 'failed';
  else if (mergedEvidence === 'merged') buildDeploy = 'running';
  else if (!primary) buildDeploy = 'unknown';
  nodes.push({
    id: 'build-deploy',
    label: '构建与部署',
    status: buildDeploy,
    current: false,
    detail: primary?.status === 'satisfied'
      ? '无需部署（源码已满足需求）'
      : deploy.deployedPRs.includes(primaryPr ?? -1)
        ? '已本地部署'
        : deploy.deployFailedPRs.includes(primaryPr ?? -1)
          ? '部署失败'
          : '未部署',
  });

  let healthReceipt: PanelStatus = 'pending';
  if (deploy.deployedPRs.includes(primaryPr ?? -1)) {
    healthReceipt = primary && primary.resumeAction === 'sync-deploy-receipt' ? 'waiting' : 'succeeded';
  } else if (deploy.deployFailedPRs.includes(primaryPr ?? -1)) {
    healthReceipt = 'pending';
  } else if (!primary) {
    healthReceipt = 'unknown';
  }
  nodes.push({
    id: 'health-receipt',
    label: '健康检查与回执',
    status: healthReceipt,
    current: false,
    detail: primary?.status === 'satisfied'
      ? primary.resumeAction === 'sync-satisfied-receipt'
        ? '无需部署；GitHub 回执待补'
        : '无需部署回执'
      : deploy.deployedPRs.includes(primaryPr ?? -1)
      ? healthReceipt === 'waiting'
        ? '部署成功，回执待补'
        : '健康检查与回执完成'
      : deploy.deployFailedPRs.includes(primaryPr ?? -1)
        ? '依赖构建与部署（已失败）'
        : '未执行',
  });

  return markCurrent(nodes);
}

interface GroupAcc {
  reqId: string;
  specHash: string;
  sourceMainSha: string;
  specPath: string | null;
  issueNumber: number;
  revision: number | null;
  dispatch: NormDispatchRevision | null;
  conflict: boolean;
  jobs: NormJob[];
}

type TaskRegistration = 'registered' | 'absent' | 'unknown';

function taskRegistrationForView(input: {
  dispatch: NormDispatchRevision | null;
  jobs: NormJob[];
  requirementMatched: boolean;
}): TaskRegistration {
  if (
    input.dispatch !== null
    && (input.dispatch.publishedAt === null || input.dispatch.publicationCommentId === null)
  ) {
    return 'absent';
  }
  if (input.dispatch !== null || input.jobs.length > 0 || input.requirementMatched) {
    return 'registered';
  }
  return 'unknown';
}

function versionGroupKey(reqId: string, specHash: string, sourceMainSha: string, revision: number | null): string {
  return `${reqId}|${specHash}|${sourceMainSha}|${revision === null ? 'legacy' : `r${revision}`}`;
}

function groupJobs(state: NormState): GroupAcc[] {
  const groups = new Map<string, GroupAcc>();

  const addGroup = (value: Omit<GroupAcc, 'jobs' | 'conflict'>): GroupAcc => {
    const key = versionGroupKey(value.reqId, value.specHash, value.sourceMainSha, value.revision);
    const existing = groups.get(key);
    if (existing) return existing;
    const created: GroupAcc = { ...value, conflict: false, jobs: [] };
    groups.set(key, created);
    return created;
  };

  for (const [reqId, revisions] of Object.entries(state.dispatchRevisions)) {
    for (const revision of revisions) {
      addGroup({
        reqId,
        specHash: revision.specHash,
        sourceMainSha: revision.sourceMainSha,
        specPath: revision.specPath,
        issueNumber: revision.issueNumber,
        revision: revision.revision,
        dispatch: revision,
      });
    }
  }

  for (const job of Object.values(state.jobs)) {
    let dispatch: NormDispatchRevision | null = null;
    let revision = job.dispatchRevision;
    let conflict = false;

    if (revision !== null) {
      dispatch = state.dispatchRevisions[job.reqId]?.find((item) => item.revision === revision) ?? null;
      if (!dispatch) {
        conflict = true;
      } else if (
        dispatch.issueNumber !== job.issueNumber
        || dispatch.specHash !== job.specHash
        || dispatch.sourceMainSha !== job.sourceMainSha
      ) {
        conflict = true;
      }
    } else {
      const candidates = (state.dispatchRevisions[job.reqId] ?? []).filter(
        (item) => item.specHash === job.specHash && item.sourceMainSha === job.sourceMainSha,
      );
      if (candidates.length === 1) {
        dispatch = candidates[0]!;
        revision = dispatch.revision;
      } else if (candidates.length > 1) {
        // 旧作业没有 revision 绑定，且同 hash/SHA 已存在多个冻结版本时不能猜归属。
        revision = null;
        conflict = true;
      }
    }

    const matchingRequirement = state.requirements[job.reqId];
    const requirementSpecPath = matchingRequirement
      && matchingRequirement.specHash === job.specHash
      && matchingRequirement.sourceMainSha === job.sourceMainSha
      ? matchingRequirement.specPath
      : null;
    const group = addGroup({
      reqId: job.reqId,
      specHash: job.specHash,
      sourceMainSha: job.sourceMainSha,
      specPath: dispatch?.specPath ?? requirementSpecPath,
      issueNumber: dispatch?.issueNumber ?? job.issueNumber,
      revision,
      dispatch,
    });
    if (conflict) group.conflict = true;
    if (job.deployReceiptInvalid) group.conflict = true;
    group.jobs.push(job);
  }

  // 已登记但尚无派工历史的旧数据仍要可见；新派工数据已由 dispatchRevisions 提供零作业版本。
  for (const [reqId, requirement] of Object.entries(state.requirements)) {
    if ((state.dispatchRevisions[reqId]?.length ?? 0) > 0) continue;
    const key = versionGroupKey(reqId, requirement.specHash, requirement.sourceMainSha, null);
    if (groups.has(key)) continue;
    addGroup({
      reqId,
      specHash: requirement.specHash,
      sourceMainSha: requirement.sourceMainSha,
      specPath: requirement.specPath,
      issueNumber: requirement.issueNumber,
      revision: null,
      dispatch: null,
    });
  }

  return [...groups.values()].map((group) => ({
    ...group,
    jobs: group.jobs.sort(
      (left, right) =>
        left.attempt - right.attempt
        || (left.updatedAt ?? '').localeCompare(right.updatedAt ?? '')
        || left.jobId.localeCompare(right.jobId),
    ),
  }));
}

function deployStatusOf(deploy: NormDeploy, prNumber: number | null, resumeAction: string | null): DeliveryDeployStatus {
  if (deploy.deployedPRs.includes(prNumber ?? -1)) {
    return resumeAction === 'sync-deploy-receipt' ? 'receipt-pending' : 'deployed';
  }
  if (deploy.deployFailedPRs.includes(prNumber ?? -1)) return 'deploy-failed';
  return 'none';
}

function safeIssueUrl(repo: string | null, issueNumber: number | null): string | null {
  const cleanRepo = sanitizeRepo(repo);
  if (!cleanRepo || issueNumber === null || issueNumber <= 0) return null;
  return `https://github.com/${cleanRepo}/issues/${issueNumber}`;
}

function safeCommitUrl(repo: string | null, sha: string | null): string | null {
  const cleanRepo = sanitizeRepo(repo);
  if (!cleanRepo || !sha) return null;
  return `https://github.com/${cleanRepo}/commit/${sha}`;
}

interface DeploymentReceiptProjection {
  href: string | null;
  conflict: boolean;
}

/**
 * 部署回执只有在同一 job、Issue、PR、派工版本与当前成功部署的 merge SHA
 * 全部吻合时才能成为本版证据。历史快照的缺记录保持“待核实”，错版记录
 * 进入冲突分支，不能退化成其他版本的完成结论。
 */
function projectDeploymentReceipt(
  state: NormState,
  meta: PanelMeta,
  group: GroupAcc,
  job: NormJob | undefined,
): DeploymentReceiptProjection {
  if (job?.deployReceiptInvalid) return { href: null, conflict: true };
  const receipt = job?.deployReceipt;
  if (!job || !receipt) return { href: null, conflict: false };

  const expectedRevision = job.dispatchRevision ?? group.revision;
  const latestRevision = (state.dispatchRevisions[group.reqId] ?? []).at(-1)?.revision ?? null;
  const currentRequirement = state.requirements[group.reqId];
  const isCurrentVersion = group.revision === null
    ? currentRequirement?.specHash === group.specHash
      && currentRequirement.sourceMainSha === group.sourceMainSha
    : group.revision === latestRevision;
  const activeSha = group.reqId === PANEL_REQ_ID
    ? asSha40(meta.panelActiveSha)
    : state.deploy.activeSha;
  const issueUrl = safeIssueUrl(state.repo, group.issueNumber);
  const sameJobBinding =
    job.status === 'done'
    && job.issueNumber === group.issueNumber
    && receipt.issueNumber === job.issueNumber
    && job.prNumber !== null
    && receipt.prNumber === job.prNumber
    && expectedRevision === receipt.dispatchRevision
    && state.deploy.deployedPRs.includes(receipt.prNumber)
    && (!isCurrentVersion || activeSha === receipt.mergeSha)
    && (job.startedAt === null || receipt.recordedAt >= job.startedAt);
  if (!sameJobBinding || issueUrl === null) return { href: null, conflict: true };
  return {
    href: `${issueUrl}#issuecomment-${receipt.commentId}`,
    conflict: false,
  };
}

function latestTimestamp(values: Array<string | null | undefined>): string | null {
  let latest: string | null = null;
  for (const value of values) {
    if (value && (!latest || value > latest)) latest = value;
  }
  return latest;
}

function evidenceLabel(value: string): string {
  return safeTitle(value) ?? '状态记录';
}

function evidenceRef(
  kind: PanelEvidenceRef['kind'],
  label: string,
  href: string | null,
  observedAt: string | null,
): PanelEvidenceRef {
  return { kind, label: evidenceLabel(label), href, observedAt };
}

function uniqueEvidence(refs: PanelEvidenceRef[]): PanelEvidenceRef[] {
  const seen = new Set<string>();
  const result: PanelEvidenceRef[] = [];
  for (const ref of refs) {
    const key = `${ref.kind}\n${ref.label}\n${ref.href ?? ''}\n${ref.observedAt ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(ref);
  }
  return result;
}

function versionIdentity(input: {
  reqId: string;
  specPath: string | null;
  specHash: string | null;
  sourceMainSha: string | null;
  revision: number | null;
  issueNumber: number | null;
  documentRequestId: string | null;
  documentPrNumber: number | null;
}): PanelVersionIdentity {
  return { ...input };
}

function requestWaitObservedAt(req: NormRequest, meta: PanelMeta): string {
  return latestTimestamp([req.updatedAt, req.createdAt, meta.stateUpdatedAt]) ?? meta.observedAt;
}

function groupWaitObservedAt(input: {
  group: GroupAcc;
  linkedRequest: NormRequest | null;
  meta: PanelMeta;
}): string {
  const { group, linkedRequest, meta } = input;
  return latestTimestamp([
    group.dispatch?.observation?.observedAt,
    group.dispatch?.publishedAt,
    group.dispatch?.grantObservedAt,
    linkedRequest?.updatedAt,
    ...group.jobs.flatMap((job) => [job.updatedAt, job.startedAt]),
    meta.stateUpdatedAt,
  ]) ?? meta.observedAt;
}

function primaryJobForGroup(group: GroupAcc): NormJob | undefined {
  return group.jobs.reduce<NormJob | undefined>((primary, job) => {
    if (!primary) return job;
    if (job.attempt > primary.attempt) return job;
    if (job.attempt === primary.attempt && (job.updatedAt ?? '') >= (primary.updatedAt ?? '')) return job;
    return primary;
  }, undefined);
}

function waitRevisionOf(group: GroupAcc): PanelWaitRevision | null {
  const dispatch = group.dispatch;
  if (!dispatch) return null;
  return {
    revision: dispatch.revision,
    publishedAt: dispatch.publishedAt,
    publicationCommentId: dispatch.publicationCommentId,
    observation: dispatch.observation,
    hasGrant: dispatch.hasGrant,
  };
}

function waitPrimaryJob(job: NormJob | undefined): PanelWaitPrimaryJob | null {
  if (!job) return null;
  return {
    status: job.status,
    failureStage: job.failureStage,
    resumeAction: job.resumeAction,
    prNumber: job.prNumber,
    updatedAt: job.updatedAt,
  };
}

function hasActiveOtherJob(state: NormState, currentRevision: number | null, reqId: string): boolean {
  return Object.values(state.jobs).some((job) => {
    if (job.status !== 'todo' && job.status !== 'processing') return false;
    return job.reqId !== reqId || currentRevision === null || job.dispatchRevision !== currentRevision;
  });
}

function requestEvidence(input: {
  req: NormRequest;
  reqDocHash: string | null;
  repo: string | null;
}): PanelEvidenceRef[] {
  const { req, reqDocHash, repo } = input;
  return uniqueEvidence([
    evidenceRef(
      'spec-request',
      `文档请求 ${req.requestId.slice(0, 8)} · ${req.stage}`,
      safePrUrl(repo, req.prNumber),
      req.updatedAt ?? req.createdAt,
    ),
    ...(req.prNumber === null ? [] : [
      evidenceRef('document-pr', `文档 PR #${req.prNumber}`, safePrUrl(repo, req.prNumber), req.updatedAt),
    ]),
    ...(req.mergedMainSha === null ? [] : [
      evidenceRef(
        'document-merge',
        `文档合并 ${req.mergedMainSha.slice(0, 8)}`,
        safeCommitUrl(repo, req.mergedMainSha),
        req.updatedAt,
      ),
    ]),
    ...(reqDocHash === null ? [] : [
      evidenceRef('spec-request', `需求哈希 ${reqDocHash.slice(0, 8)}`, null, req.updatedAt),
    ]),
  ]);
}

function groupEvidence(input: {
  state: NormState;
  meta: PanelMeta;
  group: GroupAcc;
  linkedRequest: NormRequest | null;
  primaryJob: NormJob | undefined;
}): PanelEvidenceRef[] {
  const { state, meta, group, linkedRequest, primaryJob } = input;
  const issueUrl = safeIssueUrl(state.repo, group.issueNumber);
  const deploymentReceipt = projectDeploymentReceipt(state, meta, group, primaryJob);
  const publicationUrl = issueUrl && group.dispatch?.publicationCommentId
    ? `${issueUrl}#issuecomment-${group.dispatch.publicationCommentId}`
    : issueUrl;
  const publicationComplete =
    group.dispatch !== null
    && group.dispatch.publishedAt !== null
    && group.dispatch.publicationCommentId !== null;
  const testRunIdentity = [
    group.revision === null ? null : `r${group.revision}`,
    group.specPath,
  ].filter((part): part is string => part !== null);
  const testRunLabel = testRunIdentity.length > 0
    ? `${testRunIdentity.join(' · ')}（按 job ${primaryJob?.jobId.slice(0, 12) ?? ''} 筛选）`
    : '规格路径与派工版本未知，需按作业记录核实';
  const testRunQueryParams: Record<string, string> = {
    jobId: primaryJob?.jobId ?? '',
    reqId: primaryJob?.reqId ?? '',
    specHash: primaryJob?.specHash ?? '',
    sourceMainSha: primaryJob?.sourceMainSha ?? '',
    ...(primaryJob?.candidateTreeSha === null || primaryJob?.candidateTreeSha === undefined
      ? {}
      : { candidateTreeSha: primaryJob.candidateTreeSha }),
    ...(group.specPath === null ? {} : { specPath: group.specPath }),
    ...(group.revision === null ? {} : { dispatchRevision: String(group.revision) }),
  };
  const testRunQuery = primaryJob === undefined
    ? null
    : new URLSearchParams(testRunQueryParams).toString();
  return uniqueEvidence([
    evidenceRef('issue', `任务 Issue #${group.issueNumber}`, issueUrl, latestTimestamp([
      group.dispatch?.observation?.observedAt,
      group.dispatch?.publishedAt,
    ])),
    ...(group.revision === null ? [] : [
      evidenceRef(
        'dispatch-publication',
        publicationComplete
          ? `派工版本 r${group.revision}`
          : `冻结派工版本 r${group.revision} · 发布评论未回读`,
        publicationComplete ? publicationUrl : null,
        publicationComplete ? group.dispatch?.publishedAt ?? null : null,
      ),
    ]),
    ...(group.dispatch?.observation === undefined || group.dispatch?.observation === null ? [] : [
      evidenceRef(
        'dispatch-grant',
        `许可观察 ${group.dispatch.observation.state}`,
        issueUrl,
        group.dispatch.observation.observedAt,
      ),
    ]),
    ...(primaryJob === undefined ? [] : [
      evidenceRef(
        'job',
        `作业 attempt ${primaryJob.attempt} · ${primaryJob.status}`,
        null,
        primaryJob.updatedAt,
      ),
    ]),
    ...(deploymentReceipt.href === null || primaryJob?.deployReceipt === null || primaryJob?.deployReceipt === undefined
      ? []
      : [
          evidenceRef(
            'deployment',
            `本版部署回执 · Issue #${primaryJob.deployReceipt.issueNumber}`,
            deploymentReceipt.href,
            primaryJob.deployReceipt.recordedAt,
          ),
        ]),
    ...group.jobs.flatMap((job) => job.prNumber === null ? [] : [
      evidenceRef(
        'code-pr',
        `代码 PR #${job.prNumber} · attempt ${job.attempt}`,
        safePrUrl(state.repo, job.prNumber),
        job.updatedAt,
      ),
    ]),
    ...(primaryJob?.failureStage === 'verify' && testRunQuery ? [
      evidenceRef(
        'test-runs',
        `本版验收记录 · ${testRunLabel}`,
        `/api/test-runs?${testRunQuery}`,
        primaryJob.updatedAt,
      ),
    ] : []),
    ...(primaryJob?.status === 'satisfied' && testRunQuery ? [
      evidenceRef(
        'test-runs',
        `本版无变更验收记录 · ${testRunLabel}`,
        `/api/test-runs?${testRunQuery}`,
        primaryJob.updatedAt,
      ),
    ] : []),
    ...(linkedRequest === null ? [] : requestEvidence({
      req: linkedRequest,
      reqDocHash: linkedRequest.docContent ? specHashForRequest(linkedRequest, group.specPath) : null,
      repo: state.repo,
    })),
  ]);
}

export function buildPanelView(state: NormState | null, meta: PanelMeta): PanelView {
  const deploy: PanelDeploy = state
    ? {
        activeSha: shortSha(state.deploy.activeSha),
        deployedPRs: state.deploy.deployedPRs,
        deployFailedPRs: state.deploy.deployFailedPRs,
      }
    : { activeSha: null, deployedPRs: [], deployFailedPRs: [] };

  if (!state) {
    return {
      schemaVersion: 'panel/v1',
      observedAt: meta.observedAt,
      stateUpdatedAt: meta.stateUpdatedAt,
      stateKind: meta.stateKind,
      repo: null,
      controllerOnline: meta.controllerOnline,
      cursorMainSha: null,
      panelActiveSha: null,
      panelActiveObservedAt: null,
      requests: [],
      deliveryGroups: [],
      deploy,
      nodes: emptyNodes(),
    };
  }

  const repo = sanitizeRepo(state.repo);
  const requirements = state.requirements;
  const merges = state.merges;

  const requests = [...state.requests].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  const groups = groupJobs(state).sort(
    (left, right) =>
      left.reqId.localeCompare(right.reqId)
      || (right.revision ?? 0) - (left.revision ?? 0)
      || left.specHash.localeCompare(right.specHash)
      || left.sourceMainSha.localeCompare(right.sourceMainSha),
  );
  const docHashByRequest = new Map<string, string | null>();
  const requestSpecPathByRequest = new Map<string, string | null>();
  for (const req of requests) {
    const specPath = requestParseSpecPath(req, groups);
    requestSpecPathByRequest.set(req.requestId, specPath);
    docHashByRequest.set(req.requestId, specHashForRequest(req, specPath));
  }
  const linkByGroupKey = new Map<string, { basis: LinkBasis; requestId: string | null }>();
  const ambiguousRequestIds = new Set<string>();
  const exactRequestsByGroup = new Map<string, NormRequest[]>();
  const hashFallbackRequestsByGroup = new Map<string, NormRequest[]>();

  // 先按合并主线 SHA 找唯一候选，再检查文档 hash。缺少文档证据必须保留为
  // unconfirmed；不能因为过滤条件未命中而退化成“没有关联”。
  for (const req of requests) {
    if (req.stage !== 'pr-merged' || req.mergedMainSha === null) continue;
    const exactGroups = groups.filter(
      (group) => group.reqId === req.targetReqId && req.mergedMainSha === group.sourceMainSha,
    );
    if (exactGroups.length > 1) {
      // 相同 SHA/hash 的 r1、r2 不能被同一条请求同时认领。
      ambiguousRequestIds.add(req.requestId);
      for (const group of exactGroups) {
        linkByGroupKey.set(
          versionGroupKey(group.reqId, group.specHash, group.sourceMainSha, group.revision),
          { basis: 'unconfirmed', requestId: null },
        );
      }
    } else if (exactGroups.length === 1) {
      const group = exactGroups[0]!;
      const groupKey = versionGroupKey(group.reqId, group.specHash, group.sourceMainSha, group.revision);
      const list = exactRequestsByGroup.get(groupKey) ?? [];
      list.push(req);
      exactRequestsByGroup.set(groupKey, list);
    }
  }

  for (const [groupKey, exactRequests] of exactRequestsByGroup) {
    const group = groups.find(
      (candidate) =>
        versionGroupKey(candidate.reqId, candidate.specHash, candidate.sourceMainSha, candidate.revision)
        === groupKey,
    )!;
    if (exactRequests.length !== 1 || docHashByRequest.get(exactRequests[0]!.requestId) !== group.specHash) {
      for (const req of exactRequests) ambiguousRequestIds.add(req.requestId);
      linkByGroupKey.set(groupKey, { basis: 'unconfirmed', requestId: null });
    } else {
      linkByGroupKey.set(groupKey, { basis: 'exact', requestId: exactRequests[0]!.requestId });
    }
  }

  // 没有记录合并 SHA 的旧请求只能用 hash + 时间顺序回退。先确认该请求只命中
  // 一个版本组，再确认该组只被一个请求命中，避免同 hash 的 r1/r2 相互覆盖。
  for (const req of requests) {
    if (req.stage !== 'pr-merged' || req.mergedMainSha !== null) continue;
    const hashFallback = groups.filter(
      (group) =>
        group.reqId === req.targetReqId
        && docHashByRequest.get(req.requestId) === group.specHash,
    );
    if (hashFallback.length === 0) continue;
    if (hashFallback.length > 1) {
      ambiguousRequestIds.add(req.requestId);
      for (const group of hashFallback) {
        const groupKey = versionGroupKey(group.reqId, group.specHash, group.sourceMainSha, group.revision);
        if (!linkByGroupKey.has(groupKey)) {
          linkByGroupKey.set(groupKey, { basis: 'unconfirmed', requestId: null });
        }
      }
      continue;
    }
    const group = hashFallback[0]!;
    const groupKey = versionGroupKey(group.reqId, group.specHash, group.sourceMainSha, group.revision);
    const list = hashFallbackRequestsByGroup.get(groupKey) ?? [];
    list.push(req);
    hashFallbackRequestsByGroup.set(groupKey, list);
  }

  for (const [groupKey, fallbackRequests] of hashFallbackRequestsByGroup) {
    if (linkByGroupKey.has(groupKey)) continue;
    const group = groups.find(
      (candidate) =>
        versionGroupKey(candidate.reqId, candidate.specHash, candidate.sourceMainSha, candidate.revision)
        === groupKey,
    )!;
    if (fallbackRequests.length !== 1) {
      for (const req of fallbackRequests) ambiguousRequestIds.add(req.requestId);
      linkByGroupKey.set(groupKey, { basis: 'unconfirmed', requestId: null });
      continue;
    }
    const req = fallbackRequests[0]!;
    const created = req.createdAt;
    const started = primaryJobForGroup(group)?.startedAt ?? group.dispatch?.publishedAt ?? null;
    if (created && started && started >= created) {
      linkByGroupKey.set(groupKey, { basis: 'hash-only', requestId: req.requestId });
    } else {
      ambiguousRequestIds.add(req.requestId);
      linkByGroupKey.set(groupKey, { basis: 'unconfirmed', requestId: null });
    }
  }

  const requestById = new Map(requests.map((req) => [req.requestId, req]));
  const requestIdsByGroup = new Map<string, string | null>();
  for (const group of groups) {
    const key = versionGroupKey(group.reqId, group.specHash, group.sourceMainSha, group.revision);
    requestIdsByGroup.set(key, linkByGroupKey.get(key)?.requestId ?? null);
  }

  const deliveryGroups: PanelDeliveryGroup[] = groups.map((group) => {
    const groupKey = versionGroupKey(group.reqId, group.specHash, group.sourceMainSha, group.revision);
    const link = linkByGroupKey.get(groupKey) ?? {
      basis: 'none',
      requestId: null,
    };
    const currentReq = requirements[group.reqId];
    const latestRevision = (state.dispatchRevisions[group.reqId] ?? []).at(-1)?.revision ?? null;
    const superseded = group.revision !== null
      ? latestRevision !== null && group.revision !== latestRevision
      : currentReq
        ? currentReq.specHash !== group.specHash || currentReq.sourceMainSha !== group.sourceMainSha
        : false;
    const primary = primaryJobForGroup(group);
    const linkedRequest = link.requestId ? requestById.get(link.requestId) ?? null : null;
    const deploymentReceipt = projectDeploymentReceipt(state, meta, group, primary);

    const flowInput: FlowInput = {
      req: linkedRequest,
      requirement: currentReq && currentReq.sourceMainSha === group.sourceMainSha ? currentReq : null,
      jobs: group.jobs,
      deploy: state.deploy,
      merges,
    };
    const nodes = computeNodes(flowInput);

    const attempts: PanelDeliveryAttempt[] = group.jobs.map((job) => ({
      jobId: job.jobId,
      attempt: job.attempt,
      status: jobStatus(job.status),
      failureStage: failureStageLabel(job.failureStage),
      prNumber: job.prNumber,
      prUrl: safePrUrl(state.repo, job.prNumber),
      issueNumber: job.issueNumber,
      isLatest: job.attempt === (primary?.attempt ?? 0),
      deployStatus: deployStatusOf(state.deploy, job.prNumber, job.resumeAction),
      startedAt: job.startedAt,
      updatedAt: job.updatedAt,
    }));

    const latestUpdatedAt = group.jobs.reduce<string | null>((latest, job) => {
      if (!job.updatedAt) return latest;
      if (!latest || job.updatedAt > latest) return job.updatedAt;
      return latest;
    }, null);
    const observedAt = groupWaitObservedAt({ group, linkedRequest, meta });
    const waiting = projectPanelWait({
      controllerOnline: meta.controllerOnline,
      stateObservedAt: meta.stateUpdatedAt,
      observedAt,
      documentStage: linkedRequest?.stage ?? null,
      taskRegistration: taskRegistrationForView({
        dispatch: group.dispatch,
        jobs: group.jobs,
        requirementMatched: (
          currentReq !== undefined
          && currentReq.specHash === group.specHash
          && currentReq.sourceMainSha === group.sourceMainSha
        ),
      }),
      revision: waitRevisionOf(group),
      primaryJob: waitPrimaryJob(primary),
      activeOtherJob: hasActiveOtherJob(state, group.revision, group.reqId),
      nodes,
      deploymentReceiptHref: deploymentReceipt.href,
      conflict: group.conflict || deploymentReceipt.conflict,
      superseded,
    });
    const evidence = groupEvidence({ state, meta, group, linkedRequest, primaryJob: primary });

    return {
      id: groupId(group.reqId, group.specHash, group.sourceMainSha, group.revision),
      reqId: group.reqId,
      specHash: shortSha(group.specHash)!,
      sourceMainSha: shortSha(group.sourceMainSha)!,
      issueNumber: group.issueNumber,
      createdAt: group.dispatch?.publishedAt ?? group.jobs[0]?.startedAt ?? null,
      updatedAt: latestTimestamp([latestUpdatedAt, group.dispatch?.observation?.observedAt]) ?? null,
      superseded,
      linkBasis: link.basis,
      linkedRequestId: link.requestId,
      attempts,
      version: versionIdentity({
        reqId: group.reqId,
        specPath: group.specPath,
        specHash: group.specHash,
        sourceMainSha: group.sourceMainSha,
        revision: group.revision,
        issueNumber: group.issueNumber,
        documentRequestId: link.requestId,
        documentPrNumber: linkedRequest?.prNumber ?? null,
      }),
      waiting,
      evidence,
      observedAt,
      nodes,
    };
  });

  const groupsByRequest = new Map<string, GroupAcc[]>();
  for (const group of groups) {
    const requestId = requestIdsByGroup.get(
      versionGroupKey(group.reqId, group.specHash, group.sourceMainSha, group.revision),
    );
    if (!requestId) continue;
    const list = groupsByRequest.get(requestId) ?? [];
    list.push(group);
    groupsByRequest.set(requestId, list);
  }

  const requestItems: PanelRequest[] = requests.map((req) => {
    const linkedGroups = groupsByRequest.get(req.requestId) ?? [];
    const linkedJobs = linkedGroups.flatMap((g) => g.jobs);
    const linkedIds = linkedGroups.map((g) => groupId(g.reqId, g.specHash, g.sourceMainSha, g.revision));
    const versionSha = linkedGroups[0]?.sourceMainSha ?? req.mergedMainSha ?? null;
    const reqDocHash = docHashByRequest.get(req.requestId) ?? null;
    const candidateRequirement = requirements[req.targetReqId];
    const matchedRequirement =
      versionSha !== null &&
      reqDocHash !== null &&
      candidateRequirement !== undefined &&
      candidateRequirement.sourceMainSha === versionSha &&
      candidateRequirement.specHash === reqDocHash
        ? candidateRequirement
        : null;

    const superseded =
      req.stage === 'stale' ||
      req.stage === 'pr-closed' ||
      requests.some(
        (other) =>
          other.targetReqId === req.targetReqId &&
          other.requestId !== req.requestId &&
          other.stage === 'pr-merged' &&
          (other.createdAt ?? '') > (req.createdAt ?? ''),
      );
    const nodes = computeNodes({
      req,
      requirement: matchedRequirement,
      jobs: linkedJobs,
      deploy: state.deploy,
      merges,
    });
    const linkedGroup = linkedGroups
      .filter((group) => {
        const latestRevision = (state.dispatchRevisions[group.reqId] ?? []).at(-1)?.revision ?? null;
        return group.revision === null || latestRevision === null || group.revision === latestRevision;
      })
      .sort(
        (left, right) =>
          (right.revision ?? 0) - (left.revision ?? 0)
          || (right.jobs.at(-1)?.updatedAt ?? '').localeCompare(left.jobs.at(-1)?.updatedAt ?? ''),
      )[0] ?? null;
    const primary = linkedGroup ? primaryJobForGroup(linkedGroup) : undefined;
    const deploymentReceipt = linkedGroup
      ? projectDeploymentReceipt(state, meta, linkedGroup, primary)
      : { href: null, conflict: false };
    const observedAt = latestTimestamp([
      linkedGroup?.dispatch?.observation?.observedAt,
      linkedGroup?.dispatch?.publishedAt,
      primary?.updatedAt,
      requestWaitObservedAt(req, meta),
    ]) ?? requestWaitObservedAt(req, meta);
    const waiting = projectPanelWait({
      controllerOnline: meta.controllerOnline,
      stateObservedAt: meta.stateUpdatedAt,
      observedAt,
      documentStage: req.stage,
      taskRegistration: taskRegistrationForView({
        dispatch: linkedGroup?.dispatch ?? null,
        jobs: linkedGroup?.jobs ?? [],
        requirementMatched: matchedRequirement !== null,
      }),
      revision: linkedGroup ? waitRevisionOf(linkedGroup) : null,
      primaryJob: waitPrimaryJob(primary),
      activeOtherJob: linkedGroup
        ? hasActiveOtherJob(state, linkedGroup.revision, linkedGroup.reqId)
        : hasActiveOtherJob(state, null, req.targetReqId),
      nodes: linkedGroup
        ? computeNodes({
            req,
            requirement: matchedRequirement,
            jobs: linkedGroup.jobs,
            deploy: state.deploy,
            merges,
          })
        : nodes,
      deploymentReceiptHref: deploymentReceipt.href,
      conflict: linkedGroup?.conflict
        ? true
        : deploymentReceipt.conflict || ambiguousRequestIds.has(req.requestId),
      superseded,
    });
    const evidence = uniqueEvidence([
      ...requestEvidence({ req, reqDocHash, repo: state.repo }),
      ...(linkedGroup
        ? groupEvidence({ state, meta, group: linkedGroup, linkedRequest: req, primaryJob: primary })
        : []),
    ]);

    return {
      requestId: req.requestId,
      targetReqId: req.targetReqId,
      stage: req.stage,
      status: requestStatus(req.stage),
      prNumber: req.prNumber,
      prUrl: safePrUrl(state.repo, req.prNumber),
      summary: safeTitle(req.summary),
      mergedMainSha: shortSha(req.mergedMainSha),
      createdAt: req.createdAt,
      updatedAt: req.updatedAt,
      superseded,
      linkedDeliveryIds: linkedIds,
      version: versionIdentity({
        reqId: req.targetReqId,
        specPath:
          linkedGroup?.specPath
          ?? matchedRequirement?.specPath
          ?? requestSpecPathByRequest.get(req.requestId)
          ?? null,
        specHash: reqDocHash,
        sourceMainSha: versionSha,
        revision: linkedGroup?.revision ?? null,
        issueNumber: matchedRequirement?.issueNumber ?? linkedGroup?.issueNumber ?? null,
        documentRequestId: req.requestId,
        documentPrNumber: req.prNumber,
      }),
      waiting,
      evidence,
      observedAt,
      nodes,
    };
  });

  const defaultFocus = requestItems[0]?.nodes ?? deliveryGroups[0]?.nodes ?? emptyNodes();

  return {
    schemaVersion: 'panel/v1',
    observedAt: meta.observedAt,
    stateUpdatedAt: meta.stateUpdatedAt,
    stateKind: meta.stateKind,
    repo,
    controllerOnline: meta.controllerOnline,
    cursorMainSha: shortSha(state.cursorMainSha),
    panelActiveSha: shortSha(asSha40(meta.panelActiveSha)),
    panelActiveObservedAt: safeTimestamp(meta.panelActiveObservedAt),
    requests: requestItems,
    deliveryGroups,
    deploy,
    nodes: defaultFocus,
  };
}
