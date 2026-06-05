/**
 * Terminal-status lookup keyed by page TYPE — the form the sidebar needs. A tree node
 * carries only its `type` + `status` string (no FSM), so this resolves the type's status
 * FSM from the in-browser engine and asks {@link isTerminalStatus}. The page header has the
 * FSM in hand already and calls `isTerminalStatus` directly; this is the by-type companion.
 *
 * FSM descriptors are immutable per page type, so they are memoised once resolved. Nothing
 * is cached on the server (`getWiki()` is null there) — terminal-ness simply reads false
 * until the client engine exists, matching how the rest of the UI treats SSR.
 */
import type { FsmDescriptor } from "wiki";
import { getWiki } from "./engine";
import { isTerminalStatus } from "./fsm-graph";

const fsmByType = new Map<string, FsmDescriptor>();

function fsmForType(type: string): FsmDescriptor | null {
  const cached = fsmByType.get(type);
  if (cached !== undefined) return cached;
  const wiki = getWiki();
  if (wiki === null) return null;
  try {
    const fsm = wiki.fsmOf(type);
    fsmByType.set(type, fsm);
    return fsm;
  } catch {
    return null;
  }
}

/** True when `status` is a terminal state of `type`'s FSM. Tolerant of the partial data a
 *  tree node may carry (missing type/status, unknown type, server render) — all read false. */
export function isTerminalNodeStatus(type: string | undefined, status: string | undefined): boolean {
  if (type === undefined || status === undefined) return false;
  const fsm = fsmForType(type);
  return fsm !== null && isTerminalStatus(fsm, status);
}
