import { currentDispatchGrant, type DispatchLabelEvent } from './dispatch-grant.ts';
import type {
  DispatchGrant,
  DispatchRevision,
  DispatchStep,
  DispatchTask,
  OrchestratorState,
  Spec,
} from './types.ts';

/** 开工标签前缀；本版标签形如 `可开工/rN`，由操作者添加、控制器不得自行贴标。 */
export const DISPATCH_LABEL_PREFIX = '可开工/';

// 有界字段上限：冻结与回读都受同一套边界约束，避免任意长输入写入状态或 Issue。
const MAX_GOAL_LENGTH = 500;
const MAX_STEP_TEXT_LENGTH = 2000;
const MAX_ACCEPTANCE_TEXT_LENGTH = 2000;
const MAX_ACCEPTANCE_KEYS = 500;
const MAX_STEPS = 500;
const MAX_ALLOWED_PATHS = 200;
const MAX_DEPENDS_ON = 200;
const MAX_PATH_LENGTH = 500;

const SECTION_HEADING_RE = /^####\s+/;
const LIST_ITEM_RE = /^-\s+/;

export function dispatchLabel(revision: number): string {
  return `${DISPATCH_LABEL_PREFIX}r${revision}`;
}

/** 版本评论 marker，用于 ensureDispatchComment 的幂等回读。 */
export function dispatchCommentMarker(reqId: string, revision: number): string {
  return `spec-loop:dispatch:${reqId}:r${revision}`;
}

/** 从需求块正文中提取 `#### 功能` 与 `#### 验收` 的列表项，供确定性回退与验收映射使用。 */
export function splitSpecSections(body: string): { functions: string[]; acceptances: string[] } {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const functions: string[] = [];
  const acceptances: string[] = [];
  let mode: 'none' | 'functions' | 'acceptances' = 'none';
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#### 功能')) {
      mode = 'functions';
      continue;
    }
    if (trimmed.startsWith('#### 验收')) {
      mode = 'acceptances';
      continue;
    }
    if (SECTION_HEADING_RE.test(trimmed)) {
      mode = 'none';
      continue;
    }
    if (mode === 'functions' && LIST_ITEM_RE.test(trimmed)) {
      const text = trimmed.replace(LIST_ITEM_RE, '').trim();
      if (text) functions.push(text);
    } else if (mode === 'acceptances' && LIST_ITEM_RE.test(trimmed)) {
      const text = trimmed.replace(LIST_ITEM_RE, '').trim();
      if (text) acceptances.push(text);
    }
  }
  return { functions, acceptances };
}

/**
 * 由规格正文确定性生成验收映射 A1..An。验收文本取自已确认文档，
 * Planner 只提出步骤与引用，不决定验收内容；缺少验收时返回 null。
 */
export function buildAcceptanceMap(spec: Spec): Record<string, string> | null {
  const { acceptances } = splitSpecSections(spec.body);
  if (acceptances.length === 0 || acceptances.length > MAX_ACCEPTANCE_KEYS) return null;
  const acceptance: Record<string, string> = {};
  acceptances.forEach((text, index) => {
    acceptance[`A${index + 1}`] = text;
  });
  return acceptance;
}

/**
 * 确定性最小回退任务：一个步骤覆盖全部验收。仅当 Planner 不可用或返回无效结果时使用；
 * 无法生成有效任务（缺少验收）时返回 null，需求保持待排期。
 */
export function buildDeterministicDispatchTask(
  spec: Spec,
  allowedPaths: string[],
  dependsOn: string[] = [],
): DispatchTask | null {
  const acceptance = buildAcceptanceMap(spec);
  if (!acceptance) return null;
  const refs = Object.keys(acceptance);
  const goal = spec.title.trim() || '实现需求';
  const steps: DispatchStep[] = [{
    text: `实现 ${goal} 并满足全部验收条款`,
    acceptanceRefs: refs,
  }];
  return { goal, steps, acceptance, allowedPaths, dependsOn };
}

function hasOwn(object: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isBoundedNonEmpty(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function isNonEmptyStringArray(value: unknown, maxItems: number, maxItemLength: number): value is string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxItems) return false;
  return value.every((item) => isBoundedNonEmpty(item, maxItemLength));
}

/**
 * 校验派工任务结构。acceptanceRefs 只认 acceptance 自有键；每个步骤至少一个引用，
 * 且所有验收项都必须被至少一个步骤覆盖（无漏验收）。allowedPaths / dependsOn 由控制器注入，
 * 这里只做有界与形态校验。
 */
