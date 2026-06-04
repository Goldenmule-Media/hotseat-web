/**
 * Pure view-model transform for the model-inspection graph (feature: wiki-ui model
 * inspection). Maps the engine's serializable {@link FsmDescriptor} (the page TYPE's
 * status FSM) plus the open page INSTANCE's current status and per-command overlay
 * into a render-agnostic node/edge model with each edge classified:
 *
 *   - an outgoing transition from the current state that is runnable now → `available`
 *   - an outgoing transition that is blocked by a precondition → `blocked` (+ reason)
 *   - any transition that does not leave the current state → `inert`
 *
 * No React / React Flow here so it is trivially unit-testable; <FsmGraph> lays this out
 * (dagre) and renders it.
 */
import type { FsmDescriptor } from "wiki";

export type EdgeClass = "available" | "blocked" | "inert";

export interface FsmGraphNode {
  /** Status name (the node id). */
  readonly id: string;
  readonly label: string;
  /** The page instance's current status. */
  readonly isCurrent: boolean;
}

export interface FsmGraphEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  /** The transition/command name (e.g. "ship"). */
  readonly label: string;
  readonly cls: EdgeClass;
  /** When `cls === "blocked"`, the precondition reason (from the overlay's `unmet`). */
  readonly reason?: string;
}

export interface FsmGraphModel {
  readonly nodes: readonly FsmGraphNode[];
  readonly edges: readonly FsmGraphEdge[];
}

/** The per-instance availability the engine's describeMutations reports per command. */
export interface TransitionAvailability {
  readonly name: string;
  readonly available: boolean;
  readonly unmet?: string;
}

/**
 * Build the classified graph model. `overlay` is keyed by command/event name; only the
 * edges LEAVING `currentStatus` consult it (the rest are inert). An outgoing edge with
 * no overlay entry defaults to available (the FSM permits it from here).
 */
export function buildFsmGraph(
  fsm: FsmDescriptor,
  currentStatus: string,
  overlay: readonly TransitionAvailability[],
): FsmGraphModel {
  const byEvent = new Map(overlay.map((o) => [o.name, o]));

  const nodes: FsmGraphNode[] = fsm.states.map((s) => ({
    id: s,
    label: s,
    isCurrent: s === currentStatus,
  }));

  const edges: FsmGraphEdge[] = fsm.transitions.map((tr) => {
    const base = {
      id: `${tr.from}--${tr.event}-->${tr.to}`,
      source: tr.from,
      target: tr.to,
      label: tr.event,
    };
    if (tr.from !== currentStatus) return { ...base, cls: "inert" };
    const ov = byEvent.get(tr.event);
    if (ov !== undefined && !ov.available) {
      return { ...base, cls: "blocked", ...(ov.unmet !== undefined ? { reason: ov.unmet } : {}) };
    }
    return { ...base, cls: "available" };
  });

  return { nodes, edges };
}
