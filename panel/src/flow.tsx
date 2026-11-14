import { memo, type JSX } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import type { CSSProperties } from 'react';
import type { PanelNode, PanelStatus } from './types';

type StageNodeData = {
  node: PanelNode;
  index: number;
  onSelect: (nodeId: string) => void;
} & Record<string, unknown>;

type StageFlowNode = Node<StageNodeData, 'stage'>;

const STATUS_COLORS: Record<PanelStatus, string> = {
  pending: '#607087',
  running: '#22d3c5',
  waiting: '#f4b84a',
  succeeded: '#35d39a',
  failed: '#f26d78',
  stale: '#a78bfa',
  unknown: '#8490a4',
};

// Static read-only nodes need initial bounds so React Flow can draw the MiniMap
// before controlled node measurement changes are fed back into the parent.
const NODE_WIDTH = 220;
const NODE_HEIGHT = 128;

const NODE_POSITIONS: Readonly<Record<number, { x: number; y: number }>> = {
  0: { x: 0, y: 0 },
  1: { x: 252, y: 0 },
  2: { x: 504, y: 0 },
  3: { x: 756, y: 0 },
  4: { x: 756, y: 198 },
  5: { x: 504, y: 198 },
  6: { x: 252, y: 198 },
  7: { x: 0, y: 198 },
};

const TARGET_HANDLES: Readonly<Record<number, { id: string; position: Position }>> = {
  0: { id: 'target-left', position: Position.Left },
  1: { id: 'target-left', position: Position.Left },
  2: { id: 'target-left', position: Position.Left },
  3: { id: 'target-left', position: Position.Left },
  4: { id: 'target-top', position: Position.Top },
  5: { id: 'target-right', position: Position.Right },
  6: { id: 'target-right', position: Position.Right },
  7: { id: 'target-right', position: Position.Right },
};

