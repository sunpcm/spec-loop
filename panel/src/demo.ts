import {
  DEMO_STEP_SEQUENCE,
  demoTime,
  getDemoGate,
  getDemoStepIndex,
  type DemoState,
  type DemoStep,
} from './demo-state.ts';
import {
  handlesBetween,
  type FlowDefinition,
  type FlowEdgeDefinition,
  type FlowEdgeKind,
  type FlowNodeDefinition,
  type FlowNodeKind,
  type FlowPoint,
} from './flow-model.ts';
import type {
  DeliveryDeployStatus,
  PanelDeliveryAttempt,
  PanelDeliveryGroup,
  PanelNode,
  PanelRequest,
  PanelStatus,
  PanelView,
} from './types';

export const DEMO_STORY = {
  title: '计数器增加翻倍功能',
  summary: '新增翻倍按钮，保留原有步长、增加、减少与重置行为，并完成文档、编码、部署与回执闭环。',
  requestTarget: 'REQ-CNT-01',
  requestId: 'DEMO-REQUEST-COUNTER-DOUBLE',
  deliveryId: 'DEMO-DELIVERY-COUNTER-DOUBLE',
  issueLabel: 'DEMO-TASK-001',
  documentPrLabel: 'DEMO-DOC-PR-001',
  codePrLabel: 'DEMO-CODE-PR-001',
} as const;

export const DEMO_MAIN_NODE_IDS = [
  'docs-draft',
  'docs-pr',
  'docs-confirm',
  'docs-effective',
  'task-sync',
  'worker',
  'fixed-check',
  'code-pr',
  'code-confirm',
  'candidate-build',
  'candidate-health',
  'preview-switch',
  'deploy-receipt',
  'complete',
] as const;

export type DemoMainNodeId = (typeof DEMO_MAIN_NODE_IDS)[number];

interface DemoNodeSpec {
  id: string;
  label: string;
  kind: FlowNodeKind;
  position: { x: number; y: number };
  indexLabel: string;
}

const NODE_WIDTH = 178;
const NODE_HEIGHT = 96;
const BRANCH_HEIGHT = 88;

const MAIN_NODE_SPECS: readonly DemoNodeSpec[] = [
  { id: 'docs-draft', label: '文档草稿 / 验收标准', kind: 'document', position: { x: 0, y: 0 }, indexLabel: '01' },
  { id: 'docs-pr', label: '校验与文档 PR', kind: 'execution', position: { x: 260, y: 0 }, indexLabel: '02' },
  { id: 'docs-confirm', label: '用户文档确认', kind: 'human', position: { x: 520, y: 0 }, indexLabel: '03' },
  { id: 'docs-effective', label: 'main 需求生效', kind: 'execution', position: { x: 780, y: 0 }, indexLabel: '04' },
  { id: 'task-sync', label: '同步开发任务', kind: 'execution', position: { x: 780, y: 132 }, indexLabel: '05' },
  { id: 'worker', label: 'Worker 编码', kind: 'execution', position: { x: 520, y: 132 }, indexLabel: '06' },
  { id: 'fixed-check', label: '固定检查', kind: 'decision', position: { x: 260, y: 132 }, indexLabel: '07' },
  { id: 'code-pr', label: '代码 PR', kind: 'document', position: { x: 0, y: 132 }, indexLabel: '08' },
  { id: 'code-confirm', label: '用户代码确认', kind: 'human', position: { x: 0, y: 264 }, indexLabel: '09' },
  { id: 'candidate-build', label: '构建候选版本', kind: 'deployment', position: { x: 260, y: 264 }, indexLabel: '10' },
  { id: 'candidate-health', label: '候选健康检查', kind: 'decision', position: { x: 520, y: 264 }, indexLabel: '11' },
  { id: 'preview-switch', label: '切换稳定预览', kind: 'deployment', position: { x: 780, y: 264 }, indexLabel: '12' },
  { id: 'deploy-receipt', label: '部署记录 / 回执', kind: 'deployment', position: { x: 780, y: 396 }, indexLabel: '13' },
  { id: 'complete', label: '完成', kind: 'terminal', position: { x: 520, y: 396 }, indexLabel: '14' },
] as const;

const BRANCH_NODE_SPECS: readonly DemoNodeSpec[] = [
  { id: 'terminal-branches', label: '终止次级分支', kind: 'branch', position: { x: 0, y: 396 }, indexLabel: '分支' },
  { id: 'check-retry', label: '失败记录 / 人工重试', kind: 'human', position: { x: 520, y: 528 }, indexLabel: '回路' },
  { id: 'build-retry', label: '构建 / 健康失败', kind: 'branch', position: { x: 260, y: 528 }, indexLabel: '分支' },
  { id: 'receipt-retry', label: '回执补偿', kind: 'branch', position: { x: 780, y: 528 }, indexLabel: '分支' },
] as const;