export function validateDispatchTask(task: unknown): task is DispatchTask {
  if (!task || typeof task !== 'object' || Array.isArray(task)) return false;
  const candidate = task as Partial<DispatchTask>;
  if (!isBoundedNonEmpty(candidate.goal, MAX_GOAL_LENGTH)) return false;
  if (!Array.isArray(candidate.steps) || candidate.steps.length === 0 || candidate.steps.length > MAX_STEPS) {
    return false;
  }
  if (!candidate.acceptance || typeof candidate.acceptance !== 'object' || Array.isArray(candidate.acceptance)) {
    return false;
  }

  const acceptance = candidate.acceptance as Record<string, unknown>;
  const acceptanceKeys = Object.keys(acceptance);
  if (acceptanceKeys.length === 0 || acceptanceKeys.length > MAX_ACCEPTANCE_KEYS) return false;
  for (const [key, value] of Object.entries(acceptance)) {
    if (!key.trim() || !isBoundedNonEmpty(value, MAX_ACCEPTANCE_TEXT_LENGTH)) return false;
  }

  const referenced = new Set<string>();
  for (const step of candidate.steps) {
    if (!step || typeof step !== 'object' || Array.isArray(step)) return false;
    const partial = step as Partial<DispatchStep>;
    if (!isBoundedNonEmpty(partial.text, MAX_STEP_TEXT_LENGTH)) return false;
    const refs = partial.acceptanceRefs;
    if (!Array.isArray(refs) || refs.length === 0) return false;
    for (const ref of refs) {
      if (typeof ref !== 'string' || !hasOwn(acceptance, ref)) return false;
      referenced.add(ref);
    }
  }
  // 覆盖所有验收项：每个自有验收键都必须被引用；引用集合已 ⊆ 自有键。
  if (referenced.size !== acceptanceKeys.length) return false;

  if (!isNonEmptyStringArray(candidate.allowedPaths, MAX_ALLOWED_PATHS, MAX_PATH_LENGTH)) return false;
  if (!Array.isArray(candidate.dependsOn) || candidate.dependsOn.length > MAX_DEPENDS_ON) return false;
  for (const dep of candidate.dependsOn) {
    if (!isBoundedNonEmpty(dep, MAX_PATH_LENGTH)) return false;
  }
  return true;
}

/** 校验持久化的派工记录；revision 为单调递增且永久占用的版本号。 */
export function validateDispatchRevision(rev: unknown): rev is DispatchRevision {
  if (!rev || typeof rev !== 'object' || Array.isArray(rev)) return false;
  const candidate = rev as Partial<DispatchRevision>;
  if (
    typeof candidate.reqId !== 'string'
    || candidate.reqId.trim().length === 0
    || typeof candidate.repoId !== 'string'
    || candidate.repoId.trim().length === 0
    || !Number.isSafeInteger(candidate.revision)
    || candidate.revision! < 1
    || !Number.isSafeInteger(candidate.issueNumber)
    || candidate.issueNumber! <= 0
    || typeof candidate.specHash !== 'string'
    || !/^[0-9a-f]{64}$/.test(candidate.specHash)
    || typeof candidate.specPath !== 'string'
    || !/^docs\/specs\/[^/]+\.md$/.test(candidate.specPath)
    || typeof candidate.sourceMainSha !== 'string'
    || !/^[0-9a-f]{40}$/.test(candidate.sourceMainSha)
    || !validateDispatchTask(candidate.task)
  ) {
    return false;
  }
  if (candidate.publishedAt !== undefined && (
    typeof candidate.publishedAt !== 'string'
    || !Number.isFinite(Date.parse(candidate.publishedAt))
  )) {
    return false;
  }
  if (
    candidate.publicationCommentId !== undefined
    && (!Number.isSafeInteger(candidate.publicationCommentId) || candidate.publicationCommentId! <= 0)
  ) {
    return false;
  }
  if (candidate.grant !== undefined && !validateDispatchGrant(candidate.grant)) return false;
  return true;
}

function validateDispatchGrant(grant: unknown): grant is DispatchGrant {
  if (!grant || typeof grant !== 'object' || Array.isArray(grant)) return false;
  const candidate = grant as Partial<DispatchGrant>;
  return (
    Number.isSafeInteger(candidate.eventId)
    && candidate.eventId! > 0
    && typeof candidate.actorId === 'string'
    && candidate.actorId.trim().length > 0
    && typeof candidate.grantedAt === 'string'
    && Number.isFinite(Date.parse(candidate.grantedAt))
  );
}

