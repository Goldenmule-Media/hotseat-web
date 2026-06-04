/**
 * Geometry for direction-agnostic ("floating") FSM edges. Instead of fixed top/bottom
 * handles — which make a back-edge (a transition from a lower-ranked state up to a
 * higher one, e.g. `reopen`) loop awkwardly — an edge meets each node at the point on
 * its border that faces the other node. Pure math; no React.
 */
import type { InternalNode, Node } from "@xyflow/react";

interface Box {
  readonly cx: number;
  readonly cy: number;
  readonly hw: number;
  readonly hh: number;
}

function box(node: InternalNode<Node>): Box {
  const w = node.measured?.width ?? 0;
  const h = node.measured?.height ?? 0;
  return {
    cx: node.internals.positionAbsolute.x + w / 2,
    cy: node.internals.positionAbsolute.y + h / 2,
    hw: w / 2,
    hh: h / 2,
  };
}

/** The point on `from`'s border along the ray toward `toward`'s center. */
function borderPoint(from: Box, toward: Box): { x: number; y: number } {
  const dx = toward.cx - from.cx;
  const dy = toward.cy - from.cy;
  if ((dx === 0 && dy === 0) || from.hw === 0 || from.hh === 0) {
    return { x: from.cx, y: from.cy };
  }
  // Scale the direction vector so it just reaches the rectangle's edge.
  const t = 1 / Math.max(Math.abs(dx) / from.hw, Math.abs(dy) / from.hh);
  return { x: from.cx + dx * t, y: from.cy + dy * t };
}

/** Border-to-border endpoints for an edge between two nodes. */
export function getEdgeParams(
  source: InternalNode<Node>,
  target: InternalNode<Node>,
): { sx: number; sy: number; tx: number; ty: number } {
  const s = box(source);
  const t = box(target);
  const sp = borderPoint(s, t);
  const tp = borderPoint(t, s);
  return { sx: sp.x, sy: sp.y, tx: tp.x, ty: tp.y };
}
