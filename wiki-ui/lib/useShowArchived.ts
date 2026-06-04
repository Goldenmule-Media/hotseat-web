"use client";

/**
 * Per-workspace "show archived pages" toggle for the sidebar, persisted to localStorage.
 *
 * Default OFF — archived pages (and their subtrees) are hidden from the tree until revealed.
 * Hydrated in an effect so the first client render matches the server-rendered (hidden) markup.
 */
import { useCallback, useEffect, useState } from "react";
import type { WorkspaceId } from "wiki";

const KEY_PREFIX = "wiki-ui:show-archived:";

export interface ShowArchived {
  readonly show: boolean;
  toggle: () => void;
}

export function useShowArchived(workspaceId: WorkspaceId): ShowArchived {
  const storageKey = KEY_PREFIX + workspaceId;
  const [show, setShow] = useState(false);

  useEffect(() => {
    try {
      setShow(window.localStorage.getItem(storageKey) === "1");
    } catch {
      setShow(false);
    }
  }, [storageKey]);

  const toggle = useCallback(() => {
    setShow((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(storageKey, next ? "1" : "0");
      } catch {
        // Non-essential view state — ignore.
      }
      return next;
    });
  }, [storageKey]);

  return { show, toggle };
}