const SOURCE_HANDLES: Readonly<Record<number, { id: string; position: Position }>> = {
  0: { id: 'source-right', position: Position.Right },
  1: { id: 'source-right', position: Position.Right },
  2: { id: 'source-right', position: Position.Right },
  3: { id: 'source-bottom', position: Position.Bottom },
  4: { id: 'source-left', position: Position.Left },
  5: { id: 'source-left', position: Position.Left },
  6: { id: 'source-left', position: Position.Left },
  7: { id: 'source-left', position: Position.Left },
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

function StageIcon({ id }: { id: string }): JSX.Element {
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

  switch (id) {
    case 'receive':
      return (
        <svg {...common}>
          <path d="M4 7.5 12 3l8 4.5v9L12 21l-8-4.5z" />
          <path d="m4 7.5 8 4.5 8-4.5M12 12v9" />
        </svg>
      );
    case 'docs-pr':
      return (
        <svg {...common}>
          <path d="M6 3h8l4 4v14H6z" />
          <path d="M14 3v5h5M9 12h6M9 16h6" />
        </svg>
      );
    case 'docs-confirm':
      return (
        <svg {...common}>
          <circle cx="12" cy="8" r="4" />
          <path d="M5 21a7 7 0 0 1 12.5-4.2M17 17l2 2 3-4" />
        </svg>
      );
    case 'sync-task':
      return (
        <svg {...common}>
          <path d="M4 7h12l-3-3M20 17H8l3 3" />
          <path d="M18 5v4h-4M6 19v-4h4" />
        </svg>
      );
    case 'code-verify':
      return (
        <svg {...common}>
          <path d="m8 8-4 4 4 4M16 8l4 4-4 4M14 4l-4 16" />
        </svg>
      );
    case 'code-confirm':
      return (
        <svg {...common}>
          <path d="M5 3h10l4 4v14H5z" />
          <path d="M15 3v5h5M8 13l2 2 4-5M8 18h7" />
        </svg>
      );
    case 'build-deploy':
      return (
        <svg {...common}>
          <path d="M12 3v10M8 9l4 4 4-4" />
          <path d="M5 14v5h14v-5" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <path d="M3 12h4l2-5 4 10 2-5h6" />
        </svg>
      );
  }
}

const StageNodeCard = memo(function StageNodeCard({
  data,
  selected,
}: NodeProps<StageFlowNode>): JSX.Element {
  const { node, index, onSelect } = data;
  const target = TARGET_HANDLES[index];
  const source = SOURCE_HANDLES[index];

  return (
    <div
      className={`stage-node status-${node.status}${node.current ? ' is-current' : ''}${
        selected ? ' is-selected' : ''
      }`}
      data-status={node.status}
    >
      {ALL_HANDLES.map((handle) => (
        <Handle
          key={`target-${handle.id}`}
          id={`target-${handle.id}`}
          type="target"
          position={handle.position}
          isConnectable={false}
          className={target?.id === `target-${handle.id}` ? 'stage-handle is-used' : 'stage-handle'}
        />
      ))}
      {ALL_HANDLES.map((handle) => (
        <Handle
          key={`source-${handle.id}`}
          id={`source-${handle.id}`}
          type="source"
          position={handle.position}
          isConnectable={false}
          className={source?.id === `source-${handle.id}` ? 'stage-handle is-used' : 'stage-handle'}
        />
      ))}

      <button
        type="button"
        className="stage-node-button"
        aria-pressed={selected}
        aria-label={`${node.label}，第 ${index + 1} 阶段，${STATUS_TEXT[node.status]}，${
          node.detail
        }`}
        onClick={(event) => {
          event.stopPropagation();
          onSelect(node.id);
        }}
      >
        <span className="stage-index">{String(index + 1).padStart(2, '0')}</span>
        <span className="stage-icon">
          <StageIcon id={node.id} />
        </span>
        <span className="stage-copy">
          <span className="stage-title">{node.label}</span>
          <span className="stage-detail">{node.detail}</span>
        </span>
        <span className="stage-state">
          <span className="state-dot" />
          {STATUS_TEXT[node.status]}
        </span>
        {node.current ? <span className="current-marker">当前</span> : null}
      </button>
    </div>
  );
});

const NODE_TYPES = {
  stage: StageNodeCard,
};

function toFlowNodes(
  nodes: PanelNode[],
  selectedNodeId: string | null,
  onSelectNode: (nodeId: string) => void,
): StageFlowNode[] {
  return nodes.slice(0, 8).map((node, index) => ({
    id: node.id,
    type: 'stage',
    position: NODE_POSITIONS[index] ?? { x: 0, y: 0 },
    initialWidth: NODE_WIDTH,
    initialHeight: NODE_HEIGHT,
    data: { node, index, onSelect: onSelectNode },
    selected: node.id === selectedNodeId,
    draggable: false,
    connectable: false,
    deletable: false,
    ariaLabel: `${node.label}，${STATUS_TEXT[node.status]}，${node.detail}`,
  }));
}

function edgeKind(source: PanelNode, target: PanelNode): 'done' | 'active' | 'failed' | 'pending' {
  if (target.status === 'failed') return 'failed';
  if (
    target.current &&
    (target.status === 'running' || target.status === 'waiting')
  ) {
    return 'active';
  }
  if (source.status === 'succeeded' && target.status === 'succeeded') return 'done';
  return 'pending';
}

function toFlowEdges(nodes: PanelNode[]): Edge[] {
  return nodes.slice(0, -1).flatMap((source, index) => {
    const target = nodes[index + 1];
    if (!target) return [];
    const sourceHandle = SOURCE_HANDLES[index];
    const targetHandle = TARGET_HANDLES[index + 1];
    if (!sourceHandle || !targetHandle) return [];

    const kind = edgeKind(source, target);
    const color =
      kind === 'failed' ? '#f26d78' : kind === 'active' ? '#22d3c5' : kind === 'done' ? '#35d39a' : '#425168';
    const style: CSSProperties = {
      stroke: color,
      strokeWidth: kind === 'pending' ? 1.5 : 2,
      strokeDasharray: kind === 'failed' ? '6 5' : undefined,
    };

    return [
      {
        id: `${source.id}-${target.id}`,
        source: source.id,
        target: target.id,
        sourceHandle: sourceHandle.id,
        targetHandle: targetHandle.id,
        type: 'smoothstep',
        animated: kind === 'active',
        className: `flow-edge edge-${kind}`,
        style,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color,
          width: 14,
          height: 14,
        },
      },
    ];
  });
}

function minimapColor(node: Node): string {
  const data = node.data as StageNodeData | undefined;
  return data?.node ? STATUS_COLORS[data.node.status] : STATUS_COLORS.unknown;
}

interface FlowCanvasProps {
  nodes: PanelNode[];
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
}

export function FlowCanvas({
  nodes,
  selectedNodeId,
  onSelectNode,
}: FlowCanvasProps): JSX.Element {
  const flowNodes = toFlowNodes(nodes, selectedNodeId, onSelectNode);
  const flowEdges = toFlowEdges(nodes);

  return (
    <div className="flow-canvas" aria-label="八阶段只读流程画布">
      <ReactFlow<StageFlowNode, Edge>
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={NODE_TYPES}
        fitView
        fitViewOptions={{ padding: 0.16 }}
        minZoom={0.42}
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
          nodeBorderRadius={4}
          maskColor="rgba(4, 11, 22, 0.72)"
        />
      </ReactFlow>
    </div>
  );
}

export { STATUS_COLORS, STATUS_TEXT };
