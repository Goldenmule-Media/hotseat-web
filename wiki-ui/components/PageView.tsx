"use client";

/** Page body (plan step 6-7). Renders the engine's deterministic Markdown as HTML
 *  (constraint #5 — no re-implemented presentation), intercepts intra-wiki link clicks
 *  for in-app SPA navigation, and offers a clickable child-pages strip drawn from the
 *  live tree (the engine renders child titles as plain text, so navigation comes from
 *  structured data, not body parsing). Live-updates via `usePage`.
 *
 *  A header toggle switches to the model-inspection view (feature: wiki-ui model
 *  inspection): the page TYPE's status FSM as a graph, with this page INSTANCE's current
 *  state highlighted and its transitions classified available / blocked / inert from the
 *  live, precondition-aware mutation overlay. */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type { PageId, WorkspaceId } from "wiki";
import { getWiki } from "../lib/engine";
import { useLiveWorkspace, usePage, usePageMutations, useStructuralMutator } from "../lib/live";
import { renderMarkdown } from "../lib/markdown";
import { pageHref } from "../lib/routes";
import { clearScrollTarget, scrollToTerms, useScrollTarget } from "../lib/search-scroll";
import { findNode } from "../lib/tree";
import { isTerminalStatus } from "../lib/fsm-graph";
import { setViewMode, useViewMode } from "../lib/view-mode";
import { FsmGraph } from "./FsmGraph";

