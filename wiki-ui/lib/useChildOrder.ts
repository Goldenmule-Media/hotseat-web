"use client";

/**
 * Per-workspace, UI-ONLY child ordering for the sidebar tree, persisted to localStorage.
 *
 * The engine owns one canonical sibling order; this is a *view* layered on top — a local,
 * per-browser rearrangement (drag-to-reorder) that never writes to the stream. We store, per
 * parent, the ordered child ids the user arranged. `applyOrder` re-sorts a parent's engine-
 * ordered children to match, appending any child NOT yet in the stored list (e.g. a freshly
 * created page) in its canonical position — so new pages always appear.
 *
 * Like `useCollapsed`, hydration happens in an effect (not the initializer) so the first client
 * render matches the server-rendered (canonical-order) markup.
 */
import { useCallback, useEffect, useState } from "react";
import type { ITreeNode, WorkspaceId } from "wiki";

const KEY_PREFIX = "wiki-ui:childorder:";

type Orders = Record<string, string[]>;

export interface ChildOrder {
  /** Re-sort a parent's children to the user's stored order (canonical order as fallback). */
  applyOrder: (parentKey: string, children: readonly ITreeNode[]) => ITreeNode[];
  /** Persist a new explicit order for `parentKey`'s children. */
  setOrder: (parentKey: string, orderedIds: readonly string[]) => void;
}

function read(key: string): Orders {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object") return {};
    const out: Orders = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === "string");
    }
    return out;
  } catch {
    // localStorage unavailable (private mode, disabled) or malformed JSON.
    return {};
  }
}

function write(key: string, orders: Orders): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(orders));
  } catch {
    // Non-essential view state — ignore quota / availability errors.
  }
}

export function useChildOrder(workspaceId: WorkspaceId): ChildOrder {
  const storageKey = KEY_PREFIX + workspaceId;
  const [orders, setOrders] = useState<Orders>({});

  useEffect(() => {
    setOrders(read(storageKey));
  }, [storageKey]);

  const applyOrder = useCallback(
    (parentKey: string, children: readonly ITreeNode[]): ITreeNode[] => {
      const stored = orders[parentKey];
      if (stored === undefined || stored.length === 0) return [...children];
      const byId = new Map(children.map((c) => [String(c.id), c]));
      const result: ITreeNode[] = [];
      for (const childId of stored) {
        const child = byId.get(childId);
        if (child !== undefined) {
          result.push(child);
          byId.delete(childId);
        }
      }
      // Any child not in the stored order (new pages) keeps its canonical position.
      for (const child of children) if (byId.has(String(child.id))) result.push(child);
      return result;
    },
    [orders],
  );

  const setOrder = useCallback(
    (parentKey: string, orderedIds: readonly string[]) => {
      setOrders((prev) => {
        const next = { ...prev, [parentKey]: [...orderedIds] };
        write(storageKey, next);
        return next;
      });
    },
    [storageKey],
  );

  return { applyOrder, setOrder };
}
