/**
 * Terminal-status lookup keyed by page TYPE — the form the sidebar needs. A tree node carries
 * only its `type` + `status` string (no FSM), so this resolves the type's status FSM and asks
 * {@link isTerminalStatus}. The page header has the FSM in hand already and calls
 * `isTerminalStatus` directly; this is the by-type companion.
 *
 * FSM descriptors come from the SharedWorker handshake cache via the synchronous
 * {@link fsmOf} — immutable per type and memoised there (including the MISS for an unknown
 * type, which reads as `null`). Before the handshake completes ({@link fsmReady} is false) this
 * reads `false`, matching how the rest of the UI treats the not-yet-ready engine; once the
 * first tree snapshot arrives (strictly after the handshake) the tree re-renders and this
 * resolves correctly.
 */
import { fsmOf, fsmReady } from "./host-client";
import { isTerminalStatus } from "./fsm-graph";

/** True when `status` is a terminal state of `type`'s FSM. Tolerant of the partial data a tree
 *  node may carry (missing type/status, unknown type, pre-handshake) — all read false. */
export function isTerminalNodeStatus(type: string | undefined, status: string | undefined): boolean {
  if (type === undefined || status === undefined) return false;
  if (!fsmReady()) return false; // handshake not done yet — re-evaluated on the next render
  const fsm = fsmOf(type);
  return fsm !== null && isTerminalStatus(fsm, status);
}
