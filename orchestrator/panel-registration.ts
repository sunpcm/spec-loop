import {
  PANEL_REQ_ID,
  PANEL_SPEC_PATH,
  type PanelBinding,
} from './delivery-profile.ts';
import type { ManagedIssue, OrchestratorState } from './types.ts';

const PANEL_TITLE_RE = new RegExp(`^\\[${PANEL_REQ_ID}\\]\\s+\\S`);
const REQUIREMENT_TITLE_RE = /^\[(REQ-[A-Z0-9-]+)\]\s+\S/;
const CODE_SPAN_RE = /`([^`\r\n]+)`/g;
const SOURCE_REFERENCE_RE =
  /^([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)@([0-9a-f]{40})$/;
const SOURCE_HASH_RE = /^[0-9a-f]{64}$/;

interface PanelSourceFields {
  references: Set<string>;
  panelPaths: Set<string>;
  hashes: Set<string>;
}

export type PanelIssueSelection =
  | { ok: true; issue: ManagedIssue; registered: boolean }
  | { ok: false; reason: string };

export interface SelectPanelIssueInput {
  binding: PanelBinding;
  issues: ManagedIssue[];
  state: Pick<OrchestratorState, 'requirements' | 'dispatchRevisions'>;
}

/** 普通面板卡的标题必须有且仅有需求 ID 前缀，并保留可读标题正文。 */
export function hasPanelIssueTitle(title: string): boolean {
  return PANEL_TITLE_RE.test(title);
}

function codeSpans(body: string): string[] {
  return [...body.matchAll(CODE_SPAN_RE)]
    .map((match) => match[1]!.trim())
    .filter(Boolean);
}

function panelSourceFields(body: string): PanelSourceFields {
  const fields: PanelSourceFields = {
    references: new Set<string>(),
    panelPaths: new Set<string>(),
    hashes: new Set<string>(),
  };
  for (const span of codeSpans(body)) {
    if (SOURCE_REFERENCE_RE.test(span)) fields.references.add(span);
    if (span === PANEL_SPEC_PATH) fields.panelPaths.add(span);
    if (SOURCE_HASH_RE.test(span)) fields.hashes.add(span);
  }
  return fields;
}

/** 三个精确字段均出现才构成可核验的面板来源记录；仅提到路径不算候选。 */
export function hasPanelSourceReference(body: string): boolean {
  const fields = panelSourceFields(body);
  return fields.references.size > 0
    && fields.panelPaths.size > 0
    && fields.hashes.size > 0;
}

export function panelSourceMatchesBinding(body: string, binding: PanelBinding): boolean {
  const fields = panelSourceFields(body);
  return (
    fields.references.size === 1
    && fields.references.has(`${binding.repo}@${binding.confirmedMainSha}`)
    && fields.panelPaths.size === 1
    && fields.panelPaths.has(PANEL_SPEC_PATH)
    && fields.hashes.size === 1
    && fields.hashes.has(binding.specHash)
  );
}

function titleReqId(title: string): string | undefined {
  return REQUIREMENT_TITLE_RE.exec(title)?.[1];
}

/**
 * 只有明确属于面板需求的标题/元数据，或尚未声明其他需求身份的精确来源句，
 * 才进入候选集。其他需求的卡即使正文碰巧引用来源句，也不能伪装成面板卡。
 */
function isPanelCandidate(issue: ManagedIssue): boolean {
  const metaReqId = issue.meta?.reqId;
  if (hasPanelIssueTitle(issue.title) || metaReqId === PANEL_REQ_ID) return true;
  if (!hasPanelSourceReference(issue.body)) return false;
  return (
    metaReqId === undefined
    && titleReqId(issue.title) === undefined
  );
}

/**
 * 选择唯一可接续的普通卡。任何面板标题、面板 reqId 或完整面板来源字段都会进入
 * 候选集；候选多于一张、编号不符、标题/来源不符或元数据冲突时全部 fail closed。
 */
export function selectPanelIssue(input: SelectPanelIssueInput): PanelIssueSelection {
  const stateIssue = input.state.requirements[PANEL_REQ_ID]?.issueNumber;
  const revisionIssues = new Set(
    (input.state.dispatchRevisions?.[PANEL_REQ_ID] ?? []).map((revision) => revision.issueNumber),
  );
  if (stateIssue !== undefined && stateIssue !== input.binding.issueNumber) {
    return {
      ok: false,
      reason: `本地面板需求绑定了 Issue #${stateIssue}，与受信配置 #${input.binding.issueNumber} 不一致`,
    };
  }
  if (revisionIssues.size > 0 && (
    revisionIssues.size !== 1
    || !revisionIssues.has(input.binding.issueNumber)
  )) {
    return {
      ok: false,
      reason: `面板派工历史未唯一绑定受信 Issue #${input.binding.issueNumber}`,
    };
  }
  const registered = stateIssue === input.binding.issueNumber
    || revisionIssues.has(input.binding.issueNumber);

  const related = input.issues.filter(isPanelCandidate);
  if (related.length === 0) {
    return { ok: false, reason: `未找到受信面板需求卡 #${input.binding.issueNumber}，保持待登记` };
  }
  if (related.length !== 1) {
    return {
      ok: false,
      reason: `找到 ${related.length} 张面板相关卡片，无法唯一确认受信 Issue #${input.binding.issueNumber}`,
    };
  }

  const issue = related[0]!;
  if (issue.number !== input.binding.issueNumber) {
    return {
      ok: false,
      reason: `面板相关卡为 #${issue.number}，与受信 Issue #${input.binding.issueNumber} 不一致`,
    };
  }
  if (!hasPanelIssueTitle(issue.title)) {
    return { ok: false, reason: `Issue #${issue.number} 标题不是精确的 [${PANEL_REQ_ID}] 面板需求卡` };
  }

  const metaReqId = issue.meta?.reqId;
  if (issue.meta && metaReqId !== PANEL_REQ_ID) {
    return { ok: false, reason: `Issue #${issue.number} 的受管元数据属于其他需求` };
  }

  const hasManagedPanelMeta = metaReqId === PANEL_REQ_ID;
  if (
    (!registered || !hasManagedPanelMeta)
    && !panelSourceMatchesBinding(issue.body, input.binding)
  ) {
    return {
      ok: false,
      reason: registered && !hasManagedPanelMeta
        ? `已登记 Issue #${issue.number} 缺少受管面板元数据，且正文未保留首次接续来源锚点`
        : `Issue #${issue.number} 首次接续必须精确指向受信来源 ${input.binding.repo}@${input.binding.confirmedMainSha} 与规格哈希`,
    };
  }

  if (!registered && issue.state !== 'open') {
    return { ok: false, reason: `首次接续要求 Issue #${issue.number} 处于打开状态` };
  }
  return { ok: true, issue, registered };
}

/**
 * 显式领取入口使用的二次校验：只接受已经由本地冻结记录登记、标题和受管
 * 元数据均属于同一面板 Issue 的卡。首次普通卡不能绕过显式入口直接开工。
 */
export function validateRegisteredPanelIssue(
  input: SelectPanelIssueInput,
): PanelIssueSelection {
  const selection = selectPanelIssue(input);
  if (!selection.ok) return selection;
  if (!selection.registered) {
    return {
      ok: false,
      reason: `面板 Issue #${selection.issue.number} 尚无本地冻结记录，显式入口拒绝派工`,
    };
  }
  return selection;
}

export function panelSpecPath(): string {
  return PANEL_SPEC_PATH;
}
