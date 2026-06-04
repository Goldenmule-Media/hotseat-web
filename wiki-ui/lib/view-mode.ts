"use client";

/**
 * Sticky page-view mode (Content vs Model), shared across page navigations. It lives in
 * a module-level store rather than per-page component state, so switching to the Model
 * view and then opening another page keeps you in the Model view — the toggle is a
 * global UI preference (like a collapsed sidebar), not a per-page reset.
 */
import { useSyncExternalStore } from "react";

export type ViewMode = "content" | "model";

let current: ViewMode = "content";
const listeners = new Set<() => void>();

export function setViewMode(next: ViewMode): void {
  if (next === current) return;
  current = next;
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** The current sticky view mode; re-renders subscribers when it changes. */
export function useViewMode(): ViewMode {
  // Server snapshot is always "content" — the engine/graph is client-only anyway.
  return useSyncExternalStore(subscribe, () => current, () => "content");
}
