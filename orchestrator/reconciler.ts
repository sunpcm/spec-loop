import { encodeMetaBlock, extractMeta } from './github.ts';
import type { ManagedIssue, ManagedMeta, ManagedPR, Spec, SpecDiffEntry } from './types.ts';

export type ReconcileKind = 'create' | 'update' | 'close' | 'close-pr' | 'noop';

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