const STEP_MAIN_INDEX: Record<DemoStep, number> = {
  draft: 0,
  'doc-pr': 1,
  'doc-confirm': 2,
  'doc-effective': 3,
  'task-sync': 4,
  'worker-first': 5,
  'check-first': 6,
  'check-failed': 6,
  'worker-retry': 5,
  'check-retry': 6,
  'code-pr': 7,
  'code-confirm': 8,
  build: 9,
  health: 10,
  preview: 11,
  receipt: 12,
  complete: 13,
};

const CURRENT_DETAILS: Record<DemoStep, string> = {
  draft: '翻倍需求草稿已就绪，播放后开始校验',
  'doc-pr': '正在校验需求正文并生成合成文档 PR',
  'doc-confirm': '已暂停，等待显式模拟确认文档合并',
  'doc-effective': '文档确认完成，需求版本在 main 生效',
  'task-sync': 'Planner 只派生任务正文，不新增自动 Reviewer',
  'worker-first': '第 1 次尝试：Worker 根据需求正文编码',
  'check-first': '第 1 次尝试：执行 Node 24 固定检查',
  'check-failed': '第 1 次检查失败，失败记录与产物已保留',
  'worker-retry': '显式重试已授权，第二次从 Worker 重新编码',
  'check-retry': '第 2 次尝试：重新执行固定检查',
  'code-pr': '固定检查通过，合成代码 PR 已生成',
  'code-confirm': '已暂停，等待显式模拟确认代码合并',
  build: '代码确认完成，构建合成候选版本',
  health: '候选版本已构建，执行健康检查',
  preview: '健康检查通过，稳定预览已切换到新版本',
  receipt: '部署成功，正在写入部署记录与回执',
  complete: '合成部署、健康检查与回执证据已完整',
};

const COMPLETED_DETAILS = [
  '翻倍需求与验收标准已形成草稿',
  '文档正文校验通过，合成文档 PR 已记录',
  '文档 PR 已完成一次明确模拟确认',
  '需求版本已进入 main',
  '开发任务已同步，仅派生正文',
  'Worker 编码已完成',
  '第二轮固定检查已通过',
  '合成代码 PR 已形成',
  '代码 PR 已完成一次明确模拟确认',
  '候选版本构建完成',
  '候选健康检查通过',
  '稳定预览已切换',
  '部署记录与回执均已完成',
  '全流程完成',
] as const;

const DEMO_DOCUMENT_MAIN_SHA = '8d4f7a6213c0b5e9a2d84176f0c3e5b9a17d6248';
const DEMO_CODE_MAIN_SHA = 'a2d7946bc10e5f38f1843d2cb65a0e9f7d41c836';
const DEMO_OLD_PREVIEW_SHA = '5c1a9ee3b406d28a7190c348f6e2a44d9b135c72';
const DEMO_NEW_PREVIEW_SHA = DEMO_CODE_MAIN_SHA;
const DEMO_SPEC_HASH = 'f19af6e0b73d2c8579e0a4f6d8c2b1135ea9d6c04bf871ab126cc3f5ed890b42';

function currentMainNodeId(state: DemoState): DemoMainNodeId {
  return DEMO_MAIN_NODE_IDS[STEP_MAIN_INDEX[state.step]]!;
}

function currentNodeId(state: DemoState): string {
  return state.step === 'check-failed' ? 'check-retry' : currentMainNodeId(state);
}

function mainNodeStatus(state: DemoState, index: number): PanelStatus {
  const activeIndex = STEP_MAIN_INDEX[state.step];
  if (state.step === 'complete') return 'succeeded';
  if (index < activeIndex) return 'succeeded';
  if (index > activeIndex) return 'pending';
  if (state.step === 'doc-confirm' || state.step === 'code-confirm') return 'waiting';
  if (state.step === 'check-failed') return 'failed';
  return 'running';
}

function mainNodeDetail(state: DemoState, index: number, status: PanelStatus): string {
  const activeIndex = STEP_MAIN_INDEX[state.step];
  if (index === activeIndex) {
    if (state.step === 'complete') return COMPLETED_DETAILS[index]!;
    if (index === 6 && state.step === 'check-failed') {
      return '首轮固定检查失败：翻倍行为断言未通过';
    }
    return CURRENT_DETAILS[state.step];
  }
  if (status === 'succeeded') return COMPLETED_DETAILS[index]!;
  return '主路径尚未到达，当前没有合成执行证据';
}

function mainNodeStatusLabel(state: DemoState, nodeId: string): string | undefined {
  if (nodeId === 'docs-confirm' && state.step === 'doc-confirm') return '等待文档确认';
  if (nodeId === 'code-confirm' && state.step === 'code-confirm') return '等待代码确认';
  if (nodeId === 'check-retry' && state.step === 'check-failed') return '等待显式重试';
  return undefined;
}

function retryNodeStatus(state: DemoState): PanelStatus {
  if (state.step === 'check-failed') return 'waiting';
  if (['worker-retry', 'check-retry', 'code-pr', 'code-confirm', 'build', 'health', 'preview', 'receipt', 'complete'].includes(state.step)) {
    return 'succeeded';
  }
  return 'pending';
}

