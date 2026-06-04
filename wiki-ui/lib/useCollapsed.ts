"use client";

/**
 * Per-workspace collapse state for the sidebar tree, persisted to localStorage.
 *
 * We store the *collapsed* node ids (not the expanded ones) so the default —
 * an empty set — means "everything expanded", which is the right behavior for
 * a freshly-seen workspace and for any node added after the state was saved.
 *
 * Hydration happens in an effect (not in the initializer) so the first client
 * render matches the server-rendered "all expanded" markup; otherwise React
 * would flag a hydration mismatch.
 */
import { useCallback, useEffect, useState } from "react";
import type { WorkspaceId } from "wiki";

const KEY_PREFIX = "wiki-ui:collapsed:";

export interface CollapsedState {
  /** True when `id`'s children should be hidden. */
  isCollapsed: (id: string) => boolean;
  /** Flip `id` between collapsed and expanded, persisting the result. */
  toggle: (id: string) => void;
}

function read(key: string): ReadonlySet<string> {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return new Set();
    const ids = JSON.parse(raw) as unknown;
    return Array.isArray(ids) ? new Set(ids.filter((x): x is string => typeof x === "string")) : new Set();
  } catch {
    // localStorage unavailable (private mode, disabled) or malformed JSON.
    return new Set();
  }
}

function write(key: string, ids: ReadonlySet<string>): void {
  try {
    window.localStorage.setItem(key, JSON.stringify([...ids]));
  } catch {
    // Ignore quota / availability errors — collapse state is non-essential.
  }
}

export function useCollapsed(workspaceId: WorkspaceId): CollapsedState {
  const storageKey = KEY_PREFIX + workspaceId;
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());

  // Load persisted state after mount (and whenever the workspace changes).
  useEffect(() => {
    setCollapsed(read(storageKey));
  }, [storageKey]);

  const toggle = useCallback(
    (id: string) => {
      setCollapsed((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        write(storageKey, next);
        return next;
      });
    },
    [storageKey],
  );

  const isCollapsed = useCallback((id: string) => collapsed.has(id), [collapsed]);

  return { isCollapsed, toggle };
}