export function PageView({
  workspaceId,
  pageId,
}: {
  workspaceId: WorkspaceId;
  pageId: PageId;
}): React.JSX.Element {
  const router = useRouter();
  // Brief "copied" feedback for the page-id link button.
  const [copied, setCopied] = useState(false);
  const ws = useLiveWorkspace(workspaceId);
  const { markdown, loading, error, unknownType } = usePage(workspaceId, pageId);
  const { descriptors } = usePageMutations(workspaceId, pageId);
  const mode = useViewMode();
  const structural = useStructuralMutator(workspaceId);

  // Lift the page's H1 out of the body so it can live in a persistent header (kept in
  // both Content and Model views); render the remaining markdown as the body.
  const { title, body } = useMemo(() => {
    if (markdown === null) return { title: null as string | null, body: "" };
    const nl = markdown.indexOf("\n");
    const first = (nl === -1 ? markdown : markdown.slice(0, nl)).trim();
    if (first.startsWith("# ")) {
      return { title: first.slice(2).trim(), body: nl === -1 ? "" : markdown.slice(nl + 1) };
    }
    return { title: null, body: markdown };
  }, [markdown]);

  const html = useMemo(() => renderMarkdown(body, workspaceId), [body, workspaceId]);

  // Scroll-to-match: when a search result for THIS page is chosen, the palette parks a
  // target; once the body is rendered we scroll to and highlight the matched text, then
  // clear it so it fires once. Only meaningful in the content view.
  const articleRef = useRef<HTMLElement>(null);
  const scrollTarget = useScrollTarget();
  useEffect(() => {
    if (mode !== "content") return;
    if (scrollTarget === null || scrollTarget.workspaceId !== workspaceId || scrollTarget.pageId !== pageId) return;
    const el = articleRef.current;
    if (el === null || html === "") return;
    const raf = requestAnimationFrame(() => {
      scrollToTerms(el, scrollTarget.terms);
      clearScrollTarget();
    });
    return () => cancelAnimationFrame(raf);
  }, [scrollTarget, workspaceId, pageId, html, mode]);

  const node = findNode(ws.tree, pageId);
  const children = node?.children ?? [];
  const pageType = node?.type;
  const archived = node?.archived === true;

  // The page TYPE's status FSM, from the in-browser engine (Q2). Null on server render
  // or for an unknown type — the model toggle is then simply not offered.
  const fsm = useMemo(() => {
    const wiki = getWiki();
    if (wiki === null || pageType === undefined) return null;
    try {
      return wiki.fsmOf(pageType);
    } catch {
      return null;
    }
  }, [pageType]);

  const currentStatus = node?.status ?? fsm?.initial ?? "";
  // The header always shows the current status; a terminal (sealed/final) status gets the
  // distinct filled treatment on top of the always-present chip.
  const isTerminal = fsm !== null && currentStatus !== "" && isTerminalStatus(fsm, currentStatus);

  // Keep rewritten intra-wiki links as in-app navigations instead of full reloads.
  function onClick(e: MouseEvent<HTMLDivElement>): void {
    const a = (e.target as HTMLElement).closest("a");
    if (a === null) return;
    const href = a.getAttribute("href");
    if (href === null) return;
    if (href.startsWith("/")) {
      e.preventDefault();
      router.push(href);
    }
  }

  if (error !== null) {
    return (
      <div className="page">
        <div className="notice error">
          <strong>{unknownType ? "Unknown page type" : "Could not load page"}</strong>
          <p className="muted">
            {unknownType
              ? "This page's type is not in this build's model bundle. Add its bundle to lib/models.ts and rebuild."
              : error}
          </p>
        </div>
      </div>
    );
  }

  const headerTitle = title ?? node?.title ?? null;

  return (
    <div className="page">
      <header className="page-header">
        <div className="page-header-main">
          {headerTitle !== null && <h1 className="page-title">{headerTitle}</h1>}
          <button
            type="button"
            className="page-id-copy"
            aria-label="Copy page id"
            title={copied ? "Copied!" : `Copy page id: ${pageId}`}
            onClick={() => {
              const cb = navigator.clipboard;
              if (cb === undefined) return; // needs a secure context (https/localhost)
              void cb
                .writeText(pageId)
                .then(() => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1200);
                })
                .catch(() => {});
            }}
          >
            {copied ? "✓" : "🔗"}
          </button>
          {currentStatus !== "" && (
            <span
              className={`page-status-badge${isTerminal ? " page-terminal-badge" : ""}`}
              title={isTerminal ? "Terminal status — no further transitions" : "Current status"}
            >
              {currentStatus}
            </span>
          )}
          {archived && <span className="page-archived-badge">archived</span>}
        </div>
        <div className="page-header-actions">
          {node !== undefined && (
            <button
              type="button"
              className="page-archive-btn"
              disabled={structural.pending}
              title={archived ? "Restore this page to the sidebar" : "Hide this page from the sidebar"}
              onClick={() => {
                if (archived) void structural.unarchive(pageId);
                else void structural.archive(pageId);
              }}
            >
              {archived ? "Unarchive" : "Archive"}
            </button>
          )}
          {fsm !== null && (
            <div className="view-toggle" role="tablist" aria-label="Page view">
              <button
                type="button"
                role="tab"
                aria-selected={mode === "content"}
                className={`view-tab ${mode === "content" ? "active" : ""}`}
                onClick={() => setViewMode("content")}
              >
                Content
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === "model"}
                className={`view-tab ${mode === "model" ? "active" : ""}`}
                onClick={() => setViewMode("model")}
              >
                Model
              </button>
            </div>
          )}
        </div>
      </header>
      {structural.error !== null && (
        <p className="page-archive-error" role="alert">
          {structural.error}
        </p>
      )}

      {mode === "model" && fsm !== null ? (
        <FsmGraph
          fsm={fsm}
          currentStatus={currentStatus}
          descriptors={descriptors}
          workspaceId={workspaceId}
          pageId={pageId}
        />
      ) : loading && markdown === null ? (
        <p className="muted">Loading page…</p>
      ) : (
        <>
          {/* eslint-disable-next-line react/no-danger */}
          <article ref={articleRef} className="markdown" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
          {children.length > 0 && (
            <nav className="child-links" aria-label="Child pages">
              <h2>Child pages</h2>
              <ul>
                {children.map((c) => (
                  <li key={c.id}>
                    <Link href={pageHref(workspaceId, c.id)}>{c.title}</Link>
                    {c.type !== undefined && <span className="muted"> · {c.type}</span>}
                  </li>
                ))}
              </ul>
            </nav>
          )}
        </>
      )}
    </div>
  );
}
