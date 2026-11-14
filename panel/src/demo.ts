import type {
  PanelDeliveryAttempt,
  PanelDeliveryGroup,
  PanelNode,
  PanelRequest,
  PanelStatus,
  PanelView,
} from './types';

export type DemoScenarioKey = 'running' | 'waiting' | 'failed' | 'retry-success' | 'deployed';

interface DemoFrame {
  activeIndex: number;
  activeStatus: PanelStatus;
  detail: string;
  label: string;
}

export interface DemoScenario {
  key: DemoScenarioKey;
  label: string;
  description: string;
  frames: readonly DemoFrame[];
}

export const DEMO_FLOW = [
  { id: 'receive', label: '接收需求' },
  { id: 'docs-pr', label: '生成文档PR' },
  { id: 'docs-confirm', label: '文档人工确认' },
  { id: 'sync-task', label: '同步开发任务' },
  { id: 'code-verify', label: '编码与验证' },
  { id: 'code-confirm', label: '代码人工确认' },
  { id: 'build-deploy', label: '构建与部署' },
  { id: 'health-receipt', label: '健康检查与回执' },
] as const;

export const DEMO_SCENARIOS: readonly DemoScenario[] = [
  {
    key: 'running',
    label: '运行中',
    description: '文档已合并，代码交付正在执行固定检查。',
    frames: [
      { activeIndex: 3, activeStatus: 'succeeded', detail: '开发任务已同步，准备执行编码', label: '任务同步完成' },
      { activeIndex: 4, activeStatus: 'running', detail: '正在生成代码变更并执行固定检查', label: '编码与验证进行中' },
    ],
  },
  {
    key: 'waiting',
    label: '待人工确认',
    description: '文档与代码链路正常推进，当前等待明确的人工确认节点。',
    frames: [
      { activeIndex: 4, activeStatus: 'succeeded', detail: '编码与验证通过，等待创建代码 PR', label: '代码检查通过' },
      { activeIndex: 5, activeStatus: 'waiting', detail: '等待人工确认代码 PR', label: '等待代码确认' },
    ],
  },
  {
    key: 'failed',
    label: '失败',
    description: '固定验证失败，后续阶段未执行并保留失败证据。',
    frames: [
      { activeIndex: 4, activeStatus: 'running', detail: '正在执行固定测试与类型检查', label: '固定检查进行中' },
      { activeIndex: 4, activeStatus: 'failed', detail: '固定测试未通过，后续步骤尚未执行', label: '验证失败' },
    ],
  },
  {
    key: 'retry-success',
    label: '重试后成功',
    description: '首轮失败记录仍被保留，第二次尝试已进入待确认阶段。',
    frames: [
      { activeIndex: 4, activeStatus: 'failed', detail: '首轮第二次检查失败，等待恢复', label: '首轮尝试失败' },
      { activeIndex: 4, activeStatus: 'running', detail: '从失败阶段恢复，执行第二次尝试', label: '第二次尝试运行中' },
      { activeIndex: 5, activeStatus: 'waiting', detail: '重试后已进入代码人工确认', label: '重试后等待确认' },
    ],
  },
  {
    key: 'deployed',
    label: '已部署',
    description: '代码、部署、健康检查与回执证据已完整形成。',
    frames: [
      { activeIndex: 6, activeStatus: 'running', detail: '正在发布已确认的代码交付', label: '构建与部署进行中' },
      { activeIndex: 7, activeStatus: 'running', detail: '部署完成，正在检查健康状态并补齐回执', label: '健康检查与回执' },
      { activeIndex: 7, activeStatus: 'succeeded', detail: '健康检查通过，部署回执已记录', label: '全链路完成' },
    ],
  },
];

const DEMO_REQUEST_ID = 'REQ-20261115-DEMO0001';
const DEMO_HISTORY_REQUEST_ID = 'REQ-20261114-DEMO0000';
const DEMO_CURRENT_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const DEMO_PREVIOUS_SHA = '0f1e2d3c4b5a69788796a5b4c3d2e1f001234567';

