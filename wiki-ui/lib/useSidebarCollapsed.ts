"use client";

/**
 * App-wide sidebar collapse state, persisted to localStorage. Default EXPANDED; hydrated
 * in an effect so the first client render matches the server-rendered markup (the same
 * pattern as useShowArchived / useCollapsedDoc).
 */
import { useCallback, useEffect, useState } from "react";

const KEY = "wiki.sidebar.collapsed";

export interface SidebarCollapsed {
  readonly collapsed: boolean;
  toggle: () => void;
}

export function useSidebarCollapsed(): SidebarCollapsed {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(KEY) === "1");
    } catch {
      setCollapsed(false);
    }
  }, []);

  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(KEY, next ? "1" : "0");
      } catch {
        // Non-essential view state — ignore.
      }
      return next;
    });
  }, []);

  return { collapsed, toggle };
}
