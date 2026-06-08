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
import { useCallback, useEffect, useMemo, useState } from "react";
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
import type { FsmDescriptor, IMutationDescriptor, PageId, WorkspaceId } from "wiki";
import { getEdgeParams } from "../lib/floating-edge";
import {
  buildFsmGraph,
  resolveTransitionTarget,
  type EdgeClass,
  type EdgeRef,
  type FsmGraphModel,
  type TransitionTarget,
} from "../lib/fsm-graph";
import { TransitionForm } from "./TransitionForm";

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
  const d = data as { curvature?: number; cls?: EdgeClass } | undefined;
  const bend = Number(d?.curvature ?? 0);
  const cls = d?.cls;
  const interactive = cls === "available" || cls === "blocked";

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
      {/* A wide, invisible hit path so the thin edge (and its label) is easy to click —
          onEdgeClick fires for a click anywhere along it. */}
      <path d={path} fill="none" stroke="transparent" strokeWidth={20} className="react-flow__edge-interaction" />
      <BaseEdge path={path} markerEnd={markerEnd} style={style} />
      {label !== undefined && label !== null && label !== "" && (
        <EdgeLabelRenderer>
          <div
            className={`fsm-edge-label ${interactive ? "fsm-edge-label--interactive" : "fsm-edge-label--inert"}`}
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              // Tint a clickable label's border with its class colour (green/amber) so it
              // reads as an actionable chip; inert labels stay a plain caption (CSS).
              ...(interactive && cls !== undefined ? { borderColor: EDGE_COLOR[cls] } : {}),
            }}
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
    // Agency is encoded ORTHOGONALLY to the availability colour: an icon on the label
    // (🤖 agent / 🧑 human) plus a dashed stroke for human gates — so "who drives this
    // edge" reads at a glance without overloading the green/amber/grey availability colour.
    const agencyIcon = e.agency === "agent" ? "🤖 " : e.agency === "human" ? "🧑 " : "";
    const label = `${agencyIcon}${e.cls === "blocked" ? `${e.label} 🔒` : e.label}`;
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      type: "floating",
      label,
      // `event/from/to/cls` let onEdgeClick resolve the transition purely (`event` is the
      // RAW command name, never the icon-prefixed label); `curvature` drives the bend.
      data: { curvature: bidirectional ? BEND : 0, event: e.label, from: e.source, to: e.target, cls: e.cls, agency: e.agency },
      // Interactive edges (those leaving the current state) get a pointer + hover emphasis;
      // inert edges are explicitly marked so they can be shown as non-interactive (and so
      // we can override React Flow's default pointer cursor on them).
      className: e.cls === "inert" ? "fsm-edge-static" : "fsm-edge-interactive",
      animated: e.cls === "available",
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
      // Clickable edges read bold and full-opacity; inert edges are thin and dimmed. Human
      // gates are dashed regardless of availability (a static "a person owns this" cue).
      style: {
        stroke: color,
        strokeWidth: e.cls === "inert" ? 1.5 : 2.75,
        opacity: e.cls === "inert" ? 0.4 : 1,
        ...(e.agency === "human" ? { strokeDasharray: "6 4" } : {}),
      },
    };
  });

  return { nodes, edges };
}

function FsmGraphInner({
  fsm,
  currentStatus,
  descriptors,
  workspaceId,
  pageId,
}: {
  fsm: FsmDescriptor;
  currentStatus: string;
  descriptors: readonly IMutationDescriptor[];
  workspaceId: WorkspaceId;
  pageId: PageId;
}): React.JSX.Element {
  const model = useMemo(() => buildFsmGraph(fsm, currentStatus, descriptors), [fsm, currentStatus, descriptors]);
  const computed = useMemo(() => layout(model), [model]);

  const [nodes, setNodes, onNodesChange] = useNodesState(computed.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(computed.edges);
  // The transition the user clicked open (null = no modal). Cleared on close / success.
  const [target, setTarget] = useState<TransitionTarget | null>(null);

  // Drive recomputed layout through React Flow's own store (instead of replacing the
  // nodes/edges props every render), so a burst of live updates can't blank the canvas.
  useEffect(() => {
    setNodes(computed.nodes);
    setEdges(computed.edges);
  }, [computed, setNodes, setEdges]);

  // Click an edge that leaves the current state → open its transition form (available =
  // runnable, blocked = read-only + reason); inert/unknown edges resolve to null.
  const onEdgeClick = useCallback(
    (_e: React.MouseEvent, edge: Edge) => {
      const d = edge.data as Partial<EdgeRef> | undefined;
      if (d?.event === undefined || d.from === undefined || d.to === undefined || d.cls === undefined) return;
      const t = resolveTransitionTarget({ event: d.event, from: d.from, to: d.to, cls: d.cls }, descriptors);
      if (t !== null) setTarget(t);
    },
    [descriptors],
  );

  const blocked = useMemo(() => model.edges.filter((e) => e.cls === "blocked"), [model]);

  return (
    <div className="fsm-graph">
      <div className="fsm-graph-layout">
        <div className="fsm-graph-canvas">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            edgeTypes={EDGE_TYPES}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onEdgeClick={onEdgeClick}
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
        {/* Dedicated inspector column: populated with the clicked transition's form, or a
            hint when nothing is selected. The graph stays visible alongside it. */}
        <aside className="fsm-inspector" aria-label="Run transition">
          {target !== null ? (
            <TransitionForm
              key={target.descriptor.name}
              workspaceId={workspaceId}
              pageId={pageId}
              target={target}
              onClose={() => setTarget(null)}
            />
          ) : (
            <div className="fsm-inspector-empty">
              <p className="fsm-inspector-title">Run a transition</p>
              <p className="muted">
                Click an available (green) or blocked (amber) edge leaving <strong>{currentStatus}</strong> to run it from
                here.
              </p>
            </div>
          )}
        </aside>
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
          <li>
            <span className="fsm-key-lock" aria-hidden>🤖</span> Agent edge — the agent drives it
          </li>
          <li>
            <span className="fsm-key-lock" aria-hidden>🧑</span> Human gate — a person decides (dashed)
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
  descriptors: readonly IMutationDescriptor[];
  workspaceId: WorkspaceId;
  pageId: PageId;
}): React.JSX.Element {
  // Re-mount on a page-TYPE change so fitView re-runs for the new graph; status/overlay
  // changes update in place (stable positions, no view jump).
  return <FsmGraphInner key={props.fsm.type} {...props} />;
}
