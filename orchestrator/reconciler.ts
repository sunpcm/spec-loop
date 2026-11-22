import { encodeMetaBlock, extractMeta } from './github.ts';
import { dispatchCommentMarker, dispatchLabel } from './dispatch-task.ts';
import type {
  DispatchRevision,
  ManagedIssue,
  ManagedMeta,
  ManagedPR,
  Spec,
  SpecDiffEntry,
} from './types.ts';

export type ReconcileKind = 'create' | 'update' | 'close' | 'close-pr' | 'noop';

export const HUMAN_AREA_BEGIN = '<!-- spec-loop:human:start -->';
export const HUMAN_AREA_END = '<!-- spec-loop:human:end -->';
export const DISPATCH_CARD_BEGIN = '<!-- spec-loop:dispatch:start -->';
export const DISPATCH_CARD_END = '<!-- spec-loop:dispatch:end -->';

export interface ReconcileOp {
  kind: ReconcileKind;
  reqId: string;
  issueNumber?: number;
  prNumber?: number;
  spec?: Spec;
  reason?: string;
  issueBody?: string;
  title?: string;
  labels?: string[];
  operationKey?: string;
  backfill?: {
    specHash: string;
    specPath: string;
    sourceMainSha: string;
  };
}

export function managedIssuesByReqId(issues: ManagedIssue[]): Map<string, ManagedIssue> {
  const map = new Map<string, ManagedIssue>();
  for (const issue of issues) {
    const meta = issue.meta ?? extractMeta(issue.body);
    const reqId = typeof meta?.reqId === 'string' ? meta.reqId : undefined;
    if (reqId) map.set(reqId, issue);
  }
  return map;
}

export function buildRequirementMeta(spec: Spec, targetMainSha: string, kind = 'requirement'): ManagedMeta {
  return {
    schema: 1,
    system: 'spec-loop',
    kind,
    reqId: spec.id,
    specPath: spec.path,
    specHash: spec.hash,
    sourceMainSha: targetMainSha,
    operationKey: `${spec.hash}:${targetMainSha}:${kind}`,
  };
}

export function buildIssueBody(spec: Spec, targetMainSha: string): string {
  const human = `需求来源：\`${spec.path}\`\n\n${spec.body}`;
  const meta = encodeMetaBlock(buildRequirementMeta(spec, targetMainSha));
  return `${human}\n\n${meta}`;
}

export function buildIssueTitle(spec: Spec): string {
  return `[${spec.id}] ${spec.title}`;
}

/** 派工记录的受管元数据；保留既有字段，另带 revision，供对账与恢复定位当前版本。 */
export function buildDispatchMeta(
  spec: Spec,
  targetMainSha: string,
  revision: number,
): ManagedMeta {
  return {
    schema: 1,
    system: 'spec-loop',
    kind: 'requirement',
    reqId: spec.id,
    specPath: spec.path,
    specHash: spec.hash,
    sourceMainSha: targetMainSha,
    revision,
    operationKey: `${spec.hash}:${targetMainSha}:dispatch:r${revision}`,
  };
}

/** 受管派工卡片正文（不包含人工区与元数据块）。 */
export function buildDispatchCard(spec: Spec, revision: DispatchRevision): string {
  const task = revision.task;
  const refs = (refs: string[]): string => (refs.length > 0 ? refs.join('、') : '—');
  const depends = task.dependsOn.length > 0 ? task.dependsOn.join('、') : '无';
  const acceptanceLines = Object.entries(task.acceptance)
    .map(([key, text]) => `  - ${key}：${text}`)
    .join('\n');
  const stepLines = task.steps
    .map((step) => `- [ ] ${step.text} → ${refs(step.acceptanceRefs)}`)
    .join('\n');

  return [
    `### 本次交付 · r${revision.revision}`,
    `目标：${task.goal}`,
    `依据：\`${spec.path}\` · ${spec.id} · \`${spec.hash.slice(0, 8)}\``,
    '状态：发布时待排期，领取后以状态标签与 PR/回执为准',
    `下一步：操作者添加 \`${dispatchLabel(revision.revision)}\` 后由调度器领取`,
    '',
    '### 执行与验收',
    stepLines,
    '独立验收：',
    acceptanceLines,
    `允许写入：\`${task.allowedPaths.join('、')}\`。前置依赖：${depends}。`,
    '',
    '### 交付记录',
    '文档 PR · 代码 PR（生成后补） · 验收与部署回执（产生后补）',
  ].join('\n');
}

/** 派工 Issue 正文：人工区 + 需求快照 + 受管卡片 + 元数据。 */
export function buildDispatchIssueBody(spec: Spec, targetMainSha: string, revision: DispatchRevision): string {
  const humanArea = [
    HUMAN_AREA_BEGIN,
    '',
    '（人工区：此处内容由操作者维护，控制器更新时不覆盖）',
    '',
    HUMAN_AREA_END,
  ].join('\n');
  const requirement = `需求来源：\`${spec.path}\`\n\n${spec.body}`;
  const card = [
    DISPATCH_CARD_BEGIN,
    buildDispatchCard(spec, revision),
    DISPATCH_CARD_END,
  ].join('\n');
  const meta = encodeMetaBlock(buildDispatchMeta(spec, targetMainSha, revision.revision));
  return `${humanArea}\n\n${requirement}\n\n${card}\n\n${meta}`;
}

/** 提取既有正文中的人工区内容；没有该区段时返回 null。 */
export function extractHumanArea(body: string): string | null {
  const start = body.indexOf(HUMAN_AREA_BEGIN);
  const end = body.indexOf(HUMAN_AREA_END, start);
  if (start < 0 || end < 0) return null;
  return body.slice(start + HUMAN_AREA_BEGIN.length, end);
}