const STAGE_DETAILS = [
  '需求文本已通过入口校验',
  '文档 PR 已生成，等待人工确认',
  '文档变更已合并到 main',
  '开发任务已绑定需求版本',
  '固定类型检查、测试与构建',
  '代码 PR 已进入人工确认',
  '发布已确认代码并保留回滚版本',
  '检查部署健康与通知回执',
] as const;

function demoNode(index: number, frame: DemoFrame): PanelNode {
  let status: PanelStatus;
  if (index < frame.activeIndex) status = 'succeeded';
  else if (index === frame.activeIndex) status = frame.activeStatus;
  else status = 'pending';

  const detail =
    index === frame.activeIndex
      ? frame.detail
      : status === 'succeeded'
        ? STAGE_DETAILS[index]!
        : '依赖前序步骤，尚未执行';

  return {
    id: DEMO_FLOW[index]!.id,
    label: DEMO_FLOW[index]!.label,
    status,
    current: index === frame.activeIndex,
    detail,
  };
}

function buildNodes(frame: DemoFrame): PanelNode[] {
  return DEMO_FLOW.map((_, index) => demoNode(index, frame));
}

function requestStatus(frame: DemoFrame): PanelStatus {
  if (frame.activeIndex === 7 && frame.activeStatus === 'succeeded') return 'succeeded';
  if (frame.activeStatus === 'running' && frame.activeIndex < 5) return 'running';
  return frame.activeStatus;
}

function demoTimestamp(frameIndex: number): string {
  return new Date(Date.UTC(2026, 10, 15, 8, 10 + frameIndex * 3)).toISOString();
}

function attemptForScenario(
  scenario: DemoScenarioKey,
  frame: DemoFrame,
  frameIndex: number,
): PanelDeliveryAttempt[] {
  const latestStatus = requestStatus(frame);
  const latest: PanelDeliveryAttempt = {
    attempt: scenario === 'retry-success' ? 2 : 1,
    status: latestStatus,
    failureStage:
      latestStatus === 'failed' ? (frame.activeIndex <= 4 ? 'verify' : 'deploy') : null,
    prNumber: frame.activeIndex >= 5 ? 128 : null,
    prUrl: null,
    issueNumber: 87,
    isLatest: true,
    deployStatus:
      scenario === 'deployed' && frame.activeIndex === 7 && frame.activeStatus === 'succeeded'
        ? 'deployed'
        : frame.activeIndex === 7 && frame.activeStatus === 'running'
          ? 'receipt-pending'
          : 'none',
    startedAt: demoTimestamp(frameIndex),
    updatedAt: demoTimestamp(frameIndex + 1),
  };

  if (scenario !== 'retry-success') return [latest];

  return [
    {
      ...latest,
      attempt: 1,
      status: 'failed',
      failureStage: 'verify',
      prNumber: null,
      isLatest: false,
      deployStatus: 'none',
      startedAt: demoTimestamp(0),
      updatedAt: demoTimestamp(1),
    },
    latest,
  ];
}

function historicalNodes(): PanelNode[] {
  const frame: DemoFrame = {
    activeIndex: 3,
    activeStatus: 'failed',
    detail: '历史交付在同步开发任务时失败，未进入编码',
    label: '历史失败',
  };
  return buildNodes(frame);
}

export function getDemoScenario(key: DemoScenarioKey): DemoScenario {
  return DEMO_SCENARIOS.find((scenario) => scenario.key === key) ?? DEMO_SCENARIOS[0]!;
}

