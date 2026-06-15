"use client";

/**
 * Collapse state for a baked-in splash doc section, persisted to localStorage. Default EXPANDED
 * — a first-time visitor sees the docs; collapsing one remembers it. Hydrated in an effect so the
 * first client render matches the server-rendered (expanded) markup.
 */
import { useCallback, useEffect, useState } from "react";

const KEY_PREFIX = "wiki-ui:doc-collapsed:";

export interface CollapsedDoc {
  readonly collapsed: boolean;
  toggle: () => void;
}

export function useCollapsedDoc(id: string): CollapsedDoc {
  const storageKey = KEY_PREFIX + id;
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(storageKey) === "1");
    } catch {
      setCollapsed(false);
    }
  }, [storageKey]);

  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(storageKey, next ? "1" : "0");
      } catch {
        // Non-essential view state — ignore.
      }
      return next;
    });
  }, [storageKey]);

  return { collapsed, toggle };
}
