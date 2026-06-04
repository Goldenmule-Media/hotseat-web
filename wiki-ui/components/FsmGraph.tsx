"use client";

/**
 * The model-inspection graph (feature: wiki-ui model inspection). Renders a page type's
 * status FSM as a directed graph with React Flow, laid out with dagre, and overlays the
 * open page's live state: the current status is highlighted, outgoing transitions are
 * coloured available (green) / blocked (amber, with the reason) / inert (grey). The
 * classification is the pure {@link buildFsmGraph}; this component lays it out and draws
 * it with direction-agnostic floating edges (so back-edges and bidirectional pairs like
 * seal/reopen render cleanly).
 */
import { useEffect, useMemo } from "react";
import {
  BaseEdge,
  Background,
  Controls,
  EdgeLabelRenderer,
  MarkerType,
  ReactFlow,
  getStraightPath,
  useEdgesState,
  useInternalNode,
  useNodesState,
  type Edge,
  type EdgeProps,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import dagre from "dagre";
import type { FsmDescriptor } from "wiki";
import { getEdgeParams } from "../lib/floating-edge";
import { buildFsmGraph, type EdgeClass, type FsmGraphModel, type TransitionAvailability } from "../lib/fsm-graph";

const NODE_W = 160;
const NODE_H = 44;
/** Perpendicular control-point offset that bends one side of a bidirectional pair. */
const BEND = 55;

const EDGE_COLOR: Record<EdgeClass, string> = {
  available: "#16a34a",
  blocked: "#d97706",
  inert: "#94a3b8",
};

/**
 * A floating edge: it meets each node at the border facing the other node (so a back-
 * edge doesn't loop), and — for a bidirectional pair — bends by `data.curvature` to the
 * left of its own direction, which puts the two edges of the pair on opposite sides.
 */
function FloatingEdge({ source, target, markerEnd, style, label, data }: EdgeProps): React.JSX.Element | null {
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);
  if (sourceNode === undefined || targetNode === undefined) return null;
  if (sourceNode.measured?.width === undefined || targetNode.measured?.width === undefined) return null;

  const { sx, sy, tx, ty } = getEdgeParams(sourceNode, targetNode);
  const bend = Number((data as { curvature?: number } | undefined)?.curvature ?? 0);

  let path: string;
  let labelX: number;
  let labelY: number;
  if (bend === 0) {
    [path, labelX, labelY] = getStraightPath({ sourceX: sx, sourceY: sy, targetX: tx, targetY: ty });
  } else {
    const dx = tx - sx;
    const dy = ty - sy;
    const len = Math.hypot(dx, dy) || 1;
    const cx = (sx + tx) / 2 + (-dy / len) * bend;
    const cy = (sy + ty) / 2 + (dx / len) * bend;
    path = `M ${sx},${sy} Q ${cx},${cy} ${tx},${ty}`;
    // Bias the label toward the source (quadratic point at t≈0.3) instead of the
    // midpoint, so the two labels of a bidirectional pair sit at different points along
    // their curves (different heights) and don't overlap — even when the text is wide.
    const t = 0.3;
    const a = (1 - t) ** 2;
    const b = 2 * (1 - t) * t;
    const c = t ** 2;
    labelX = a * sx + b * cx + c * tx;
    labelY = a * sy + b * cy + c * ty;
  }

  return (
    <>
      <BaseEdge path={path} markerEnd={markerEnd} style={style} />
      {label !== undefined && label !== null && label !== "" && (
        <EdgeLabelRenderer>
          <div
            className="fsm-edge-label"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const EDGE_TYPES = { floating: FloatingEdge };

/** Lay the classified model out with dagre and map it to React Flow nodes/edges. */
function layout(model: FsmGraphModel): { nodes: Node[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({ rankdir: "TB", nodesep: 60, ranksep: 80, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of model.nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  for (const e of model.edges) g.setEdge(e.source, e.target, {}, e.id);
  dagre.layout(g);

  const nodes: Node[] = model.nodes.map((n) => {
    const p = g.node(n.id);
    return {
      id: n.id,
      position: { x: (p?.x ?? 0) - NODE_W / 2, y: (p?.y ?? 0) - NODE_H / 2 },
      data: { label: n.isCurrent ? `● ${n.label}` : n.label },
      style: n.isCurrent
        ? { background: "#1d4ed8", color: "white", border: "2px solid #1d4ed8", borderRadius: 8, fontWeight: 600, width: NODE_W }
        : { background: "white", color: "#0f172a", border: "1px solid #cbd5e1", borderRadius: 8, width: NODE_W },
    };
  });

  // A directed pair (a,b) is bidirectional when (b,a) also exists — bend both so they
  // don't overlap.
  const directed = new Set(model.edges.map((e) => `${e.source}->${e.target}`));
  const edges: Edge[] = model.edges.map((e) => {
    const color = EDGE_COLOR[e.cls];
    const bidirectional = directed.has(`${e.target}->${e.source}`);
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      type: "floating",
      label: e.cls === "blocked" ? `${e.label} 🔒` : e.label,
      data: { curvature: bidirectional ? BEND : 0 },
      animated: e.cls === "available",
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
      style: { stroke: color, strokeWidth: e.cls === "inert" ? 1.5 : 2.5, opacity: e.cls === "inert" ? 0.6 : 1 },
    };
  });

  return { nodes, edges };
}

function FsmGraphInner({
  fsm,
  currentStatus,
  overlay,
}: {
  fsm: FsmDescriptor;
  currentStatus: string;
  overlay: readonly TransitionAvailability[];
}): React.JSX.Element {
  const model = useMemo(() => buildFsmGraph(fsm, currentStatus, overlay), [fsm, currentStatus, overlay]);
  const computed = useMemo(() => layout(model), [model]);

  const [nodes, setNodes, onNodesChange] = useNodesState(computed.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(computed.edges);

  // Drive recomputed layout through React Flow's own store (instead of replacing the
  // nodes/edges props every render), so a burst of live updates can't blank the canvas.
  useEffect(() => {
    setNodes(computed.nodes);
    setEdges(computed.edges);
  }, [computed, setNodes, setEdges]);

  const blocked = useMemo(() => model.edges.filter((e) => e.cls === "blocked"), [model]);

  return (
    <div className="fsm-graph">
      <div className="fsm-graph-canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          edgeTypes={EDGE_TYPES}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          nodesDraggable={false}
          nodesConnectable={false}
          edgesFocusable={false}
        >
          <Background />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      <div className="fsm-legend">
        <p className="fsm-legend-head">
          <code>{fsm.type}</code> — current state <strong>{currentStatus}</strong>
        </p>
        <ul className="fsm-legend-keys">
          <li>
            <span className="fsm-key-swatch" style={{ background: EDGE_COLOR.available }} />
            Available now
          </li>
          <li>
            <span className="fsm-key-swatch" style={{ background: EDGE_COLOR.blocked }} />
            <span className="fsm-key-lock">🔒</span> Blocked by a precondition
          </li>
          <li>
            <span className="fsm-key-swatch" style={{ background: EDGE_COLOR.inert }} />
            Not reachable from here
          </li>
        </ul>
      </div>
      {blocked.length > 0 && (
        <ul className="fsm-blocked">
          {blocked.map((e) => (
            <li key={e.id}>
              <strong>{e.label}</strong> — blocked{e.reason !== undefined ? `: ${e.reason}` : ""}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function FsmGraph(props: {
  fsm: FsmDescriptor;
  currentStatus: string;
  overlay: readonly TransitionAvailability[];
}): React.JSX.Element {
  // Re-mount on a page-TYPE change so fitView re-runs for the new graph; status/overlay
  // changes update in place (stable positions, no view jump).
  return <FsmGraphInner key={props.fsm.type} {...props} />;
}