/** 更新正文时保留旧的人工区内容，受管区段与元数据随当前版本重建。 */
export function preserveHumanArea(existingBody: string, nextBody: string): string {
  const inner = extractHumanArea(existingBody);
  if (inner === null) return nextBody;
  const start = nextBody.indexOf(HUMAN_AREA_BEGIN);
  const end = nextBody.indexOf(HUMAN_AREA_END, start);
  if (start < 0 || end < 0) return nextBody;
  return `${nextBody.slice(0, start + HUMAN_AREA_BEGIN.length)}${inner}${nextBody.slice(end)}`;
}

/** 发布版本评论：包含 marker、版本、规格与来源依据，正文用于人读。 */
export function buildDispatchRevisionComment(
  spec: Spec,
  revision: DispatchRevision,
  repo: string,
): { marker: string; body: string } {
  const marker = dispatchCommentMarker(spec.id, revision.revision);
  const snapshot = {
    schema: 1,
    repo,
    issueNumber: revision.issueNumber,
    revision: `r${revision.revision}`,
    reqId: revision.reqId,
    specPath: revision.specPath,
    sourceMainSha: revision.sourceMainSha,
    specHash: revision.specHash,
    goal: revision.task.goal,
    steps: revision.task.steps,
    acceptance: revision.task.acceptance,
    allowedPaths: revision.task.allowedPaths,
    dependsOn: revision.task.dependsOn,
  };
  const body = [
    marker,
    '',
    `### 交付版本 r${revision.revision}`,
    `- 需求：${spec.id}`,
    `- 规格：\`${spec.path}\` @ \`${spec.hash.slice(0, 8)}\``,
    `- 来源：\`${revision.sourceMainSha}\``,
    `- 许可：\`${dispatchLabel(revision.revision)}\``,
    '',
    '```json',
    JSON.stringify(snapshot, null, 2),
    '```',
  ].join('\n');
  return { marker, body };
}

export function planReconciliation(
  diff: SpecDiffEntry[],
  issues: ManagedIssue[],
  targetMainSha: string,
  prs: ManagedPR[] = [],
): ReconcileOp[] {
  const byReqId = managedIssuesByReqId(issues);
  const ops: ReconcileOp[] = [];

  const closeOpenPRs = (reqId: string, keepHash?: string): void => {
    for (const pr of prs) {
      if (pr.state !== 'open' || pr.merged) continue;
      if (pr.meta?.reqId !== reqId) continue;
      if (keepHash !== undefined && pr.meta?.specHash === keepHash) continue;
      ops.push({
        kind: 'close-pr',
        reqId,
        prNumber: pr.number,
        reason: keepHash === undefined
          ? `需求 ${reqId} 已从 docs/specs 删除，关闭关联 PR`
          : `需求 ${reqId} 已更新到新版本，作废旧 PR`,
      });
    }
  };

  for (const entry of diff) {
    if (entry.action === 'remove') {
      closeOpenPRs(entry.id);
      const existing = byReqId.get(entry.id);
      ops.push({
        kind: 'close',
        reqId: entry.id,
        issueNumber: existing?.number,
        reason: `需求 ${entry.id} 已从 docs/specs 删除`,
      });
      continue;
    }

    const spec = entry.spec;
    if (!spec) continue;
    const existing = byReqId.get(entry.id);
    const body = buildIssueBody(spec, targetMainSha);
    const title = buildIssueTitle(spec);

    if (entry.action === 'unchanged' && !existing) {
      // 基线快照中已存在且无受管 Issue 的需求视为初始已实现，不重复派单。
      continue;
    }

    if (!existing) {
      // 新增需求，或基线之后变更过但从未建单的需求，都需要新的交付。
      ops.push({
        kind: 'create',
        reqId: entry.id,
        spec,
        title,
        issueBody: body,
        labels: ['pi-task', 'status:todo'],
        operationKey: `${spec.hash}:create`,
      });
      continue;
    }

    const existingHash = typeof existing.meta?.specHash === 'string' ? existing.meta.specHash : undefined;
    const existingPath = typeof existing.meta?.specPath === 'string' ? existing.meta.specPath : undefined;
    const contentChanged = existingHash !== spec.hash;
    const pathChanged = existingPath !== spec.path;
    // add/update/move 表示本差量轮存在明确文档变更；即使远端 body hash 已被上轮部分写入，
    // 也不能判 noop，必须继续修复 open/labels/本地状态（上轮失败时游标未推进才会重放）。
    const docChanged = entry.action === 'add' || entry.action === 'update' || entry.action === 'move';

    if (!docChanged && !contentChanged && !pathChanged) {
      ops.push({
        kind: 'noop',
        reqId: entry.id,
        issueNumber: existing.number,
        spec,
        backfill: {
          specHash: spec.hash,
          specPath: spec.path,
          sourceMainSha: typeof existing.meta?.sourceMainSha === 'string' ? existing.meta.sourceMainSha : targetMainSha,
        },
      });
      continue;
    }

    closeOpenPRs(entry.id, spec.hash);
    ops.push({
      kind: 'update',
      reqId: entry.id,
      issueNumber: existing.number,
      spec,
      title,
      issueBody: body,
      labels: ['pi-task', 'status:todo'],
      reason: contentChanged
        ? `需求 ${entry.id} 内容变更，作废旧版本交付`
        : pathChanged
          ? `需求 ${entry.id} 路径移动`
          : `需求 ${entry.id} 文档变更未完成，修复 Issue 状态`,
      operationKey: `${spec.hash}:update`,
    });
  }

  return ops;
}
