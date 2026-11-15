import { memo, useCallback, useEffect, useRef, type JSX } from 'react';
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  getSmoothStepPath,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react';
import {
  FLOW_EDGE_COLORS,
  FLOW_STATUS_COLORS,
  type FlowDefinition,
  type FlowEdgeDefinition,
  type FlowEdgeKind,
  type FlowNodeDefinition,
  type FlowNodeKind,
  type FlowPoint,
} from './flow-model';
import type { PanelStatus } from './types';

type FlowNodeData = {
  node: FlowNodeDefinition;
  onSelect: (nodeId: string) => void;
} & Record<string, unknown>;

type StageFlowNode = Node<FlowNodeData, 'stage'>;

type RoutedEdgeData = {
  route?: FlowEdgeDefinition['route'];
  color: string;
  kind: FlowEdgeKind;
} & Record<string, unknown>;

type FlowEdge = Edge<RoutedEdgeData, 'routed'>;

const FIT_VIEW_OPTIONS = {
  padding: 0.12,
  maxZoom: 1.35,
};

const ALL_HANDLES = [
  { id: 'left', position: Position.Left },
  { id: 'right', position: Position.Right },
  { id: 'top', position: Position.Top },
  { id: 'bottom', position: Position.Bottom },
] as const;

const STATUS_TEXT: Record<PanelStatus, string> = {
  pending: '未执行',
  running: '进行中',
  waiting: '待人工确认',
  succeeded: '已完成',
  failed: '失败',
  stale: '已过期',
  unknown: '未知',
};

const KIND_TEXT: Record<FlowNodeKind, string> = {
  document: '文档与 PR',
  execution: '执行阶段',
  human: '人工关口',
  decision: '检查与决策',
  deployment: '部署阶段',
  terminal: '完成节点',
  branch: '未触发分支',
};

function StageIcon({ node }: { node: FlowNodeDefinition }): JSX.Element {
  const common = {
    width: 18,
    height: 18,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };

  if (node.kind === 'document') {
    return (
      <svg {...common}>
        <path d="M6 3h8l4 4v14H6z" />
        <path d="M14 3v5h5M9 12h6M9 16h6" />
      </svg>
    );
  }

  if (node.kind === 'human') {
    return (
      <svg {...common}>
        <circle cx="12" cy="8" r="4" />
        <path d="M5 21a7 7 0 0 1 12.5-4.2M17 17l2 2 3-4" />
      </svg>
    );
  }

  if (node.kind === 'decision') {
    return (
      <svg {...common}>
        <path d="m12 3 9 9-9 9-9-9z" />
        <path d="m8.5 12 2.2 2.2 4.8-5" />
      </svg>
    );
  }

  if (node.kind === 'deployment') {
    return (
      <svg {...common}>
        <path d="M12 3v10M8 9l4 4 4-4" />
        <path d="M5 14v5h14v-5" />
      </svg>
    );
  }

  if (node.kind === 'branch') {
    return (
      <svg {...common}>
        <path d="M6 5v4c0 3 3 4 6 4s6 1 6 4v2" />
        <path d="m15 16 3 3 3-3M3 16l3 3 3-3" />
      </svg>
    );
  }

  if (node.kind === 'terminal') {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="9" />
        <path d="m8 12 2.5 2.5L16 9" />
      </svg>
    );
  }

  return (
    <svg {...common}>
      <path d="M4 7h12l-3-3M20 17H8l3 3" />
      <path d="M18 5v4h-4M6 19v-4h4" />
    </svg>
  );
}

const StageNodeCard = memo(function StageNodeCard({
  data,
  selected,
}: NodeProps<StageFlowNode>): JSX.Element {
  const { node, onSelect } = data;
  const statusText = node.dormant
    ? '未触发'
    : (node.stateLabel ?? STATUS_TEXT[node.status]);

  return (
    <div
      className={`stage-node kind-${node.kind} status-${node.status}${
        node.current ? ' is-current' : ''
      }${selected ? ' is-selected' : ''}${node.dormant ? ' is-dormant' : ''}${
        node.compact ? ' is-compact' : ''
      }`}
      data-status={node.status}
      data-kind={node.kind}
      style={{ width: node.width, minHeight: node.height }}
    >
      {ALL_HANDLES.map((handle) => (
        <Handle
          key={`target-${handle.id}`}
          id={`target-${handle.id}`}
          type="target"
          position={handle.position}
          isConnectable={false}
          className="stage-handle is-used"
        />
      ))}
      {ALL_HANDLES.map((handle) => (
        <Handle
          key={`source-${handle.id}`}
          id={`source-${handle.id}`}
          type="source"
          position={handle.position}
          isConnectable={false}
          className="stage-handle is-used"
        />
      ))}

      <button
        type="button"
        className="stage-node-button"
        aria-pressed={selected}
        aria-label={`${node.label}，${KIND_TEXT[node.kind]}，${statusText}，${node.detail}`}
        onClick={(event) => {
          event.stopPropagation();
          onSelect(node.id);
        }}
      >
        <span className="stage-index">{node.indexLabel}</span>
        <span className="stage-icon">
          <StageIcon node={node} />
        </span>
        <span className="stage-copy">
          <span className="stage-title">{node.label}</span>
          <span className="stage-detail">{node.detail}</span>
        </span>
        <span className="stage-state">
          <span className="state-dot" />
          {statusText}
        </span>
        {node.current ? <span className="current-marker">当前</span> : null}
      </button>
    </div>
  );
});

