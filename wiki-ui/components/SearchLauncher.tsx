"use client";

/**
 * Mounts the global Ctrl/Cmd+K shortcut and the search palette. Lives once at the root
 * (app/layout.tsx) so the shortcut works on every route — landing, workspace, or page.
 * The toggle is intentionally idempotent against state: it only flips `open`, never
 * resets the query/results, so reopening restores the previous session (lib/search.ts).
 */
import { useEffect } from "react";
import { toggleSearch } from "../lib/search";
import { SearchModal } from "./SearchModal";

export function SearchLauncher(): React.JSX.Element {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        toggleSearch();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return <SearchModal />;
}
