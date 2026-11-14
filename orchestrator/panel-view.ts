import { createHash } from 'node:crypto';
import { redact } from './log.ts';
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

export interface PanelMeta {
  observedAt: string;
  stateUpdatedAt: string | null;
  stateKind: PanelStateKind;
  controllerOnline: boolean;
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
const KNOWN_JOB_STATUSES = new Set(['todo', 'processing', 'in-review', 'done', 'failed']);
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
  sourceMainSha: string;
}

interface NormJob {
  reqId: string;
  issueNumber: number;
  specHash: string;
  sourceMainSha: string;
  attempt: number;
  status: string;
  failureStage: string | null;
  resumeAction: string | null;
  prNumber: number | null;
  headSHA: string | null;
  startedAt: string | null;
  updatedAt: string | null;
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

interface NormState {
  schemaVersion: 1;
  repo: string | null;
  cursorMainSha: string | null;
  requirements: Record<string, NormRequirement>;
  jobs: NormJob[];
  deploy: NormDeploy;
  requests: NormRequest[];
  merges: NormMerge[];
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
  const sourceMainSha = asSha40(value.sourceMainSha);
  if (!cleanReqId || issueNumber === null || !specHash || !sourceMainSha) return null;
  return { reqId: cleanReqId, issueNumber, specHash, sourceMainSha };
}

function normalizeJob(value: unknown): NormJob | null {
  if (!isRecord(value)) return null;
  const reqId = safeReqId(value.reqId);
  const issueNumber = asPositiveInt(value.issueNumber);
  const specHash = asSha64(value.specHash);
  const sourceMainSha = asSha40(value.sourceMainSha);
  const attempt = asPositiveInt(value.attempt);
  const status = asString(value.status);
  if (!reqId || issueNumber === null || !specHash || !sourceMainSha || attempt === null || !status) return null;
  if (!KNOWN_JOB_STATUSES.has(status)) return null;
  const failureStageRaw = asString(value.failureStage);
  const resumeActionRaw = asString(value.resumeAction);
  return {
    reqId,
    issueNumber,
    specHash,
    sourceMainSha,
    attempt,
    status,
    failureStage: failureStageRaw && KNOWN_FAILURE_STAGES.has(failureStageRaw) ? failureStageRaw : null,
    resumeAction: resumeActionRaw === 'sync-deploy-receipt' ? resumeActionRaw : null,
    prNumber: asPositiveInt(value.prNumber),
    headSHA: asSha40(value.headSHA),
    startedAt: safeTimestamp(value.startedAt),
    updatedAt: safeTimestamp(value.updatedAt),
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

  // 任一容器元素为 null / 非对象，视为损坏状态，整体 invalid（前端保留旧快照），不静默过滤成空列表。
  for (const value of Object.values(raw.requirements)) if (!isRecord(value)) return null;
  for (const value of Object.values(raw.jobs)) if (!isRecord(value)) return null;
  for (const value of Object.values(raw.specRequests)) if (!isRecord(value)) return null;
  for (const value of Object.values(raw.mergeRequests ?? {})) if (!isRecord(value)) return null;

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

  return {
    schemaVersion: 1,
    repo,
    cursorMainSha: asSha40(asString(raw.cursorMainSha)),
    requirements,
    jobs,
    deploy: normalizeDeploy(raw.deploy),
    requests,
    merges,
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

function specHashForRequest(req: NormRequest): string | null {
  if (!req.docContent) return null;
  try {
    const parsed = parseSpecs({ 'docs/specs/counter.md': req.docContent });
    if (parsed.errors.length > 0) return null;
    const spec = parsed.specs.find((s) => s.id === req.targetReqId);
    return spec ? spec.hash : null;
  } catch {
    return null;
  }
}

function groupId(reqId: string, specHash: string, sourceMainSha: string): string {
  return createHash('sha256').update(`${reqId}\n${specHash}\n${sourceMainSha}`).digest('hex').slice(0, 16);
}

function failureStageLabel(stage: string | null): string | null {
  if (!stage) return null;
  return FAILURE_STAGE_LABELS[stage] ?? null;
}

function codeVerifyStatus(job: NormJob): PanelStatus {
  if (job.status === 'todo') return 'pending';
  if (job.status === 'processing') return 'running';
  if (job.status === 'in-review' || job.status === 'done') return 'succeeded';
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
    detail: codeConfirmDetail(codeConfirm, primary?.prNumber ?? null),
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
    detail: deploy.deployedPRs.includes(primaryPr ?? -1) ? '已本地部署' : deploy.deployFailedPRs.includes(primaryPr ?? -1) ? '部署失败' : '未部署',
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
    detail: deploy.deployedPRs.includes(primaryPr ?? -1)
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
  jobs: NormJob[];
}

function groupJobs(jobs: NormJob[]): GroupAcc[] {
  const groups = new Map<string, GroupAcc>();
  for (const job of jobs) {
    const key = `${job.reqId}|${job.specHash}|${job.sourceMainSha}`;
    const existing = groups.get(key);
    if (existing) existing.jobs.push(job);
    else groups.set(key, { reqId: job.reqId, specHash: job.specHash, sourceMainSha: job.sourceMainSha, jobs: [job] });
  }
  return [...groups.values()].map((group) => ({
    ...group,
    jobs: group.jobs.sort((a, b) => a.attempt - b.attempt),
  }));
}

function deployStatusOf(deploy: NormDeploy, prNumber: number | null, resumeAction: string | null): DeliveryDeployStatus {
  if (deploy.deployedPRs.includes(prNumber ?? -1)) {
    return resumeAction === 'sync-deploy-receipt' ? 'receipt-pending' : 'deployed';
  }
  if (deploy.deployFailedPRs.includes(prNumber ?? -1)) return 'deploy-failed';
  return 'none';
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
  const docHashByRequest = new Map<string, string | null>();
  for (const req of requests) docHashByRequest.set(req.requestId, specHashForRequest(req));

  const groups = groupJobs(state.jobs);
  const linkByGroupKey = new Map<string, { basis: LinkBasis; requestId: string | null }>();

  for (const group of groups) {
    const candidates = requests.filter((r) => r.targetReqId === group.reqId);
    const exact = candidates.filter(
      (r) => r.stage === 'pr-merged' && r.mergedMainSha !== null && r.mergedMainSha === group.sourceMainSha,
    );

    let basis: LinkBasis = 'none';
    let requestId: string | null = null;

    if (exact.length === 1) {
      const docHash = docHashByRequest.get(exact[0]!.requestId);
      if (docHash !== null && docHash === group.specHash) {
        basis = 'exact';
        requestId = exact[0]!.requestId;
      } else {
        basis = 'unconfirmed';
      }
    } else if (exact.length > 1) {
      basis = 'unconfirmed';
    } else {
      const hashFallback = candidates.filter(
        (r) => r.mergedMainSha === null && r.stage === 'pr-merged' && docHashByRequest.get(r.requestId) === group.specHash,
      );
      if (hashFallback.length === 1) {
        const created = hashFallback[0]!.createdAt;
        const started = group.jobs[0]?.startedAt ?? null;
        if (created && started && started >= created) {
          basis = 'hash-only';
          requestId = hashFallback[0]!.requestId;
        } else {
          basis = 'unconfirmed';
        }
      } else if (hashFallback.length > 1) {
        basis = 'unconfirmed';
      }
    }

    linkByGroupKey.set(`${group.reqId}|${group.specHash}|${group.sourceMainSha}`, { basis, requestId });
  }

  const deliveryGroups: PanelDeliveryGroup[] = groups.map((group) => {
    const link = linkByGroupKey.get(`${group.reqId}|${group.specHash}|${group.sourceMainSha}`) ?? {
      basis: 'none',
      requestId: null,
    };
    const currentReq = requirements[group.reqId];
    const superseded = currentReq
      ? currentReq.specHash !== group.specHash || currentReq.sourceMainSha !== group.sourceMainSha
      : false;
    const primary = group.jobs[group.jobs.length - 1];

    const flowInput: FlowInput = {
      req: link.requestId ? requests.find((r) => r.requestId === link.requestId) ?? null : null,
      requirement: currentReq && currentReq.sourceMainSha === group.sourceMainSha ? currentReq : null,
      jobs: group.jobs,
      deploy: state.deploy,
      merges,
    };

    const attempts: PanelDeliveryAttempt[] = group.jobs.map((job) => ({
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

    return {
      id: groupId(group.reqId, group.specHash, group.sourceMainSha),
      reqId: group.reqId,
      specHash: shortSha(group.specHash)!,
      sourceMainSha: shortSha(group.sourceMainSha)!,
      issueNumber: primary?.issueNumber ?? group.jobs[0]?.issueNumber ?? 0,
      createdAt: group.jobs[0]?.startedAt ?? null,
      updatedAt: latestUpdatedAt,
      superseded,
      linkBasis: link.basis,
      linkedRequestId: link.requestId,
      attempts,
      nodes: computeNodes(flowInput),
    };
  });

  const groupsByRequest = new Map<string, GroupAcc[]>();
  for (const group of groups) {
    const link = linkByGroupKey.get(`${group.reqId}|${group.specHash}|${group.sourceMainSha}`);
    if (!link?.requestId) continue;
    const list = groupsByRequest.get(link.requestId) ?? [];
    list.push(group);
    groupsByRequest.set(link.requestId, list);
  }

  const requestItems: PanelRequest[] = requests.map((req) => {
    const linkedGroups = groupsByRequest.get(req.requestId) ?? [];
    const linkedJobs = linkedGroups.flatMap((g) => g.jobs);
    const linkedIds = linkedGroups.map((g) => groupId(g.reqId, g.specHash, g.sourceMainSha));
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
      nodes: computeNodes({
        req,
        requirement: matchedRequirement,
        jobs: linkedJobs,
        deploy: state.deploy,
        merges,
      }),
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
    requests: requestItems,
    deliveryGroups,
    deploy,
    nodes: defaultFocus,
  };
}
