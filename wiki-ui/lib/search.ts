"use client";

/**
 * Global search store (the Ctrl+K palette's brain). A module-level store exposed through
 * `useSyncExternalStore` — the same pattern as lib/view-mode.ts — so its state OUTLIVES
 * the modal's mount/unmount: closing the palette keeps the query, the ranked results, and
 * the selection, and Ctrl+K reopens to exactly that state (a requirement). The modal
 * component is a thin view over this store.
 *
 * Results come from the engine's real FTS (`wiki.search`), fanned out across every active
 * workspace, so the palette finds pages anywhere — not just the one you're viewing. The
 * engine only indexes a workspace once its handle has folded, so {@link ensureIndexed}
 * opens every active workspace the first time the palette is used; with IndexedDB
 * persistence that cost is paid once across sessions.
 */
import { useSyncExternalStore } from "react";
import type { SearchHit, WorkspaceId } from "wiki";
import { getWiki } from "./engine";

export type SearchStatus = "idle" | "loading" | "ready" | "error";

/** A ranked hit enriched with its workspace's display name (results span workspaces). */
export interface SearchResult extends SearchHit {
  readonly workspaceName: string;
}

export interface SearchState {
  readonly open: boolean;
  readonly query: string;
  readonly results: readonly SearchResult[];
  readonly status: SearchStatus;
  readonly error: string | null;
  /** Index of the keyboard-highlighted result. */
  readonly selected: number;
}

const INITIAL: SearchState = { open: false, query: "", results: [], status: "idle", error: null, selected: 0 };

let state: SearchState = INITIAL;
const listeners = new Set<() => void>();

function set(patch: Partial<SearchState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** The live palette state; re-renders subscribers on change. Stable server snapshot. */
export function useSearch(): SearchState {
  return useSyncExternalStore(subscribe, () => state, () => INITIAL);
}

// ── active-workspace catalog (search scope + name labels) ───────────────────────

interface WsRef {
  readonly id: WorkspaceId;
  readonly name: string;
}

let workspaces: readonly WsRef[] = [];

async function loadWorkspaces(): Promise<readonly WsRef[]> {
  const wiki = getWiki();
  if (wiki === null) return workspaces;
  try {
    const all = await wiki.listWorkspaces();
    // Mirror the rest of the UI: archived workspaces are hidden, so don't search them.
    workspaces = all.filter((w) => w.status === "active").map((w) => ({ id: w.id, name: w.name }));
  } catch {
    /* keep the last known list */
  }
  return workspaces;
}

let indexedOnce = false;

/**
 * Make sure every active workspace has been folded (and therefore indexed) at least once,
 * so the search spans all of them — not only the ones the user has visited this session.
 * Idempotent and best-effort: `openWorkspace` returns the cached handle when already open.
 */
async function ensureIndexed(): Promise<void> {
  if (indexedOnce) return;
  const wiki = getWiki();
  if (wiki === null) return;
  indexedOnce = true;
  const ws = await loadWorkspaces();
  await Promise.allSettled(ws.map((w) => wiki.openWorkspace(w.id)));
}

// ── open / close (state persists across both) ───────────────────────────────────

export function openSearch(): void {
  set({ open: true });
  // Prime the index in the background; if a query is already present (reopen), refresh it
  // once indexing settles so newly-folded workspaces contribute. Does not clear state.
  void ensureIndexed().then(() => {
    if (state.open && state.query.trim() !== "") void runQuery(state.query);
  });
}

export function closeSearch(): void {
  set({ open: false });
}

export function toggleSearch(): void {
  if (state.open) closeSearch();
  else openSearch();
}

// ── query (debounced) ───────────────────────────────────────────────────────────

let debounce: ReturnType<typeof setTimeout> | null = null;
let seq = 0;

export function setSearchQuery(query: string): void {
  set({ query, selected: 0 });
  if (debounce !== null) clearTimeout(debounce);
  if (query.trim() === "") {
    seq++; // cancel any in-flight result from applying
    set({ results: [], status: "idle", error: null });
    return;
  }
  set({ status: "loading" });
  debounce = setTimeout(() => void runQuery(query), 130);
}

async function runQuery(query: string): Promise<void> {
  const wiki = getWiki();
  if (wiki === null) {
    set({ status: "error", error: "Engine not ready." });
    return;
  }
  const mySeq = ++seq;
  set({ status: "loading" });
  try {
    const ws = workspaces.length > 0 ? workspaces : await loadWorkspaces();
    const ids = ws.map((w) => w.id);
    const hits = await wiki.search(query, { workspaces: ids, limit: 40 });
    if (mySeq !== seq) return; // a newer query superseded this one
    const nameOf = new Map(ws.map((w) => [w.id, w.name] as const));
    const results: SearchResult[] = hits.map((h) => ({
      ...h,
      workspaceName: nameOf.get(h.workspaceId as WorkspaceId) ?? h.workspaceId,
    }));
    set({ results, status: "ready", error: null, selected: 0 });
  } catch (e) {
    if (mySeq !== seq) return;
    set({ results: [], status: "error", error: e instanceof Error ? e.message : String(e) });
  }
}

// ── selection ───────────────────────────────────────────────────────────────────

export function moveSelection(delta: number): void {
  const n = state.results.length;
  if (n === 0) return;
  const next = Math.min(n - 1, Math.max(0, state.selected + delta));
  if (next !== state.selected) set({ selected: next });
}

export function setSelected(index: number): void {
  if (index !== state.selected) set({ selected: index });
}