function buildNodes(state: DemoState): PanelNode[] {
  const activeNode = currentNodeId(state);
  const mainNodes = MAIN_NODE_SPECS.map((spec, index) => {
    const status = mainNodeStatus(state, index);
    return {
      id: spec.id,
      label: spec.label,
      status,
      current: activeNode === spec.id,
      detail: mainNodeDetail(state, index, status),
    } satisfies PanelNode;
  });

  const retryStatus = retryNodeStatus(state);
  const retryNode: PanelNode = {
    id: 'check-retry',
    label: '失败记录 / 人工重试',
    status: retryStatus,
    current: state.step === 'check-failed',
    detail:
      state.step === 'check-failed'
        ? '首轮失败 attempt 已保留；等待显式模拟重试'
        : retryStatus === 'succeeded'
          ? '人工重试已触发一次，并从 Worker 重新执行'
          : '仅在固定检查失败后出现，不会被自动推进',
  };

  const dormantNodes: PanelNode[] = BRANCH_NODE_SPECS.filter(
    (spec) => spec.id !== 'check-retry',
  ).map((spec) => ({
    id: spec.id,
    label: spec.label,
    status: 'unknown',
    current: false,
    detail:
      spec.id === 'terminal-branches'
        ? '未触发：文档 PR 关闭则结束；需求版本过期则停止旧交付'
        : spec.id === 'build-retry'
          ? '未触发：构建或健康失败时保留旧预览，仅重试构建部署'
          : '未触发：部署成功但回执失败时只补回执，不回到 Worker',
  }));

  return [...mainNodes, retryNode, ...dormantNodes];
}

function mainEdgeKind(state: DemoState, sourceIndex: number, targetIndex: number): FlowEdgeKind {
  if (state.step === 'complete') return 'done';
  if (state.step === 'check-failed' && sourceIndex === 5 && targetIndex === 6) return 'failed';

  const activeIndex = STEP_MAIN_INDEX[state.step];
  if (targetIndex < activeIndex) return 'done';
  if (targetIndex === activeIndex && currentNodeId(state) === DEMO_MAIN_NODE_IDS[targetIndex]) {
    return 'active';
  }
  return 'pending';
}

function edgeLabel(source: string, target: string): string | undefined {
  const labels: Record<string, string> = {
    'docs-confirm:docs-effective': '确认通过',
    'fixed-check:code-pr': '检查通过',
    'code-confirm:candidate-build': '确认通过',
    'candidate-health:preview-switch': '健康通过',
  };
  return labels[`${source}:${target}`];
}

function points(...waypoints: FlowPoint[]): FlowPoint[] {
  return waypoints;
}

function edge(
  source: FlowNodeDefinition,
  target: FlowNodeDefinition,
  kind: FlowEdgeKind,
  label?: string,
  options?: Pick<FlowEdgeDefinition, 'sourceHandle' | 'targetHandle' | 'route'>,
): FlowEdgeDefinition {
  return {
    id: `${source.id}-${target.id}-${label ?? kind}`,
    source: source.id,
    target: target.id,
    ...(options?.sourceHandle && options?.targetHandle
      ? { sourceHandle: options.sourceHandle, targetHandle: options.targetHandle }
      : handlesBetween(source.position, target.position)),
    kind,
    label,
    animated: kind === 'active' || kind === 'retry',
    ...(options?.route ? { route: options.route } : {}),
  };
}

