import type { PanelNode, PanelStatus } from './types';

export type FlowNodeKind =
  | 'document'
  | 'execution'
  | 'human'
  | 'decision'
  | 'deployment'
  | 'terminal'
  | 'branch';

export type FlowEdgeKind = 'done' | 'active' | 'failed' | 'retry' | 'pending' | 'dormant';

export interface FlowPoint {
  x: number;
  y: number;
}

export interface FlowNodeDefinition extends PanelNode {
  kind: FlowNodeKind;
  position: FlowPoint;
  width: number;
  height: number;
  indexLabel: string;
  stateLabel?: string;
  dormant?: boolean;
  compact?: boolean;
}

export interface FlowEdgeDefinition {
  id: string;
  source: string;
  target: string;
  sourceHandle: string;
  targetHandle: string;
  kind: FlowEdgeKind;
  label?: string;
  animated?: boolean;
  route?: {
    waypoints: FlowPoint[];
    labelPosition?: FlowPoint;
  };
}

export interface FlowDefinition {
  nodes: FlowNodeDefinition[];
  edges: FlowEdgeDefinition[];
  sequenceTotal: number;
}

type FlowHandles = Pick<FlowEdgeDefinition, 'sourceHandle' | 'targetHandle'>;

export function handlesBetween(source: FlowPoint, target: FlowPoint): FlowHandles {
  const horizontal = Math.abs(target.x - source.x);
  const vertical = Math.abs(target.y - source.y);

  if (horizontal >= vertical) {
    return target.x >= source.x
      ? { sourceHandle: 'source-right', targetHandle: 'target-left' }
      : { sourceHandle: 'source-left', targetHandle: 'target-right' };
  }

  return target.y >= source.y
    ? { sourceHandle: 'source-bottom', targetHandle: 'target-top' }
    : { sourceHandle: 'source-top', targetHandle: 'target-bottom' };
}

export function edgeKindForNodes(
  source: Pick<PanelNode, 'status'>,
  target: Pick<PanelNode, 'status' | 'current'>,
): FlowEdgeKind {
  if (target.status === 'failed') return 'failed';
  if (target.current && (target.status === 'running' || target.status === 'waiting')) {
    return 'active';
  }
  if (source.status === 'succeeded' && target.status === 'succeeded') return 'done';
  return 'pending';
}

function kindForRealNode(id: string): FlowNodeKind {
  if (id.includes('confirm')) return 'human';
  if (id === 'code-verify') return 'decision';
  if (id === 'build-deploy') return 'deployment';
  if (id === 'health-receipt') return 'terminal';
  if (id === 'docs-pr') return 'document';
  return 'execution';
}

export function buildRealFlowDefinition(nodes: PanelNode[]): FlowDefinition {
  const columns = Math.max(1, Math.min(4, nodes.length));
  const flowNodes: FlowNodeDefinition[] = nodes.map((node, index) => {
    const row = Math.floor(index / columns);
    const offset = index % columns;
    const column = row % 2 === 0 ? offset : columns - 1 - offset;

    return {
      ...node,
      kind: kindForRealNode(node.id),
      position: { x: column * 252, y: row * 210 },
      width: 220,
      height: 128,
      indexLabel: String(index + 1).padStart(2, '0'),
    };
  });

  const flowEdges = flowNodes.slice(0, -1).map((source, index) => {
    const target = flowNodes[index + 1]!;
    return {
      id: `real-${source.id}-${target.id}`,
      source: source.id,
      target: target.id,
      ...handlesBetween(source.position, target.position),
      kind: edgeKindForNodes(source, target),
      animated:
        target.current && (target.status === 'running' || target.status === 'waiting'),
    } satisfies FlowEdgeDefinition;
  });

  return { nodes: flowNodes, edges: flowEdges, sequenceTotal: nodes.length };
}

export const FLOW_STATUS_COLORS: Record<PanelStatus, string> = {
  pending: '#607087',
  running: '#22d3c5',
  waiting: '#f4b84a',
  succeeded: '#35d39a',
  failed: '#f26d78',
  stale: '#a78bfa',
  unknown: '#8490a4',
};

export const FLOW_EDGE_COLORS: Record<FlowEdgeKind, string> = {
  done: '#35d39a',
  active: '#22d3c5',
  failed: '#f26d78',
  retry: '#f4b84a',
  pending: '#425168',
  dormant: '#26384a',
};
