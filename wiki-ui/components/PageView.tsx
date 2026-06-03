"use client";

/** Page body (plan step 6-7). Renders the engine's deterministic Markdown as HTML
 *  (constraint #5 — no re-implemented presentation), intercepts intra-wiki link clicks
 *  for in-app SPA navigation, and offers a clickable child-pages strip drawn from the
 *  live tree (the engine renders child titles as plain text, so navigation comes from
 *  structured data, not body parsing). Live-updates via `usePage`. */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, type MouseEvent } from "react";
import type { PageId, WorkspaceId } from "wiki";
import { useLiveWorkspace, usePage } from "../lib/live";
import { renderMarkdown } from "../lib/markdown";
import { pageHref } from "../lib/routes";
import { findNode } from "../lib/tree";

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

  const html = useMemo(
    () => (markdown !== null ? renderMarkdown(markdown, workspaceId) : ""),
    [markdown, workspaceId],
  );

  const node = findNode(ws.tree, pageId);
  const children = node?.children ?? [];

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

  return (
    <div className="page">
      {loading && markdown === null ? (
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