function buildFlowDefinition(state: DemoState, nodes: PanelNode[]): FlowDefinition {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const flowNodes = [...MAIN_NODE_SPECS, ...BRANCH_NODE_SPECS].map((spec) => {
    const node = nodeById.get(spec.id)!;
    return {
      ...node,
      kind: spec.kind,
      position: spec.position,
      width: NODE_WIDTH,
      height: spec.kind === 'branch' ? BRANCH_HEIGHT : NODE_HEIGHT,
      indexLabel: spec.indexLabel,
      stateLabel: mainNodeStatusLabel(state, spec.id),
      dormant: spec.id !== 'check-retry' && !DEMO_MAIN_NODE_IDS.includes(spec.id as DemoMainNodeId),
      compact: true,
    } satisfies FlowNodeDefinition;
  });
  const flowNodeById = new Map(flowNodes.map((node) => [node.id, node]));

  const edges: FlowEdgeDefinition[] = [];
  for (let index = 0; index < DEMO_MAIN_NODE_IDS.length - 1; index += 1) {
    const source = flowNodeById.get(DEMO_MAIN_NODE_IDS[index]!)!;
    const target = flowNodeById.get(DEMO_MAIN_NODE_IDS[index + 1]!)!;
    edges.push(edge(source, target, mainEdgeKind(state, index, index + 1), edgeLabel(source.id, target.id)));
  }

  const stepIndex = getDemoStepIndex(state);
  const failureReached = stepIndex >= 7;
  const retryReached = stepIndex >= 8;

  edges.push(
    edge(
      flowNodeById.get('fixed-check')!,
      flowNodeById.get('check-retry')!,
      failureReached ? 'failed' : 'dormant',
      '验证失败',
      {
        sourceHandle: 'source-bottom',
        targetHandle: 'target-top',
        route: {
          waypoints: points(
            { x: 349, y: 246 },
            { x: 469, y: 246 },
            { x: 469, y: 506 },
            { x: 609, y: 506 },
          ),
          labelPosition: { x: 409, y: 246 },
        },
      },
    ),
    edge(
      flowNodeById.get('check-retry')!,
      flowNodeById.get('worker')!,
      retryReached ? 'retry' : 'dormant',
      '显式重试',
      {
        sourceHandle: 'source-left',
        targetHandle: 'target-left',
        route: {
          waypoints: points({ x: 489, y: 572 }, { x: 489, y: 180 }),
          labelPosition: { x: 489, y: 376 },
        },
      },
    ),
    edge(
      flowNodeById.get('docs-pr')!,
      flowNodeById.get('terminal-branches')!,
      'dormant',
      'PR 关闭',
      {
        sourceHandle: 'source-left',
        targetHandle: 'target-right',
        route: {
          waypoints: points({ x: 239, y: 48 }, { x: 239, y: 440 }),
          labelPosition: { x: 239, y: 246 },
        },
      },
    ),
    edge(
      flowNodeById.get('docs-effective')!,
      flowNodeById.get('terminal-branches')!,
      'dormant',
      '版本过期',
      {
        sourceHandle: 'source-right',
        targetHandle: 'target-top',
        route: {
          waypoints: points(
            { x: 979, y: 48 },
            { x: 979, y: 378 },
            { x: 89, y: 378 },
          ),
          labelPosition: { x: 820, y: 378 },
        },
      },
    ),
    edge(
      flowNodeById.get('candidate-build')!,
      flowNodeById.get('build-retry')!,
      'dormant',
      '构建失败',
      {
        sourceHandle: 'source-left',
        targetHandle: 'target-left',
        route: {
          waypoints: points({ x: 189, y: 312 }, { x: 189, y: 572 }),
          labelPosition: { x: 189, y: 442 },
        },
      },
    ),
    edge(
      flowNodeById.get('candidate-health')!,
      flowNodeById.get('build-retry')!,
      'dormant',
      '健康失败',
      {
        sourceHandle: 'source-right',
        targetHandle: 'target-top',
        route: {
          waypoints: points({ x: 709, y: 312 }, { x: 709, y: 514 }, { x: 349, y: 514 }),
          labelPosition: { x: 529, y: 514 },
        },
      },
    ),
    edge(
      flowNodeById.get('build-retry')!,
      flowNodeById.get('candidate-build')!,
      'dormant',
      '仅重试构建部署',
      {
        sourceHandle: 'source-right',
        targetHandle: 'target-right',
        route: {
          waypoints: points({ x: 509, y: 572 }, { x: 509, y: 312 }),
          labelPosition: { x: 509, y: 442 },
        },
      },
    ),
    edge(
      flowNodeById.get('deploy-receipt')!,
      flowNodeById.get('receipt-retry')!,
      'dormant',
      '回执失败',
      {
        sourceHandle: 'source-left',
        targetHandle: 'target-left',
        route: {
          waypoints: points({ x: 729, y: 444 }, { x: 729, y: 572 }),
          labelPosition: { x: 729, y: 508 },
        },
      },
    ),
    edge(
      flowNodeById.get('receipt-retry')!,
      flowNodeById.get('deploy-receipt')!,
      'dormant',
      '只补回执',
      {
        sourceHandle: 'source-right',
        targetHandle: 'target-right',
        route: {
          waypoints: points({ x: 979, y: 572 }, { x: 979, y: 444 }),
          labelPosition: { x: 979, y: 508 },
        },
      },
    ),
  );

  return { nodes: flowNodes, edges, sequenceTotal: DEMO_MAIN_NODE_IDS.length };
}

function requestStatus(state: DemoState): PanelStatus {
  if (state.step === 'complete') return 'succeeded';
  const gate = getDemoGate(state);
  if (gate === 'document' || gate === 'code') return 'waiting';
  if (gate === 'retry') return 'failed';
  return 'running';
}

function deliveryDeployStatus(state: DemoState, isLatest: boolean): DeliveryDeployStatus {
  if (!isLatest) return 'none';
  const stepIndex = getDemoStepIndex(state);
  if (state.step === 'complete') return 'deployed';
  if (stepIndex >= 14) return 'receipt-pending';
  return 'none';
}

