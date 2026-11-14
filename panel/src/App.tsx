import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import {
  DEMO_SCENARIOS,
  buildDemoView,
  getDemoScenario,
  getScenarioFrameLabel,
  type DemoScenarioKey,
} from './demo';
import { FlowCanvas, STATUS_TEXT } from './flow';
import type {
  DeliveryDeployStatus,
  LinkBasis,
  PanelDeliveryAttempt,
  PanelDeliveryGroup,
  PanelNode,
  PanelRequest,
  PanelStateKind,
  PanelStatus,
  PanelView,
  Scope,
} from './types';

type FetchState = 'loading' | 'live' | 'stale' | 'offline';

const EMPTY_NODES: PanelNode[] = [
  ['receive', '接收需求'],
  ['docs-pr', '生成文档PR'],
  ['docs-confirm', '文档人工确认'],
  ['sync-task', '同步开发任务'],
  ['code-verify', '编码与验证'],
  ['code-confirm', '代码人工确认'],
  ['build-deploy', '构建与部署'],
  ['health-receipt', '健康检查与回执'],
].map(([id, label], index) => ({
  id: id!,
  label: label!,
  status: 'unknown',
  current: index === 0,
  detail: '尚未取得可用的流程快照',
}));

const LINK_BASIS_TEXT: Record<LinkBasis, string> = {
  exact: '严格关联',
  'hash-only': '内容匹配',
  unconfirmed: '关联未确认',
  none: '独立交付',
};

const DEPLOY_TEXT: Record<DeliveryDeployStatus, string> = {
  deployed: '已部署',
  'deploy-failed': '部署失败',
  'receipt-pending': '部署成功，回执待补',
  none: '无部署记录',
};

const STATE_KIND_TEXT: Record<PanelStateKind, string> = {
  ok: '状态可用',
  missing: '状态文件缺失',
  invalid: '状态文件损坏',
  unsupported: '状态版本不支持',
};

