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
import type { FsmDescriptor, IMutationDescriptor } from "wiki";

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

/**
 * A status is **terminal** when the lifecycle can REACH it but cannot LEAVE it — some
 * transition lands on `status` and none leaves it (sealed/final, e.g. `shipped`,
 * `rejected`, `superseded`). Requiring an incoming edge is what distinguishes a true
 * terminal from the *initial* status of a type with no status lifecycle at all (e.g.
 * `toc`, whose only state `active` has neither incoming nor outgoing edges) — such a
 * page is not "sealed", it simply never transitions, so it must NOT get the treatment.
 * Pure, so it is shared by the page header and the sidebar without touching React.
 */
export function isTerminalStatus(fsm: FsmDescriptor, status: string): boolean {
  const hasIncoming = fsm.transitions.some((tr) => tr.to === status);
  const hasOutgoing = fsm.transitions.some((tr) => tr.from === status);
  return hasIncoming && !hasOutgoing;
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

// ── interactive transitions (feature: wiki-ui interactive FSM transitions) ──────

/**
 * The clicked-edge context handed to the transition form: which command to run, the
 * states it moves between, whether it is runnable now, and — when blocked — why.
 */
export interface TransitionTarget {
  /** The command behind the edge; `descriptor.name === FsmTransition.event`. */
  readonly descriptor: IMutationDescriptor;
  readonly from: string;
  readonly to: string;
  /** From the overlay: runnable now (the edge was `available`). */
  readonly available: boolean;
  /** When blocked, the first failed precondition's reason (from the descriptor). */
  readonly unmet?: string;
}

/** The minimal per-edge data the graph carries so a click can be resolved purely. */
export interface EdgeRef {
  readonly event: string;
  readonly from: string;
  readonly to: string;
  readonly cls: EdgeClass;
}

/**
 * Resolve a clicked edge to a runnable/blocked {@link TransitionTarget}, or `null` when
 * the edge is not interactive: `inert` edges (they don't leave the current state) and
 * edges whose command is absent from the overlay are ignored. Pure, so the interaction
 * rule is unit-testable without React Flow. `available` maps to a runnable form; `blocked`
 * maps to a read-only form carrying the descriptor's `unmet` reason.
 */
export function resolveTransitionTarget(
  edge: EdgeRef,
  descriptors: readonly IMutationDescriptor[],
): TransitionTarget | null {
  if (edge.cls === "inert") return null;
  const descriptor = descriptors.find((d) => d.name === edge.event);
  if (descriptor === undefined) return null;
  return {
    descriptor,
    from: edge.from,
    to: edge.to,
    available: edge.cls === "available",
    ...(edge.cls === "blocked" && descriptor.unmet !== undefined ? { unmet: descriptor.unmet } : {}),
  };
}