function attemptsForView(state: DemoState): PanelDeliveryAttempt[] {
  return state.attempts.map((attempt, index) => ({
    attempt: attempt.number,
    status: attempt.status,
    failureStage: attempt.failureStage,
    prNumber: null,
    prUrl: null,
    issueNumber: 0,
    isLatest: index === state.attempts.length - 1,
    deployStatus: deliveryDeployStatus(state, index === state.attempts.length - 1),
    startedAt: attempt.startedAt,
    updatedAt: attempt.updatedAt,
  }));
}

export interface DemoArtifactLabels {
  documentPr: string | null;
  task: string | null;
  codePr: string | null;
  documentMainSha: string | null;
  codeMainSha: string | null;
}

export function getDemoArtifactLabels(state: DemoState): DemoArtifactLabels {
  const stepIndex = getDemoStepIndex(state);
  const documentPrAt = DEMO_STEP_SEQUENCE.indexOf('doc-pr');
  const taskAt = DEMO_STEP_SEQUENCE.indexOf('task-sync');
  const codePrAt = DEMO_STEP_SEQUENCE.indexOf('code-pr');
  const docsEffectiveAt = DEMO_STEP_SEQUENCE.indexOf('doc-effective');
  const codeMergedAt = DEMO_STEP_SEQUENCE.indexOf('build');

  return {
    documentPr: stepIndex >= documentPrAt ? DEMO_STORY.documentPrLabel : null,
    task: stepIndex >= taskAt ? DEMO_STORY.issueLabel : null,
    codePr: stepIndex >= codePrAt ? DEMO_STORY.codePrLabel : null,
    documentMainSha: stepIndex >= docsEffectiveAt ? DEMO_DOCUMENT_MAIN_SHA : null,
    codeMainSha: stepIndex >= codeMergedAt ? DEMO_CODE_MAIN_SHA : null,
  };
}

export interface DemoScene {
  view: PanelView;
  nodes: PanelNode[];
  flow: FlowDefinition;
  currentNodeId: string;
  goal: string;
}

export function buildDemoScene(state: DemoState): DemoScene {
  const nodes = buildNodes(state);
  const flow = buildFlowDefinition(state, nodes);
  const stepIndex = getDemoStepIndex(state);
  const docsEffective = stepIndex >= DEMO_STEP_SEQUENCE.indexOf('doc-effective');
  const hasTask = stepIndex >= DEMO_STEP_SEQUENCE.indexOf('task-sync');
  const codeMerged = stepIndex >= DEMO_STEP_SEQUENCE.indexOf('build');
  const previewSwitched = stepIndex >= DEMO_STEP_SEQUENCE.indexOf('preview');
  const at = demoTime(state.step);
  const status = requestStatus(state);

  const request: PanelRequest = {
    requestId: DEMO_STORY.requestId,
    targetReqId: DEMO_STORY.requestTarget,
    stage: docsEffective ? 'requirement-effective' : 'document-draft',
    status,
    prNumber: null,
    prUrl: null,
    summary: `【演示】${DEMO_STORY.title}`,
    mergedMainSha: docsEffective ? DEMO_DOCUMENT_MAIN_SHA : null,
    createdAt: demoTime('draft'),
    updatedAt: at,
    superseded: false,
    linkedDeliveryIds: hasTask ? [DEMO_STORY.deliveryId] : [],
    nodes,
  };

  const delivery: PanelDeliveryGroup | null = hasTask
    ? {
        id: DEMO_STORY.deliveryId,
        reqId: DEMO_STORY.requestTarget,
        specHash: DEMO_SPEC_HASH,
        sourceMainSha: DEMO_DOCUMENT_MAIN_SHA,
        issueNumber: 0,
        createdAt: demoTime('task-sync'),
        updatedAt: at,
        superseded: false,
        linkBasis: 'exact',
        linkedRequestId: DEMO_STORY.requestId,
        attempts: attemptsForView(state),
        nodes,
      }
    : null;

  const view: PanelView = {
    schemaVersion: 'panel/v1',
    observedAt: at,
    stateUpdatedAt: at,
    stateKind: 'ok',
    repo: 'demo/spec-loop',
    controllerOnline: true,
    cursorMainSha: codeMerged
      ? DEMO_CODE_MAIN_SHA
      : docsEffective
        ? DEMO_DOCUMENT_MAIN_SHA
        : null,
    requests: [request],
    deliveryGroups: delivery ? [delivery] : [],
    deploy: {
      activeSha: previewSwitched ? DEMO_NEW_PREVIEW_SHA : DEMO_OLD_PREVIEW_SHA,
      deployedPRs: [],
      deployFailedPRs: [],
    },
    nodes,
  };

  return {
    view,
    nodes,
    flow,
    currentNodeId: currentNodeId(state),
    goal: DEMO_STORY.summary,
  };
}

export interface DemoEvidenceRow {
  label: string;
  value: string;
  tone?: 'success' | 'waiting' | 'failure' | 'muted';
}

export interface DemoEvidence {
  title: string;
  summary: string;
  rows: DemoEvidenceRow[];
}