export function buildDemoView(
  scenarioKey: DemoScenarioKey,
  frameIndex: number,
): PanelView {
  const scenario = getDemoScenario(scenarioKey);
  const safeIndex = Math.max(0, Math.min(frameIndex, scenario.frames.length - 1));
  const frame = scenario.frames[safeIndex]!;
  const nodes = buildNodes(frame);
  const attempts = attemptForScenario(scenario.key, frame, safeIndex);
  const status = requestStatus(frame);

  const currentRequest: PanelRequest = {
    requestId: DEMO_REQUEST_ID,
    targetReqId: 'REQ-CNT-01',
    stage: frame.activeIndex >= 5 ? 'pr-merged' : frame.activeIndex === 4 ? 'write' : 'pr-merged',
    status,
    prNumber: 126,
    prUrl: null,
    summary: `【演示】${scenario.label}：计数器需求文档`,
    mergedMainSha: DEMO_CURRENT_SHA,
    createdAt: demoTimestamp(0),
    updatedAt: demoTimestamp(safeIndex + 1),
    superseded: false,
    linkedDeliveryIds: ['demo-delivery-current'],
    nodes,
  };

  const historicalRequest: PanelRequest = {
    requestId: DEMO_HISTORY_REQUEST_ID,
    targetReqId: 'REQ-CNT-01',
    stage: 'failed',
    status: 'failed',
    prNumber: 119,
    prUrl: null,
    summary: '【演示】历史需求：旧版本交付已过期',
    mergedMainSha: DEMO_PREVIOUS_SHA,
    createdAt: '2026-11-14T03:20:00.000Z',
    updatedAt: '2026-11-14T04:02:00.000Z',
    superseded: true,
    linkedDeliveryIds: [],
    nodes: historicalNodes(),
  };

  const currentDelivery: PanelDeliveryGroup = {
    id: 'demo-delivery-current',
    reqId: 'REQ-CNT-01',
    specHash: '7bd7c5b59788d4b239f13222f10f2ea87535fce9c93fef4df221d2c8d6668a01',
    sourceMainSha: DEMO_CURRENT_SHA,
    issueNumber: 87,
    createdAt: demoTimestamp(0),
    updatedAt: demoTimestamp(safeIndex + 1),
    superseded: false,
    linkBasis: 'exact',
    linkedRequestId: DEMO_REQUEST_ID,
    attempts,
    nodes,
  };

  const historicalDelivery: PanelDeliveryGroup = {
    id: 'demo-delivery-history',
    reqId: 'REQ-CNT-01',
    specHash: '22596ea5d9fa8101d63dd449575e3f52f65fa984653b56f86aa8f92aa624751b',
    sourceMainSha: DEMO_PREVIOUS_SHA,
    issueNumber: 79,
    createdAt: '2026-11-14T03:20:00.000Z',
    updatedAt: '2026-11-14T04:02:00.000Z',
    superseded: true,
    linkBasis: 'hash-only',
    linkedRequestId: null,
    attempts: [
      {
        attempt: 1,
        status: 'failed',
        failureStage: 'publish',
        prNumber: 119,
        prUrl: null,
        issueNumber: 79,
        isLatest: true,
        deployStatus: 'none',
        startedAt: '2026-11-14T03:22:00.000Z',
        updatedAt: '2026-11-14T04:02:00.000Z',
      },
    ],
    nodes: historicalNodes(),
  };

  return {
    schemaVersion: 'panel/v1',
    observedAt: demoTimestamp(safeIndex + 1),
    stateUpdatedAt: demoTimestamp(safeIndex + 1),
    stateKind: 'ok',
    repo: 'demo/spec-loop',
    controllerOnline: true,
    cursorMainSha: DEMO_CURRENT_SHA,
    requests: [currentRequest, historicalRequest],
    deliveryGroups: [currentDelivery, historicalDelivery],
    deploy: {
      activeSha:
        scenario.key === 'deployed' && safeIndex === scenario.frames.length - 1
          ? DEMO_CURRENT_SHA
          : DEMO_PREVIOUS_SHA,
      deployedPRs:
        scenario.key === 'deployed' && safeIndex === scenario.frames.length - 1 ? [128] : [96],
      deployFailedPRs: scenario.key === 'failed' && frame.activeIndex >= 6 ? [128] : [],
    },
    nodes,
  };
}

export function getScenarioFrameLabel(
  scenarioKey: DemoScenarioKey,
  frameIndex: number,
): string {
  const scenario = getDemoScenario(scenarioKey);
  const safeIndex = Math.max(0, Math.min(frameIndex, scenario.frames.length - 1));
  return scenario.frames[safeIndex]!.label;
}
