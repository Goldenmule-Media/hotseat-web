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
import { useMemo, type MouseEvent } from "react";
import type { PageId, WorkspaceId } from "wiki";
import { getWiki } from "../lib/engine";
import { useLiveWorkspace, usePage, usePageMutations } from "../lib/live";
import { renderMarkdown } from "../lib/markdown";
import { pageHref } from "../lib/routes";
import { findNode } from "../lib/tree";
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
  const ws = useLiveWorkspace(workspaceId);
  const { markdown, loading, error, unknownType } = usePage(workspaceId, pageId);
  const { descriptors } = usePageMutations(workspaceId, pageId);
  const mode = useViewMode();

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

  const node = findNode(ws.tree, pageId);
  const children = node?.children ?? [];
  const pageType = node?.type;

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
        {headerTitle !== null && <h1 className="page-title">{headerTitle}</h1>}
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
      </header>

      {mode === "model" && fsm !== null ? (
        <FsmGraph fsm={fsm} currentStatus={currentStatus} overlay={descriptors} />
      ) : loading && markdown === null ? (
        <p className="muted">Loading page…</p>
      ) : (
        <>
          {/* eslint-disable-next-line react/no-danger */}
          <article className="markdown" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
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