const NODE_TYPES = {
  stage: StageNodeCard,
};

function pointDistance(a: FlowPoint, b: FlowPoint): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function routePath(points: FlowPoint[]): { path: string; label: FlowPoint } {
  const path = points
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x},${point.y}`)
    .join(' ');
  let longest = { length: -1, start: points[0]!, end: points[1] ?? points[0]! };

  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1]!;
    const end = points[index]!;
    const length = pointDistance(start, end);
    if (length > longest.length) longest = { length, start, end };
  }

  return {
    path,
    label: {
      x: (longest.start.x + longest.end.x) / 2,
      y: (longest.start.y + longest.end.y) / 2,
    },
  };
}

function RoutedEdge({
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  data,
  label,
  markerEnd,
  style,
  interactionWidth,
}: EdgeProps<FlowEdge>): JSX.Element {
  const routed = data?.route
    ? routePath([
        { x: sourceX, y: sourceY },
        ...data.route.waypoints,
        { x: targetX, y: targetY },
      ])
    : null;
  const [smoothPath, smoothLabelX, smoothLabelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 8,
    offset: 16,
  });
  const path = routed?.path ?? smoothPath;
  const labelPosition = data?.route?.labelPosition ?? routed?.label ?? {
    x: smoothLabelX,
    y: smoothLabelY,
  };

  return (
    <>
      <BaseEdge
        path={path}
        markerEnd={markerEnd}
        style={{ ...style, strokeLinecap: 'round', strokeLinejoin: 'round' }}
        interactionWidth={interactionWidth}
      />
      {label ? (
        <EdgeLabelRenderer>
          <span
            className="flow-edge-label"
            style={{
              color: data?.color,
              transform: `translate(-50%, -50%) translate(${labelPosition.x}px, ${labelPosition.y}px)`,
            }}
          >
            {label}
          </span>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

const EDGE_TYPES = {
  routed: RoutedEdge,
};

function toFlowNodes(
  definition: FlowDefinition,
  selectedNodeId: string | null,
  onSelectNode: (nodeId: string) => void,
): StageFlowNode[] {
  return definition.nodes.map((node) => ({
    id: node.id,
    type: 'stage',
    position: node.position,
    initialWidth: node.width,
    initialHeight: node.height,
    style: { width: node.width, height: node.height },
    data: { node, onSelect: onSelectNode },
    selected: node.id === selectedNodeId,
    draggable: false,
    connectable: false,
    deletable: false,
    ariaLabel: `${node.label}，${KIND_TEXT[node.kind]}，${
      node.dormant ? '未触发' : (node.stateLabel ?? STATUS_TEXT[node.status])
    }，${node.detail}`,
  }));
}

function toFlowEdges(definition: FlowDefinition): FlowEdge[] {
  return definition.edges.map((edge) => {
    const color = FLOW_EDGE_COLORS[edge.kind];
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle,
      targetHandle: edge.targetHandle,
      type: 'routed',
      animated: edge.animated,
      className: `flow-edge edge-${edge.kind}${edge.kind === 'dormant' ? ' edge-dormant' : ''}`,
      label: edge.label,
      data: {
        route: edge.route,
        color: edge.kind === 'dormant' ? '#698094' : color,
        kind: edge.kind,
      },
      style: {
        stroke: color,
        strokeWidth: edge.kind === 'pending' || edge.kind === 'dormant' ? 1.25 : 1.8,
        strokeDasharray:
          edge.kind === 'failed'
            ? '6 5'
            : edge.kind === 'retry'
              ? '3 4'
              : edge.kind === 'dormant'
                ? '2 5'
                : undefined,
      },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color,
        width: 12,
        height: 12,
      },
    } satisfies FlowEdge;
  });
}

function minimapColor(node: Node): string {
  const data = node.data as FlowNodeData | undefined;
  if (data?.node?.dormant) return '#26384a';
  return data?.node ? FLOW_STATUS_COLORS[data.node.status] : FLOW_STATUS_COLORS.unknown;
}

interface FlowCanvasProps {
  definition: FlowDefinition;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
}

export function FlowCanvas({
  definition,
  selectedNodeId,
  onSelectNode,
}: FlowCanvasProps): JSX.Element {
  const canvasRef = useRef<HTMLDivElement>(null);
  const flowRef = useRef<ReactFlowInstance<StageFlowNode, FlowEdge> | null>(null);
  const fitFrameRef = useRef<number | null>(null);
  const flowNodes = toFlowNodes(definition, selectedNodeId, onSelectNode);
  const flowEdges = toFlowEdges(definition);
  const topologySignature = [
    definition.sequenceTotal,
    ...definition.nodes.map((node) => [
      node.id,
      node.kind,
      node.position.x,
      node.position.y,
      node.width,
      node.height,
    ].join(':')),
    ...definition.edges.map((edge) => [
      edge.source,
      edge.target,
      edge.sourceHandle,
      edge.targetHandle,
      edge.route?.waypoints.map((point) => `${point.x},${point.y}`).join(';') ?? '',
      edge.route?.labelPosition
        ? `${edge.route.labelPosition.x},${edge.route.labelPosition.y}`
        : '',
    ].join(':')),
  ].join('|');

  const requestFit = useCallback(() => {
    if (fitFrameRef.current !== null) window.cancelAnimationFrame(fitFrameRef.current);

    fitFrameRef.current = window.requestAnimationFrame(() => {
      fitFrameRef.current = window.requestAnimationFrame(() => {
        fitFrameRef.current = null;
        const instance = flowRef.current;
        const canvas = canvasRef.current;
        if (!instance || !canvas) return;
        const { width, height } = canvas.getBoundingClientRect();
        if (width < 1 || height < 1) return;
        void instance.fitView(FIT_VIEW_OPTIONS);
      });
    });
  }, []);

  useEffect(() => {
    requestFit();
  }, [requestFit, topologySignature]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let previous = { width: 0, height: 0 };
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      const width = Math.round(rect.width * 100) / 100;
      const height = Math.round(rect.height * 100) / 100;
      if (width < 1 || height < 1) return;
      if (
        Math.abs(width - previous.width) < 0.5 &&
        Math.abs(height - previous.height) < 0.5
      ) {
        return;
      }
      previous = { width, height };
      requestFit();
    });

    observer.observe(canvas);
    return () => {
      observer.disconnect();
      if (fitFrameRef.current !== null) {
        window.cancelAnimationFrame(fitFrameRef.current);
        fitFrameRef.current = null;
      }
    };
  }, [requestFit]);

  return (
    <div
      ref={canvasRef}
      className="flow-canvas"
      aria-label={`${definition.nodes.length} 节点只读流程画布`}
    >
      <ReactFlow<StageFlowNode, FlowEdge>
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        fitView
        fitViewOptions={FIT_VIEW_OPTIONS}
        minZoom={0.32}
        maxZoom={1.35}
        nodesDraggable={false}
        nodesConnectable={false}
        edgesReconnectable={false}
        elementsSelectable
        nodesFocusable
        edgesFocusable={false}
        deleteKeyCode={null}
        selectionKeyCode={null}
        multiSelectionKeyCode={null}
        zoomOnDoubleClick={false}
        panOnScroll
        onInit={(instance) => {
          flowRef.current = instance;
          requestFit();
        }}
        onNodeClick={(_event, node) => onSelectNode(node.id)}
        proOptions={{ hideAttribution: false }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={24}
          size={1.2}
          color="rgba(129, 151, 178, 0.2)"
        />
        <Controls position="bottom-right" showInteractive={false} />
        <MiniMap
          position="bottom-left"
          pannable
          zoomable
          nodeColor={minimapColor}
          nodeStrokeColor="rgba(255,255,255,0.2)"
          nodeBorderRadius={3}
          maskColor="rgba(4, 11, 22, 0.72)"
        />
      </ReactFlow>
    </div>
  );
}

export { FLOW_STATUS_COLORS as STATUS_COLORS, STATUS_TEXT };
