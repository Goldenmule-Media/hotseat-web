/**
 * Terminal-status lookup keyed by page TYPE — the form the sidebar needs. A tree node
 * carries only its `type` + `status` string (no FSM), so this resolves the type's status
 * FSM from the in-browser engine and asks {@link isTerminalStatus}. The page header has the
 * FSM in hand already and calls `isTerminalStatus` directly; this is the by-type companion.
 *
 * FSM descriptors are immutable per page type, so they are memoised once resolved —
 * including the MISS for an unknown type (cached as `null`), so a node of a type the
 * client engine doesn't know doesn't re-throw through `fsmOf` on every render. The
 * server render (`getWiki()` is null) is deliberately NOT cached: the engine appears
 * later on the client, and terminal-ness simply reads false until it does, matching how
 * the rest of the UI treats SSR.
 */
import type { FsmDescriptor } from "wiki";
import { getWiki } from "./engine";
import { isTerminalStatus } from "./fsm-graph";

const fsmByType = new Map<string, FsmDescriptor | null>();

function fsmForType(type: string): FsmDescriptor | null {
  if (fsmByType.has(type)) return fsmByType.get(type) ?? null;
  const wiki = getWiki();
  if (wiki === null) return null; // SSR / engine not ready yet — do not memoise, retry later.
  try {
    const fsm = wiki.fsmOf(type);
    fsmByType.set(type, fsm);
    return fsm;
  } catch {
    fsmByType.set(type, null); // Unknown type — memoise the miss so it isn't re-resolved.
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