function attemptValue(state: DemoState, number: 1 | 2): string {
  const attempt = state.attempts.find((item) => item.number === number);
  if (!attempt) return '未记录';
  if (attempt.status === 'failed') return '失败，已保留产物与失败项';
  if (attempt.status === 'succeeded') return '成功';
  return '进行中';
}

function evidenceForNode(state: DemoState, nodeId: string): DemoEvidence {
  const stepIndex = getDemoStepIndex(state);

  switch (nodeId) {
    case 'docs-draft':
      return {
        title: '翻倍按钮与验收标准',
        summary: '单一合成故事：新增翻倍按钮，既有计数操作保持不变。',
        rows: [
          { label: '新增能力', value: '“翻倍”按钮将当前值乘以 2' },
          { label: '保留能力', value: '原步长、增加、减少与重置' },
          { label: '验收样例', value: '1→2，3→6；增加/减少仍按原步长执行' },
          { label: '行为边界', value: '翻倍只作用于当前计数，不改变原按钮语义' },
          { label: '文档 PR', value: stepIndex >= 1 ? DEMO_STORY.documentPrLabel : '未记录' },
          { label: '合成时间', value: demoTime('draft') },
        ],
      };
    case 'docs-pr':
      return {
        title: '文档校验与合成 PR',
        summary: stepIndex >= 1 ? '需求正文通过结构与验收样例校验。' : '尚未开始文档校验。',
        rows: [
          { label: '文档校验', value: stepIndex >= 1 ? '通过' : '未执行', tone: stepIndex >= 1 ? 'success' : 'muted' },
          { label: '合成文档 PR', value: stepIndex >= 1 ? DEMO_STORY.documentPrLabel : '未记录' },
          { label: 'main 合并', value: stepIndex >= 3 ? DEMO_DOCUMENT_MAIN_SHA.slice(0, 12) : '未记录' },
          { label: '更新', value: stepIndex >= 1 ? demoTime('doc-pr') : '未记录' },
        ],
      };
    case 'docs-confirm':
      return {
        title: '第一次人工确认',
        summary:
          state.step === 'doc-confirm'
            ? '只在显式模拟确认后继续。播放、下一步、计时器和节点选择都不会越过此关口。'
            : stepIndex > 2
              ? '文档合并已完成一次显式模拟确认。'
              : '尚未到达文档人工确认关口。',
        rows: [
          { label: '关口状态', value: state.step === 'doc-confirm' ? '待人工确认' : stepIndex > 2 ? '已模拟确认' : '未到达', tone: state.step === 'doc-confirm' ? 'waiting' : stepIndex > 2 ? 'success' : 'muted' },
          { label: '合成文档 PR', value: stepIndex >= 1 ? DEMO_STORY.documentPrLabel : '未记录' },
          { label: '真实合并调用', value: '未触发（仅浏览器内模拟）', tone: 'muted' },
        ],
      };
    case 'docs-effective':
      return {
        title: 'main 需求生效',
        summary: stepIndex >= 3 ? '文档确认完成后，合成需求版本进入 main。' : '文档未确认前不会产生 main 生效证据。',
        rows: [
          { label: '文档 mergedMainSha', value: stepIndex >= 3 ? DEMO_DOCUMENT_MAIN_SHA : '未记录' },
          { label: '生效时间', value: stepIndex >= 3 ? demoTime('doc-effective') : '未记录' },
          { label: '开发任务', value: stepIndex >= 4 ? DEMO_STORY.issueLabel : '未记录' },
        ],
      };
    case 'task-sync':
      return {
        title: '同步开发任务',
        summary: stepIndex >= 4 ? 'Planner 根据已生效需求派生任务正文。' : 'main 生效前不会同步开发任务。',
        rows: [
          { label: 'Planner', value: stepIndex >= 4 ? '只派生任务正文' : '未执行' },
          { label: '自动 Reviewer', value: '未新增', tone: 'muted' },
          { label: '合成任务', value: stepIndex >= 4 ? DEMO_STORY.issueLabel : '未记录' },
          { label: '同步时间', value: stepIndex >= 4 ? demoTime('task-sync') : '未记录' },
        ],
      };
    case 'worker':
      return {
        title: 'Worker 编码与两次尝试',
        summary:
          state.attempts.length === 0
            ? '尚未进入 Worker 编码。'
            : state.attempts.length === 1
              ? '当前故事从第 1 次 Worker 尝试开始。'
              : '第 1 次失败被保留；显式重试后从 Worker 开始第 2 次尝试。',
        rows: [
          { label: '尝试 1', value: attemptValue(state, 1), tone: state.attempts[0]?.status === 'failed' ? 'failure' : undefined },
          { label: '尝试 2', value: attemptValue(state, 2) },
          { label: '重试方式', value: state.retryUsed ? '当前阶段显式模拟重试' : '尚未触发' },
        ],
      };
    case 'fixed-check':
      {
        const secondAttempt = state.attempts.find((attempt) => attempt.number === 2);
        const secondCheckRunning = state.step === 'check-retry';
        const secondCheckPassed = secondAttempt?.status === 'succeeded';
        const secondCheckValue = secondCheckPassed
          ? '通过'
          : secondCheckRunning
            ? '进行中'
            : '未执行';
      return {
        title: 'Node 24 固定检查',
        summary:
          state.step === 'check-failed'
            ? '首轮检查失败，代码 PR 尚未生成，等待人工模拟重试。'
            : secondCheckPassed
              ? '第二轮检查通过，首轮失败证据仍保留。'
              : secondCheckRunning
                ? '第二轮固定检查正在执行，尚未形成通过证据。'
                : secondAttempt
                  ? '第二轮 Worker 正在编码，固定检查尚未执行。'
              : stepIndex >= 6
                ? '首轮固定检查正在执行。'
                : '固定检查尚未执行。',
        rows: [
          { label: '检查 1', value: attemptValue(state, 1), tone: state.attempts[0]?.status === 'failed' ? 'failure' : undefined },
          { label: '失败项', value: state.attempts[0]?.status === 'failed' ? '翻倍行为断言未通过' : '未记录' },
          {
            label: '检查 2',
            value: secondCheckValue,
            tone: secondCheckPassed ? 'success' : secondCheckRunning ? 'waiting' : 'muted',
          },
          { label: '代码 PR', value: stepIndex >= 10 ? DEMO_STORY.codePrLabel : '未记录' },
        ],
      };
      }
    case 'check-retry':
      return {
        title: '失败记录与显式重试',
        summary:
          state.step === 'check-failed'
            ? '点击“模拟重试当前阶段”才会回到 Worker；该动作只生效一次。'
            : state.retryUsed
              ? '显式重试已发生，失败记录仍作为第 1 次 attempt 保留。'
              : '该回路只在固定检查失败时触发。',
        rows: [
          { label: '失败 attempt', value: attemptValue(state, 1) },
          { label: '重试 attempt', value: attemptValue(state, 2) },
          { label: '返回目标', value: 'Worker 编码' },
          { label: '真实重试调用', value: '未触发（仅浏览器内模拟）', tone: 'muted' },
        ],
      };
    case 'code-pr':
      return {
        title: '合成代码 PR',
        summary: stepIndex >= 10 ? '固定检查通过后才生成代码 PR。' : '固定检查未通过前不会生成代码 PR。',
        rows: [
          { label: '代码 PR', value: stepIndex >= 10 ? DEMO_STORY.codePrLabel : '未记录' },
          { label: '固定检查', value: attemptValue(state, 2) },
          { label: '失败历史', value: state.attempts[0]?.status === 'failed' ? 'attempt 1 保留' : '未记录' },
          { label: '生成时间', value: stepIndex >= 10 ? demoTime('code-pr') : '未记录' },
        ],
      };
    case 'code-confirm':
      return {
        title: '第二次人工确认',
        summary:
          state.step === 'code-confirm'
            ? '只在显式模拟确认代码合并后继续；所有普通推进动作和节点选择都不能越过此关口。'
            : stepIndex > 11
              ? '代码合并已完成一次显式模拟确认。'
              : '尚未到达代码人工确认关口。',
        rows: [
          { label: '关口状态', value: state.step === 'code-confirm' ? '待人工确认' : stepIndex > 11 ? '已模拟确认' : '未到达', tone: state.step === 'code-confirm' ? 'waiting' : stepIndex > 11 ? 'success' : 'muted' },
          { label: '合成代码 PR', value: stepIndex >= 10 ? DEMO_STORY.codePrLabel : '未记录' },
          { label: '构建开始', value: stepIndex >= 12 ? demoTime('build') : '未记录' },
          { label: '真实合并调用', value: '未触发（仅浏览器内模拟）', tone: 'muted' },
        ],
      };
    case 'candidate-build':
      {
        const buildIndex = DEMO_STEP_SEQUENCE.indexOf('build');
        const buildPassed = stepIndex > buildIndex;
        const buildRunning = state.step === 'build';
      return {
        title: '候选版本构建',
        summary: buildPassed
          ? '候选版本构建完成，已进入候选健康检查。'
          : buildRunning
            ? '代码确认已完成，候选版本正在构建，尚未形成成功证据。'
            : '代码人工确认前不会开始构建。',
        rows: [
          {
            label: '构建状态',
            value: buildPassed ? '成功' : buildRunning ? '进行中' : '未执行',
            tone: buildPassed ? 'success' : buildRunning ? 'waiting' : 'muted',
          },
          { label: '候选版本', value: buildPassed || buildRunning ? 'DEMO-CANDIDATE-20261115-001' : '未记录' },
          { label: '稳定预览', value: stepIndex >= 14 ? DEMO_NEW_PREVIEW_SHA : DEMO_OLD_PREVIEW_SHA },
        ],
      };
      }
    case 'candidate-health':
      {
        const healthIndex = DEMO_STEP_SEQUENCE.indexOf('health');
        const healthPassed = stepIndex > healthIndex;
        const healthRunning = state.step === 'health';
      return {
        title: '候选版本健康检查',
        summary: healthPassed
          ? '候选版本健康检查通过，允许进入稳定预览切换。'
          : healthRunning
            ? '候选健康检查正在执行，尚未形成通过证据。'
            : '候选健康检查尚未执行。',
        rows: [
          {
            label: '健康检查',
            value: healthPassed ? '通过' : healthRunning ? '进行中' : '未执行',
            tone: healthPassed ? 'success' : healthRunning ? 'waiting' : 'muted',
          },
          { label: '检查时间', value: healthPassed ? demoTime('health') : healthRunning ? `${demoTime('health')}（开始）` : '未记录' },
          { label: '预览切换', value: stepIndex >= 14 ? '已切换' : '未记录' },
        ],
      };
      }
    case 'preview-switch':
      return {
        title: '稳定预览切换',
        summary: stepIndex >= 14 ? '健康检查通过后，合成稳定预览已切换到候选版本。' : '健康检查通过前不会切换稳定预览。',
        rows: [
          { label: '切换前', value: DEMO_OLD_PREVIEW_SHA },
          { label: '切换后', value: stepIndex >= 14 ? DEMO_NEW_PREVIEW_SHA : '未记录' },
          { label: '切换时间', value: stepIndex >= 14 ? demoTime('preview') : '未记录' },
        ],
      };
    case 'deploy-receipt':
      return {
        title: '部署记录与回执',
        summary:
          state.step === 'receipt'
            ? '部署已成功，回执仍在写入；部署成功证据保持有效。'
            : stepIndex >= 16
              ? '部署记录和回执均已形成。'
              : stepIndex >= 14
                ? '稳定预览已切换，等待记录回执。'
                : '尚未产生部署记录。',
        rows: [
          { label: '部署结果', value: stepIndex >= 14 ? '成功' : '未执行', tone: stepIndex >= 14 ? 'success' : 'muted' },
          { label: '部署 SHA', value: stepIndex >= 14 ? DEMO_NEW_PREVIEW_SHA : '未记录' },
          { label: '回执', value: stepIndex >= 16 ? 'DEMO-RECEIPT-001' : stepIndex >= 15 ? '待补' : '未记录', tone: stepIndex >= 16 ? 'success' : stepIndex >= 15 ? 'waiting' : 'muted' },
        ],
      };
    case 'complete':
      return {
        title: '全流程完成',
        summary: stepIndex >= 16 ? '文档、代码、部署、健康检查与回执证据完整。' : '流程尚未完成。',
        rows: [
          { label: '最终状态', value: stepIndex >= 16 ? '完成' : '未完成', tone: stepIndex >= 16 ? 'success' : 'muted' },
          { label: '部署 SHA', value: stepIndex >= 16 ? DEMO_NEW_PREVIEW_SHA : '未记录' },
          { label: '回执', value: stepIndex >= 16 ? 'DEMO-RECEIPT-001' : '未记录' },
          { label: '完成时间', value: state.completedAt ?? '未记录' },
        ],
      };
    case 'terminal-branches':
      return {
        title: '终止次级分支（未触发）',
        summary: '这些分支只说明终止语义，在当前故事中保持灰色，不会推进主剧情。',
        rows: [
          { label: '文档 PR 关闭', value: '终止交付，不创建开发 Issue', tone: 'muted' },
          { label: '需求版本过期', value: '停止旧需求对应交付', tone: 'muted' },
        ],
      };
    case 'build-retry':
      return {
        title: '构建 / 健康失败分支（未触发）',
        summary: '当前故事只触发固定检查失败。该分支说明部署阶段的恢复边界。',
        rows: [
          { label: '构建或健康失败', value: '保留旧预览', tone: 'muted' },
          { label: '恢复动作', value: '只重试构建部署，不回到 Worker', tone: 'muted' },
        ],
      };
    case 'receipt-retry':
      return {
        title: '回执补偿分支（未触发）',
        summary: '部署成功但回执失败时，只补回执并保留部署成功证据。',
        rows: [
          { label: '部署', value: '保持成功', tone: 'muted' },
          { label: '补偿动作', value: '只重试回执写入，不回到 Worker', tone: 'muted' },
        ],
      };
    default:
      return { title: '流程节点', summary: '当前节点没有额外合成证据。', rows: [] };
  }
}

export function buildDemoEvidence(state: DemoState, nodeId: string | null): DemoEvidence | null {
  if (!nodeId) return null;
  return evidenceForNode(state, nodeId);
}

export function getDemoStepLabel(state: DemoState): string {
  if (state.step === 'check-failed') return '失败记录 / 等待显式重试';
  return MAIN_NODE_SPECS[STEP_MAIN_INDEX[state.step]]!.label;
}

export function getDemoPreviewShas(): { previous: string; active: string } {
  return { previous: DEMO_OLD_PREVIEW_SHA, active: DEMO_NEW_PREVIEW_SHA };
}
