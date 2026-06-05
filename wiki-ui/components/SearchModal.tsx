"use client";

/**
 * The Ctrl+K command palette (Notion-style): a centered overlay with a query input and a
 * ranked, keyboard-navigable result list drawn from the engine's full-text search. It is
 * a thin view over the module-level search store (lib/search.ts) — all state lives there
 * so the palette reopens exactly as it was left.
 *
 * Choosing a result navigates to its page, parks a scroll target (lib/search-scroll.ts)
 * so the destination scrolls to and highlights the matched text, and closes the palette.
 */
import { useRouter } from "next/navigation";
import { useEffect, useRef, type KeyboardEvent, type MouseEvent } from "react";
import { pageHref } from "../lib/routes";
import {
  closeSearch,
  moveSelection,
  setSearchQuery,
  setSelected,
  useSearch,
  type SearchResult,
} from "../lib/search";
import { requestScrollTo } from "../lib/search-scroll";
import { extractTerms, parseSnippet } from "../lib/snippet";

export function SearchModal(): React.JSX.Element | null {
  const { open, query, results, status, error, selected } = useSearch();
  const router = useRouter();
  const listRef = useRef<HTMLUListElement>(null);

  // Keep the keyboard-selected row visible as it moves / on reopen.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${selected}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [open, selected, results]);

  if (!open) return null;

  function choose(result: SearchResult): void {
    requestScrollTo({
      workspaceId: result.workspaceId,
      pageId: result.pageId,
      terms: extractTerms(result.snippet, query),
    });
    closeSearch();
    router.push(pageHref(result.workspaceId, result.pageId));
  }

  function onInputKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
      e.preventDefault();
      moveSelection(1);
    } else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
      e.preventDefault();
      moveSelection(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = results[selected];
      if (hit !== undefined) choose(hit);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeSearch();
    }
  }

  // Click on the backdrop (not the panel) closes.
  function onOverlayMouseDown(e: MouseEvent<HTMLDivElement>): void {
    if (e.target === e.currentTarget) closeSearch();
  }

  const showEmpty = status === "ready" && results.length === 0 && query.trim() !== "";

  return (
    <div className="search-overlay" onMouseDown={onOverlayMouseDown} role="presentation">
      <div className="search-modal" role="dialog" aria-modal="true" aria-label="Search">
        <input
          className="search-input"
          type="text"
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          placeholder="Search all workspaces…"
          value={query}
          spellCheck={false}
          aria-label="Search query"
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={onInputKeyDown}
        />

        {error !== null && <div className="search-status error">{error}</div>}
        {status === "loading" && results.length === 0 && <div className="search-status muted">Searching…</div>}
        {query.trim() === "" && status !== "loading" && (
          <div className="search-status muted">Type to search page content across every workspace.</div>
        )}
        {showEmpty && <div className="search-status muted">No matches for “{query.trim()}”.</div>}

        {results.length > 0 && (
          <ul className="search-results" ref={listRef}>
            {results.map((r, i) => (
              <li key={`${r.workspaceId}/${r.pageId}`}>
                <button
                  type="button"
                  data-idx={i}
                  className={`search-result${i === selected ? " selected" : ""}`}
                  onMouseMove={() => setSelected(i)}
                  onClick={() => choose(r)}
                >
                  <span className="search-result-head">
                    <span className="search-result-title">{r.title}</span>
                    <span className="search-result-meta">
                      {r.workspaceName} · {r.type} · {r.status}
                    </span>
                  </span>
                  <span className="search-snippet">
                    {parseSnippet(r.snippet).map((seg, j) =>
                      seg.hit ? (
                        <mark key={j} className="search-snippet-hit">
                          {seg.text}
                        </mark>
                      ) : (
                        <span key={j}>{seg.text}</span>
                      ),
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="search-footer">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> navigate
          </span>
          <span>
            <kbd>↵</kbd> open
          </span>
          <span>
            <kbd>esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}
