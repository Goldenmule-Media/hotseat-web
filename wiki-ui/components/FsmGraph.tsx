"use client";

/**
 * The model-inspection graph (feature: wiki-ui model inspection). Renders a page type's
 * status FSM as a directed graph with React Flow, laid out with dagre, and overlays the
 * open page's live state: the current status is highlighted, outgoing transitions are
 * coloured available (green) / blocked (amber, with the reason) / inert (grey). The
 * classification is the pure {@link buildFsmGraph}; this component only lays it out and
 * draws it.
 */
import { useMemo } from "react";
import {
  Background,
  Controls,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import dagre from "dagre";
import type { FsmDescriptor } from "wiki";
import { buildFsmGraph, type EdgeClass, type FsmGraphModel, type TransitionAvailability } from "../lib/fsm-graph";

const NODE_W = 160;
const NODE_H = 44;

const EDGE_COLOR: Record<EdgeClass, string> = {
  available: "#16a34a",
  blocked: "#d97706",
  inert: "#cbd5e1",
};

/** Lay the classified model out with dagre and map it to React Flow nodes/edges. */
function layout(model: FsmGraphModel): { nodes: Node[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({ rankdir: "TB", nodesep: 50, ranksep: 70, marginx: 16, marginy: 16 });
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
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top,
      style: n.isCurrent
        ? { background: "#1d4ed8", color: "white", border: "2px solid #1d4ed8", borderRadius: 8, fontWeight: 600, width: NODE_W }
        : { background: "white", color: "#0f172a", border: "1px solid #cbd5e1", borderRadius: 8, width: NODE_W },
    };
  });

  const edges: Edge[] = model.edges.map((e) => {
    const color = EDGE_COLOR[e.cls];
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.cls === "blocked" ? `${e.label} 🔒` : e.label,
      labelShowBg: true,
      animated: e.cls === "available",
      markerEnd: { type: MarkerType.ArrowClosed, color },
      style: { stroke: color, strokeWidth: e.cls === "inert" ? 1 : 2, opacity: e.cls === "inert" ? 0.55 : 1 },
    };
  });

  return { nodes, edges };
}

export function FsmGraph({
  fsm,
  currentStatus,
  overlay,
}: {
  fsm: FsmDescriptor;
  currentStatus: string;
  overlay: readonly TransitionAvailability[];
}): React.JSX.Element {
  const model = useMemo(() => buildFsmGraph(fsm, currentStatus, overlay), [fsm, currentStatus, overlay]);
  const { nodes, edges } = useMemo(() => layout(model), [model]);
  const blocked = useMemo(() => model.edges.filter((e) => e.cls === "blocked"), [model]);

  return (
    <div className="fsm-graph">
      <div style={{ height: 480, border: "1px solid #e2e8f0", borderRadius: 8, background: "#f8fafc" }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          fitView
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
        >
          <Background />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      <p className="muted" style={{ marginTop: 8 }}>
        <code>{fsm.type}</code> — current state <strong>{currentStatus}</strong>. Green = available now,
        amber 🔒 = blocked by a precondition, grey = not reachable from here.
      </p>
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