const FAILURE_STAGE_TEXT: Record<string, string> = {
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

const STATUS_GUIDANCE: Record<PanelStatus, string> = {
  pending: '该阶段尚未执行，当前没有可用证据。',
  running: '控制器已记录该阶段正在执行。',
  waiting: '当前待人工确认，不视为执行卡死。',
  succeeded: '已有记录支持该阶段完成。',
  failed: '该阶段记录失败，后续阶段需要重新取得执行证据。',
  stale: '交付已过期或被替换，不再作为当前发布依据。',
  unknown: '现有记录不足以支持确定状态。',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isPanelView(value: unknown): value is PanelView {
  if (!isRecord(value)) return false;
  return (
    value.schemaVersion === 'panel/v1' &&
    typeof value.observedAt === 'string' &&
    ['ok', 'missing', 'invalid', 'unsupported'].includes(String(value.stateKind)) &&
    typeof value.controllerOnline === 'boolean' &&
    Array.isArray(value.requests) &&
    Array.isArray(value.deliveryGroups) &&
    Array.isArray(value.nodes) &&
    isRecord(value.deploy)
  );
}

async function fetchPanelView(signal: AbortSignal): Promise<PanelView> {
  const response = await fetch('/api/panel', {
    method: 'GET',
    cache: 'no-store',
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!response.ok) throw new Error('Panel API rejected the request');
  const payload: unknown = await response.json();
  if (!isPanelView(payload)) throw new Error('Panel API returned an invalid view');
  return payload;
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return '未记录';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '未记录';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

function formatClock(value: Date | null): string {
  if (!value || !Number.isFinite(value.getTime())) return '尚未成功刷新';
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(value);
}

function shortSha(value: string | null): string {
  return value ? value.slice(0, 8) : '未记录';
}

function shortText(value: string, max = 42): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function safeGitHubPrUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com') return null;
    return url.href;
  } catch {
    return null;
  }
}

function sortNewestFirst<T extends { updatedAt: string | null }>(items: T[]): T[] {
  return [...items].sort((left, right) => {
    const leftTime = left.updatedAt ? Date.parse(left.updatedAt) : 0;
    const rightTime = right.updatedAt ? Date.parse(right.updatedAt) : 0;
    return rightTime - leftTime;
  });
}

function scopeNodes(view: PanelView | null, scope: Scope): PanelNode[] {
  if (!view) return EMPTY_NODES;
  if (scope?.type === 'request') {
    return view.requests.find((request) => request.requestId === scope.id)?.nodes ?? view.nodes;
  }
  if (scope?.type === 'delivery') {
    return view.deliveryGroups.find((delivery) => delivery.id === scope.id)?.nodes ?? view.nodes;
  }
  return view.nodes;
}

function StatusBadge({
  status,
  compact = false,
}: {
  status: PanelStatus;
  compact?: boolean;
}): JSX.Element {
  return (
    <span className={`status-badge status-${status}${compact ? ' compact' : ''}`}>
      <span className="status-badge-dot" />
      {STATUS_TEXT[status]}
    </span>
  );
}

function ExternalPrLink({
  url,
  number,
  label = '打开 PR',
}: {
  url: string | null;
  number: number | null;
  label?: string;
}): JSX.Element {
  const safeUrl = safeGitHubPrUrl(url);
  if (!number) return <span className="muted-value">未记录</span>;
  if (!safeUrl) return <span className="mono-value">PR #{number}</span>;
  return (
    <a href={safeUrl} target="_blank" rel="noreferrer" className="external-link">
      {label} #{number}
      <span aria-hidden="true">↗</span>
    </a>
  );
}

function WorkspaceListSection({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="workspace-list-section">
      <div className="list-section-heading">
        <span>{title}</span>
        <span className="list-count">{count}</span>
      </div>
      {children}
    </section>
  );
}

function RequestItem({
  request,
  selected,
  onSelect,
}: {
  request: PanelRequest;
  selected: boolean;
  onSelect: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className={`workspace-item${selected ? ' selected' : ''}`}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <span className="workspace-item-topline">
        <span className="item-target">{request.targetReqId}</span>
        <StatusBadge status={request.status} compact />
      </span>
      <span className="workspace-item-title">
        {request.summary ?? `${request.targetReqId} 文档变更`}
      </span>
      <span className="workspace-item-meta">
        <span>{request.prNumber ? `文档 PR #${request.prNumber}` : '文档 PR 未记录'}</span>
        <span>{formatDateTime(request.updatedAt)}</span>
      </span>
    </button>
  );
}

function DeliveryItem({
  delivery,
  selected,
  onSelect,
}: {
  delivery: PanelDeliveryGroup;
  selected: boolean;
  onSelect: () => void;
}): JSX.Element {
  const latest = delivery.attempts.find((attempt) => attempt.isLatest) ?? delivery.attempts.at(-1);
  return (
    <button
      type="button"
      className={`workspace-item${selected ? ' selected' : ''}`}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <span className="workspace-item-topline">
        <span className="item-target">{delivery.reqId}</span>
        <StatusBadge status={latest?.status ?? 'unknown'} compact />
      </span>
      <span className="workspace-item-title">
        代码交付 · {delivery.attempts.length} 次尝试
      </span>
      <span className="workspace-item-meta">
        <span>{LINK_BASIS_TEXT[delivery.linkBasis]}</span>
        <span>spec {shortSha(delivery.specHash)}</span>
      </span>
    </button>
  );
}

function EmptyList({ text }: { text: string }): JSX.Element {
  return <p className="list-empty">{text}</p>;
}

function Sidebar({
  view,
  scope,
  onSelectScope,
}: {
  view: PanelView | null;
  scope: Scope;
  onSelectScope: (next: Scope) => void;
}): JSX.Element {
  const requests = useMemo(() => sortNewestFirst(view?.requests ?? []), [view?.requests]);
  const deliveries = useMemo(
    () => sortNewestFirst(view?.deliveryGroups ?? []),
    [view?.deliveryGroups],
  );
  const currentRequests = requests.filter((request) => !request.superseded);
  const historicalRequests = requests.filter((request) => request.superseded);
  const currentDeliveries = deliveries.filter((delivery) => !delivery.superseded);
  const historicalDeliveries = deliveries.filter((delivery) => delivery.superseded);

  return (
    <aside className="sidebar" aria-label="需求与交付列表">
      <div className="sidebar-heading">
        <div>
          <span className="eyebrow">WORKSPACE</span>
          <h2>交付工作台</h2>
        </div>
        <span className="sidebar-total">
          {requests.length + deliveries.length}
        </span>
      </div>

      <button
        type="button"
        className={`overview-button${scope === null ? ' selected' : ''}`}
        aria-pressed={scope === null}
        onClick={() => onSelectScope(null)}
      >
        <span className="overview-symbol" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <span>
          <strong>全链路总览</strong>
          <small>查看当前控制器快照</small>
        </span>
      </button>

      <div className="sidebar-scroll">
        <WorkspaceListSection title="当前需求" count={currentRequests.length}>
          {currentRequests.length > 0 ? (
            currentRequests.map((request) => (
              <RequestItem
                key={request.requestId}
                request={request}
                selected={scope?.type === 'request' && scope.id === request.requestId}
                onSelect={() => onSelectScope({ type: 'request', id: request.requestId })}
              />
            ))
          ) : (
            <EmptyList text="暂无当前需求请求" />
          )}
        </WorkspaceListSection>

        <WorkspaceListSection title="当前代码交付" count={currentDeliveries.length}>
          {currentDeliveries.length > 0 ? (
            currentDeliveries.map((delivery) => (
              <DeliveryItem
                key={delivery.id}
                delivery={delivery}
                selected={scope?.type === 'delivery' && scope.id === delivery.id}
                onSelect={() => onSelectScope({ type: 'delivery', id: delivery.id })}
              />
            ))
          ) : (
            <EmptyList text="暂无当前代码交付" />
          )}
        </WorkspaceListSection>

        {historicalRequests.length + historicalDeliveries.length > 0 ? (
          <WorkspaceListSection
            title="历史记录"
            count={historicalRequests.length + historicalDeliveries.length}
          >
            {historicalRequests.map((request) => (
              <RequestItem
                key={request.requestId}
                request={request}
                selected={scope?.type === 'request' && scope.id === request.requestId}
                onSelect={() => onSelectScope({ type: 'request', id: request.requestId })}
              />
            ))}
            {historicalDeliveries.map((delivery) => (
              <DeliveryItem
                key={delivery.id}
                delivery={delivery}
                selected={scope?.type === 'delivery' && scope.id === delivery.id}
                onSelect={() => onSelectScope({ type: 'delivery', id: delivery.id })}
              />
            ))}
          </WorkspaceListSection>
        ) : null}
      </div>
    </aside>
  );
}

function DetailRow({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="detail-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function AttemptCard({ attempt }: { attempt: PanelDeliveryAttempt }): JSX.Element {
  return (
    <article className={`attempt-card${attempt.isLatest ? ' latest' : ''}`}>
      <div className="attempt-heading">
        <span>
          <strong>尝试 {attempt.attempt}</strong>
          {attempt.isLatest ? <span className="latest-tag">最新</span> : <span className="past-tag">历史</span>}
        </span>
        <StatusBadge status={attempt.status} compact />
      </div>
      <div className="attempt-meta">
        <span>
          {attempt.failureStage
            ? `失败阶段：${FAILURE_STAGE_TEXT[attempt.failureStage] ?? attempt.failureStage}`
            : '失败阶段：未记录'}
        </span>
        <span>{DEPLOY_TEXT[attempt.deployStatus]}</span>
      </div>
      <div className="attempt-links">
        <ExternalPrLink url={attempt.prUrl} number={attempt.prNumber} label="代码 PR" />
        <span>任务 #{attempt.issueNumber}</span>
      </div>
      <div className="attempt-times">
        <span>开始 {formatDateTime(attempt.startedAt)}</span>
        <span>更新 {formatDateTime(attempt.updatedAt)}</span>
      </div>
    </article>
  );
}

function RequestContext({ request }: { request: PanelRequest }): JSX.Element {
  return (
    <section className="context-card">
      <div className="context-heading">
        <div>
          <span className="eyebrow">REQUEST CONTEXT</span>
          <h3>需求请求</h3>
        </div>
        {request.superseded ? <span className="history-tag">历史需求</span> : null}
      </div>
      <p className="context-title">{request.summary ?? `${request.targetReqId} 文档变更`}</p>
      <dl className="context-list">
        <DetailRow label="目标需求">
          <span className="mono-value">{request.targetReqId}</span>
        </DetailRow>
        <DetailRow label="文档 PR">
          <ExternalPrLink url={request.prUrl} number={request.prNumber} label="文档 PR" />
        </DetailRow>
        <DetailRow label="合并主线">
          <span className="mono-value" title={request.mergedMainSha ?? undefined}>
            {shortSha(request.mergedMainSha)}
          </span>
        </DetailRow>
        <DetailRow label="创建时间">{formatDateTime(request.createdAt)}</DetailRow>
        <DetailRow label="最近更新">{formatDateTime(request.updatedAt)}</DetailRow>
        <DetailRow label="关联交付">{request.linkedDeliveryIds.length} 项</DetailRow>
      </dl>
    </section>
  );
}

function DeliveryContext({ delivery }: { delivery: PanelDeliveryGroup }): JSX.Element {
  return (
    <section className="context-card">
      <div className="context-heading">
        <div>
          <span className="eyebrow">DELIVERY CONTEXT</span>
          <h3>代码交付</h3>
        </div>
        {delivery.superseded ? <span className="history-tag">历史交付</span> : null}
      </div>
      <dl className="context-list">
        <DetailRow label="目标需求">
          <span className="mono-value">{delivery.reqId}</span>
        </DetailRow>
        <DetailRow label="关联依据">
          <span>{LINK_BASIS_TEXT[delivery.linkBasis]}</span>
        </DetailRow>
        <DetailRow label="规范哈希">
          <span className="mono-value" title={delivery.specHash}>
            {shortSha(delivery.specHash)}
          </span>
        </DetailRow>
        <DetailRow label="来源主线">
          <span className="mono-value" title={delivery.sourceMainSha}>
            {shortSha(delivery.sourceMainSha)}
          </span>
        </DetailRow>
        <DetailRow label="开发任务">#{delivery.issueNumber}</DetailRow>
        <DetailRow label="创建时间">{formatDateTime(delivery.createdAt)}</DetailRow>
      </dl>
      <div className="attempt-stack">
        {delivery.attempts.length > 0 ? (
          delivery.attempts.map((attempt) => (
            <AttemptCard key={`${delivery.id}-${attempt.attempt}`} attempt={attempt} />
          ))
        ) : (
          <p className="list-empty">暂无尝试记录</p>
        )}
      </div>
    </section>
  );
}

function OverviewContext({ view }: { view: PanelView | null }): JSX.Element {
  return (
    <section className="context-card">
      <div className="context-heading">
        <div>
          <span className="eyebrow">DEPLOYMENT SNAPSHOT</span>
          <h3>发布快照</h3>
        </div>
      </div>
      <dl className="context-list">
        <DetailRow label="当前部署">
          <span className="mono-value" title={view?.deploy.activeSha ?? undefined}>
            {shortSha(view?.deploy.activeSha ?? null)}
          </span>
        </DetailRow>
        <DetailRow label="已部署 PR">
          {view?.deploy.deployedPRs.length ? view.deploy.deployedPRs.join('、') : '未记录'}
        </DetailRow>
        <DetailRow label="部署失败 PR">
          {view?.deploy.deployFailedPRs.length ? view.deploy.deployFailedPRs.join('、') : '未记录'}
        </DetailRow>
        <DetailRow label="主线游标">
          <span className="mono-value" title={view?.cursorMainSha ?? undefined}>
            {shortSha(view?.cursorMainSha ?? null)}
          </span>
        </DetailRow>
      </dl>
    </section>
  );
}

function DetailsPanel({
  view,
  scope,
  selectedNode,
}: {
  view: PanelView | null;
  scope: Scope;
  selectedNode: PanelNode | null;
}): JSX.Element {
  const request =
    scope?.type === 'request'
      ? view?.requests.find((item) => item.requestId === scope.id) ?? null
      : null;
  const delivery =
    scope?.type === 'delivery'
      ? view?.deliveryGroups.find((item) => item.id === scope.id) ?? null
      : null;
  const stageIndex = view?.nodes.findIndex((node) => node.id === selectedNode?.id) ?? -1;

  return (
    <aside className="details-panel" aria-label="节点详情">
      <div className="details-heading">
        <div>
          <span className="eyebrow">INSPECTOR</span>
          <h2>节点详情</h2>
        </div>
        <span className="readonly-label">只读</span>
      </div>

      <div className="details-scroll">
        {selectedNode ? (
          <section className="node-detail-card">
            <div className="node-detail-topline">
              <span className="node-detail-index">
                {stageIndex >= 0 ? String(stageIndex + 1).padStart(2, '0') : '—'}
              </span>
              <StatusBadge status={selectedNode.status} />
              {selectedNode.current ? <span className="current-detail-tag">当前节点</span> : null}
            </div>
            <h3>{selectedNode.label}</h3>
            <p className="node-detail-copy">{selectedNode.detail}</p>
            <div className="status-guidance">
              <span className="guidance-mark" aria-hidden="true" />
              <p>{STATUS_GUIDANCE[selectedNode.status]}</p>
            </div>
            <dl className="context-list node-facts">
              <DetailRow label="阶段位置">
                {stageIndex >= 0 ? `第 ${stageIndex + 1} / 8 阶段` : '未记录'}
              </DetailRow>
              <DetailRow label="当前焦点">{selectedNode.current ? '是' : '否'}</DetailRow>
              <DetailRow label="观测时间">{formatDateTime(view?.observedAt)}</DetailRow>
              <DetailRow label="状态更新时间">{formatDateTime(view?.stateUpdatedAt)}</DetailRow>
            </dl>
          </section>
        ) : (
          <section className="node-detail-card empty-detail">
            <span className="empty-orbit" aria-hidden="true" />
            <h3>等待流程数据</h3>
            <p>面板取得可用快照后，将自动聚焦当前阶段。</p>
          </section>
        )}

        {request ? <RequestContext request={request} /> : null}
        {delivery ? <DeliveryContext delivery={delivery} /> : null}
        {!request && !delivery ? <OverviewContext view={view} /> : null}
      </div>
    </aside>
  );
}

function DemoControls({
  scenarioKey,
  frameIndex,
  playing,
  onScenarioChange,
  onTogglePlay,
  onReset,
}: {
  scenarioKey: DemoScenarioKey;
  frameIndex: number;
  playing: boolean;
  onScenarioChange: (key: DemoScenarioKey) => void;
  onTogglePlay: () => void;
  onReset: () => void;
}): JSX.Element {
  const scenario = getDemoScenario(scenarioKey);
  const atLastFrame = frameIndex >= scenario.frames.length - 1;

  return (
    <section className="demo-controls" aria-label="演示时间线">
      <div className="demo-controls-copy">
        <div className="demo-controls-heading">
          <strong>合成时间线</strong>
          <span>
            帧 {frameIndex + 1} / {scenario.frames.length}
          </span>
        </div>
        <p>{scenario.description}</p>
      </div>

      <label className="scenario-field">
        <span>演示场景</span>
        <select
          value={scenarioKey}
          onChange={(event) => onScenarioChange(event.target.value as DemoScenarioKey)}
        >
          {DEMO_SCENARIOS.map((item) => (
            <option key={item.key} value={item.key}>
              {item.label}
            </option>
          ))}
        </select>
      </label>

      <div className="timeline-track" aria-label={`当前：${getScenarioFrameLabel(scenarioKey, frameIndex)}`}>
        {scenario.frames.map((frame, index) => (
          <span
            key={`${scenario.key}-${index}`}
            className={`timeline-step${index <= frameIndex ? ' passed' : ''}${
              index === frameIndex ? ' current' : ''
            }`}
            title={`${index + 1}. ${frame.label}`}
          />
        ))}
      </div>

      <div className="demo-actions">
        <button type="button" className="demo-action primary" onClick={onTogglePlay}>
          <span aria-hidden="true">{playing ? 'Ⅱ' : '▶'}</span>
          {playing ? '暂停' : atLastFrame ? '重播' : '播放'}
        </button>
        <button type="button" className="demo-action" onClick={onReset}>
          <span aria-hidden="true">↺</span>
          重置
        </button>
      </div>
    </section>
  );
}

function ConnectionPill({
  demo,
  fetchState,
}: {
  demo: boolean;
  fetchState: FetchState;
}): JSX.Element {
  const text = demo
    ? '合成演示数据'
    : fetchState === 'live'
      ? '面板 API 已连接'
      : fetchState === 'stale'
        ? '显示上次有效快照'
        : fetchState === 'offline'
          ? '面板 API 不可达'
          : '正在连接面板';
  const state = demo ? 'demo' : fetchState;

  return (
    <span className={`connection-pill connection-${state}`} aria-label={text}>
      <span className="connection-dot" />
      {text}
    </span>
  );
}

function NoticeBanner({
  demo,
  fetchState,
  stateIssue,
  controllerOnline,
}: {
  demo: boolean;
  fetchState: FetchState;
  stateIssue: string | null;
  controllerOnline: boolean | null;
}): JSX.Element | null {
  if (demo) {
    return (
      <div className="notice-banner demo-banner" role="status">
        <strong>演示数据</strong>
        <span>当前画面全部来自浏览器内合成场景。真实轮询已停止，不会触发 Merge、Retry 或 Deploy。</span>
      </div>
    );
  }

  if (fetchState === 'stale' || fetchState === 'offline' || controllerOnline === false || stateIssue) {
    const messages: string[] = [];
    if (stateIssue) {
      messages.push(stateIssue);
    } else if (fetchState === 'offline') {
      messages.push('尚未取得面板快照，面板 API 暂不可达。');
    } else if (fetchState === 'stale') {
      messages.push('当前连接不稳定，正在有界重试并保留最近可用快照。');
    }
    if (controllerOnline === false) {
      messages.push('控制器当前离线；任务状态仍按最近可用快照展示，本次不把任务改记为失败。');
    }
    return (
      <div className="notice-banner" role="status">
        <strong>连接提示</strong>
        <span>{messages.join(' ')}</span>
      </div>
    );
  }

  return null;
}

export function App(): JSX.Element {
  const [demoMode, setDemoMode] = useState(false);
  const [demoScenario, setDemoScenario] = useState<DemoScenarioKey>('running');
  const [demoFrame, setDemoFrame] = useState(
    () => getDemoScenario('running').frames.length - 1,
  );
  const [demoPlaying, setDemoPlaying] = useState(false);
  const [realView, setRealView] = useState<PanelView | null>(null);
  const [fetchState, setFetchState] = useState<FetchState>('loading');
  const [lastRefreshAt, setLastRefreshAt] = useState<Date | null>(null);
  const [stateIssue, setStateIssue] = useState<string | null>(null);
  const [scope, setScope] = useState<Scope>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [followCurrentNode, setFollowCurrentNode] = useState(true);
  const hasUsableSnapshot = useRef(false);

  useEffect(() => {
    if (demoMode) return;

    let cancelled = false;
    let nextPoll: number | undefined;
    let activeController: AbortController | null = null;

    const poll = async (): Promise<void> => {
      activeController = new AbortController();
      const timeout = window.setTimeout(() => activeController?.abort(), 6500);

      try {
        const nextView = await fetchPanelView(activeController.signal);
        if (cancelled) return;

        if (nextView.stateKind === 'ok') {
          hasUsableSnapshot.current = true;
          setRealView(nextView);
          setLastRefreshAt(new Date());
          setFetchState('live');
          setStateIssue(null);
        } else {
          if (!hasUsableSnapshot.current) setRealView(nextView);
          setFetchState(hasUsableSnapshot.current ? 'stale' : 'offline');
          setStateIssue(
            `${STATE_KIND_TEXT[nextView.stateKind]}，保留上一份有效流程快照并等待恢复。`,
          );
        }
      } catch {
        if (cancelled) return;
        setFetchState(hasUsableSnapshot.current ? 'stale' : 'offline');
        setStateIssue(
          hasUsableSnapshot.current
            ? '面板 API 连接中断，当前显示上次有效快照。'
            : '尚未取得可用流程快照。',
        );
      } finally {
        window.clearTimeout(timeout);
        activeController = null;
        if (!cancelled) nextPoll = window.setTimeout(poll, 2000);
      }
    };

    void poll();

    return () => {
      cancelled = true;
      if (nextPoll !== undefined) window.clearTimeout(nextPoll);
      activeController?.abort();
    };
  }, [demoMode]);

  useEffect(() => {
    if (!demoMode || !demoPlaying) return;
    const scenario = getDemoScenario(demoScenario);
    if (demoFrame >= scenario.frames.length - 1) {
      setDemoPlaying(false);
      return;
    }
    const timer = window.setTimeout(() => {
      setDemoFrame((current) => Math.min(current + 1, scenario.frames.length - 1));
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [demoFrame, demoMode, demoPlaying, demoScenario]);

  const demoView = useMemo(
    () => buildDemoView(demoScenario, demoFrame),
    [demoFrame, demoScenario],
  );
  const view = demoMode ? demoView : realView;
  const nodes = useMemo(() => scopeNodes(view, scope), [scope, view]);
  const selectedNode =
    nodes.find((node) => node.id === selectedNodeId) ??
    nodes.find((node) => node.current) ??
    nodes[0] ??
    null;
  const currentNode = nodes.find((node) => node.current) ?? null;

  const effectiveScope = useMemo<Scope>(() => {
    if (!view || !scope) return null;
    if (scope.type === 'request') {
      return view.requests.some((request) => request.requestId === scope.id) ? scope : null;
    }
    return view.deliveryGroups.some((delivery) => delivery.id === scope.id) ? scope : null;
  }, [scope, view]);

  useEffect(() => {
    if (scope && !effectiveScope) {
      setScope(null);
      setSelectedNodeId(null);
    }
  }, [effectiveScope, scope]);

  useEffect(() => {
    if (!view) return;
    if (demoMode && followCurrentNode) {
      const currentNode = nodes.find((node) => node.current) ?? nodes[0];
      if (currentNode && currentNode.id !== selectedNodeId) {
        setSelectedNodeId(currentNode.id);
      }
      return;
    }
    if (selectedNodeId && nodes.some((node) => node.id === selectedNodeId)) return;
    setSelectedNodeId((nodes.find((node) => node.current) ?? nodes[0])?.id ?? null);
  }, [demoMode, followCurrentNode, nodes, selectedNodeId, view]);

  const selectNode = useCallback((nodeId: string) => {
    setFollowCurrentNode(false);
    setSelectedNodeId(nodeId);
  }, []);

  const selectScope = useCallback(
    (next: Scope) => {
      setScope(next);
      setFollowCurrentNode(true);
      const nextNodes = scopeNodes(view, next);
      const node = nextNodes.find((item) => item.current) ?? nextNodes[0];
      setSelectedNodeId(node?.id ?? null);
    },
    [view],
  );

  const switchMode = (nextDemoMode: boolean) => {
    if (nextDemoMode === demoMode) return;
    setDemoMode(nextDemoMode);
    setDemoPlaying(false);
    setScope(null);
    setSelectedNodeId(null);
    setFollowCurrentNode(true);
    setStateIssue(null);
    setFetchState(nextDemoMode ? 'live' : realView ? 'live' : 'loading');
  };

  const selectDemoScenario = (next: DemoScenarioKey) => {
    const scenario = getDemoScenario(next);
    setDemoScenario(next);
    setDemoFrame(scenario.frames.length - 1);
    setDemoPlaying(false);
    setScope(null);
    setSelectedNodeId(null);
    setFollowCurrentNode(true);
  };

  const toggleDemoPlayback = () => {
    if (demoPlaying) {
      setDemoPlaying(false);
      return;
    }
    const scenario = getDemoScenario(demoScenario);
    if (demoFrame >= scenario.frames.length - 1) setDemoFrame(0);
    setDemoPlaying(true);
  };

  const resetDemo = () => {
    setDemoPlaying(false);
    setDemoFrame(0);
    setFollowCurrentNode(true);
    const firstFrameView = buildDemoView(demoScenario, 0);
    const firstNode =
      firstFrameView.nodes.find((node) => node.current) ?? firstFrameView.nodes[0];
    setSelectedNodeId(firstNode?.id ?? null);
  };

  const scopeTitle = useMemo(() => {
    if (effectiveScope?.type === 'request') {
      const request = view?.requests.find((item) => item.requestId === effectiveScope.id);
      return request?.summary ?? `${request?.targetReqId ?? '需求'} 文档变更`;
    }
    if (effectiveScope?.type === 'delivery') {
      const delivery = view?.deliveryGroups.find((item) => item.id === effectiveScope.id);
      return delivery ? `${delivery.reqId} 代码交付` : '代码交付';
    }
    return '当前全链路';
  }, [effectiveScope, view]);

  const connectionControllerOnline =
    demoMode || !view ? null : view.controllerOnline;

  return (
    <div className={`app-shell${demoMode ? ' is-demo' : ''}`}>
      <header className="topbar">
        <div className="brand-block">
          <div className="brand-mark" aria-hidden="true">
            <span className="brand-orbit" />
            <span className="brand-core" />
          </div>
          <div>
            <div className="brand-name">SPEC LOOP</div>
            <div className="brand-subtitle">本机只读流程面板</div>
          </div>
          <span className="environment-badge">LOCAL</span>
        </div>

        <div className="header-readout">
          <ConnectionPill demo={demoMode} fetchState={fetchState} />
          {!demoMode && view ? (
            <span
              className={`controller-pill${view.controllerOnline ? ' online' : ' offline'}`}
              aria-label={view.controllerOnline ? '控制器在线' : '控制器离线'}
            >
              <span className="controller-dot" />
              控制器{view.controllerOnline ? '在线' : '离线'}
            </span>
          ) : null}
          <div className="data-clock">
            <span>上次有效刷新</span>
            <strong>{demoMode ? '演示时间线' : formatClock(lastRefreshAt)}</strong>
          </div>
          {view?.stateUpdatedAt && !demoMode ? (
            <div className="data-clock secondary">
              <span>状态文件</span>
              <strong>{formatDateTime(view.stateUpdatedAt)}</strong>
            </div>
          ) : null}
        </div>

        <div className="mode-control" role="group" aria-label="数据源模式">
          <button
            type="button"
            className={!demoMode ? 'active' : ''}
            aria-pressed={!demoMode}
            onClick={() => switchMode(false)}
          >
            真实数据
          </button>
          <button
            type="button"
            className={demoMode ? 'active demo-active' : ''}
            aria-pressed={demoMode}
            onClick={() => switchMode(true)}
          >
            演示模式
          </button>
        </div>
      </header>

      <NoticeBanner
        demo={demoMode}
        fetchState={fetchState}
        stateIssue={stateIssue}
        controllerOnline={connectionControllerOnline}
      />

      <main className="workspace-shell">
        <Sidebar view={view} scope={effectiveScope} onSelectScope={selectScope} />

        <section className="canvas-column" aria-label="固定流程画布">
          <div className="canvas-heading">
            <div className="canvas-title-block">
              <span className="eyebrow">FLOW MAP</span>
              <h1>{scopeTitle}</h1>
              <p>
                {view?.repo ? `${view.repo} · ` : ''}
                八阶段流程仅展示状态证据
              </p>
            </div>
            <div className="canvas-focus">
              <span>当前阶段</span>
              <strong>{currentNode?.label ?? '尚未取得'}</strong>
              {currentNode ? <StatusBadge status={currentNode.status} compact /> : null}
            </div>
          </div>

          {demoMode ? (
            <DemoControls
              scenarioKey={demoScenario}
              frameIndex={demoFrame}
              playing={demoPlaying}
              onScenarioChange={selectDemoScenario}
              onTogglePlay={toggleDemoPlayback}
              onReset={resetDemo}
            />
          ) : null}

          <FlowCanvas
            nodes={nodes}
            selectedNodeId={selectedNode?.id ?? null}
            onSelectNode={selectNode}
          />

          <div className="canvas-legend" aria-label="状态图例">
            {(['running', 'waiting', 'succeeded', 'failed', 'unknown'] as PanelStatus[]).map(
              (status) => (
                <span key={status}>
                  <i className={`legend-dot status-${status}`} />
                  {STATUS_TEXT[status]}
                </span>
              ),
            )}
            <span className="canvas-hint">滚轮平移 · 拖动画布 · 控件缩放 · 键盘聚焦节点</span>
          </div>
        </section>

        <DetailsPanel view={view} scope={effectiveScope} selectedNode={selectedNode} />
      </main>
    </div>
  );
}