/** 下一个版本号：在既有历史最大版本基础上 +1，编号永久占用、不回退。 */
export function nextDispatchRevision(
  state: Pick<OrchestratorState, 'dispatchRevisions'>,
  reqId: string,
): number {
  const list = state.dispatchRevisions?.[reqId] ?? [];
  let max = 0;
  for (const rev of list) {
    if (rev.revision > max) max = rev.revision;
  }
  return max + 1;
}

/** 同 (specHash, sourceMainSha) 且尚未发布完成的冻结记录，用于重试复用、避免撞号与重复调用 Planner。 */
export function findUnpublishedRevision(
  state: Pick<OrchestratorState, 'dispatchRevisions'>,
  reqId: string,
  specHash: string,
  sourceMainSha: string,
): DispatchRevision | undefined {
  const list = state.dispatchRevisions?.[reqId] ?? [];
  return list.find(
    (rev) =>
      rev.specHash === specHash
      && rev.sourceMainSha === sourceMainSha
      && rev.publishedAt === undefined,
  );
}

/**
 * 返回该需求当前冻结的最后一个版本（历史按 revision 升序，末尾即最新）。
 * deploy / merge / status 以它作为共享入口读取“当前版本”，旧版本仍保留在历史中。
 */
export function latestDispatchRevision(
  state: Pick<OrchestratorState, 'dispatchRevisions'>,
  reqId: string,
): DispatchRevision | undefined {
  const list = state.dispatchRevisions?.[reqId] ?? [];
  return list.length > 0 ? list[list.length - 1] : undefined;
}

export interface FreezeDispatchRevisionInput {
  reqId: string;
  repoId: string;
  revision: number;
  issueNumber: number;
  spec: Spec;
  sourceMainSha: string;
  task: DispatchTask;
}

/** 冻结一条派工记录（不产生外部效果，只返回可持久化对象）。 */
export function freezeDispatchRevision(input: FreezeDispatchRevisionInput): DispatchRevision {
  return {
    reqId: input.reqId,
    repoId: input.repoId,
    revision: input.revision,
    issueNumber: input.issueNumber,
    specHash: input.spec.hash,
    specPath: input.spec.path,
    sourceMainSha: input.sourceMainSha,
    task: input.task,
  };
}

export interface DispatchGrantContext {
  repoId: string;
  issueNumber: number;
  labels: string[];
  events: DispatchLabelEvent[];
  allowedActorIds: readonly string[];
}

export type DispatchClaimDecision =
  | { claimable: true; revision: DispatchRevision; grant: DispatchGrant }
  | { claimable: false; reason: string };

/**
 * 依据持久化历史与远端标签/事件，判断当前版本是否可领取。
 * 只负责派工侧门禁：仓库/Issue 绑定、版本已发布、当前标签与最新事件是白名单添加。
 * 规格是否当前、冻结提交是否仍在主线、依赖/名额/同需求活动交付由 runtime 另行核对。
 */
export function evaluateDispatchClaim(
  state: Pick<OrchestratorState, 'dispatchRevisions'>,
  reqId: string,
  ctx: DispatchGrantContext,
): DispatchClaimDecision {
  const list = state.dispatchRevisions?.[reqId] ?? [];
  if (list.length === 0) return { claimable: false, reason: 'no-dispatch-revision' };
  const revision = list[list.length - 1]!;
  if (revision.repoId !== ctx.repoId) return { claimable: false, reason: 'repo-mismatch' };
  if (revision.issueNumber !== ctx.issueNumber) return { claimable: false, reason: 'issue-mismatch' };
  if (!revision.publishedAt || !revision.publicationCommentId) {
    return { claimable: false, reason: 'not-published' };
  }
  const grantEvent = currentDispatchGrant(
    ctx.events,
    ctx.labels,
    revision.revision,
    revision.publishedAt,
    ctx.allowedActorIds,
  );
  if (!grantEvent) return { claimable: false, reason: 'no-valid-grant' };
  return {
    claimable: true,
    revision,
    grant: {
      eventId: grantEvent.id,
      actorId: grantEvent.actorId ?? '',
      grantedAt: grantEvent.createdAt,
    },
  };
}
