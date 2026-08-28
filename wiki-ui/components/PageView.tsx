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
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type { PageId, WorkspaceId } from "wiki";
import { fsmOf } from "../lib/host-client";
import { useLiveWorkspace, usePage, usePageMutations, usePageMutator, usePageScalar, useStructuralMutator } from "../lib/live";
import { resolveAttachmentsIn } from "../lib/attachments";
import { renderMarkdown } from "../lib/markdown";
import * as perf from "../lib/perf";
import { contentsModeOf } from "../lib/contents-mode";
import { defOf, typesRenderingOwnChildren } from "../lib/models";
import { pageHref } from "../lib/routes";
import { clearScrollTarget, scrollToTerms, useScrollTarget } from "../lib/search-scroll";
import { findNode } from "../lib/tree";
import { isTerminalStatus } from "../lib/fsm-graph";
import { ARTICLE_PAGE_TYPE } from "../lib/article-notes";
import { GLOSSARY_PAGE_TYPE } from "../lib/glossary";
import { RECIPE_PAGE_TYPE } from "../lib/recipe";
import { RESTATE_PAGE_TYPE } from "../lib/restate";
import { STUDY_PAGE_TYPE } from "../lib/study";
import { isStudioView, preferredViewMode, rememberViewMode, type StudioView, type ViewMode } from "../lib/view-mode";
import { CreatePageModal } from "./CreatePageModal";
import { FsmGraph } from "./FsmGraph";
import { ArticleStudio } from "./ArticleStudio";
import { GlossaryStudio } from "./GlossaryStudio";
import { RecipeStudio } from "./RecipeStudio";
import { RestateStudio } from "./RestateStudio";
import { StudyStudio } from "./StudyStudio";
import { SchemaInspector } from "./SchemaInspector";

/** Page types with a studio, and the view tag each owns. */
const STUDIO_OF: Readonly<Record<string, StudioView>> = {
  [RESTATE_PAGE_TYPE]: "restate",
  [STUDY_PAGE_TYPE]: "study",
  [GLOSSARY_PAGE_TYPE]: "glossary",
  [ARTICLE_PAGE_TYPE]: "article",
  [RECIPE_PAGE_TYPE]: "recipe",
};

const STUDIO_LABEL: Readonly<Record<StudioView, string>> = {
  restate: "Restate",
  study: "Study",
  glossary: "Glossary",
  article: "Notes",
  recipe: "Cook",
};

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
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const ws = useLiveWorkspace(workspaceId);
  const { markdown, loading, error, unknownType, pageId: contentPageId } = usePage(workspaceId, pageId);
  const { descriptors } = usePageMutations(workspaceId, pageId);
  const structural = useStructuralMutator(workspaceId);

  // The route segment for this page has committed. Layout effect, and keyed on the params
  // rather than on mount: App Router UPDATES this component across a [pageId] change, it does
  // not remount it.
  useLayoutEffect(() => perf.routeCommit(workspaceId, pageId), [workspaceId, pageId]);

  const node = findNode(ws.tree, pageId);
  const pageType = node?.type;
  const archived = node?.archived === true;
  // Studio page types get their studio as the DEFAULT view (no ?view param): the studio
  // IS the type's reading surface; the raw markdown stays reachable behind an explicit
  // ?view=content. Each studio owns its ViewMode tag.
  const studio: StudioView | null = pageType === undefined ? null : (STUDIO_OF[pageType] ?? null);
  const hasStudio = studio !== null;

  // The active view is the URL's source of truth, so a refresh or shared link reopens the
  // same tab.
  const searchParams = useSearchParams();
  const rawView = searchParams.get("view");
  const mode: ViewMode =
    rawView === "model"
      ? "model"
      : isStudioView(rawView)
        ? rawView === studio
          ? studio
          : "content"
        : rawView === "content"
          ? "content"
          : (studio ?? "content");

  const selectView = useCallback(
    (next: ViewMode) => {
      rememberViewMode(next);
      // A studio page's default is the studio, so Content needs an explicit stamp.
      const href =
        next === "content" && hasStudio ? `${pageHref(workspaceId, pageId)}?view=content` : pageHref(workspaceId, pageId, next);
      router.replace(href);
    },
    [router, workspaceId, pageId, hasStudio],
  );

  // Sticky across navigations: opening another page with no explicit ?view carries over the
  // last toggle, re-stamping it into the URL (run on navigation only — a user toggle already
  // sets the URL via selectView).
  useEffect(() => {
    if (preferredViewMode() === "model" && searchParams.get("view") !== "model") {
      router.replace(pageHref(workspaceId, pageId, "model"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, pageId]);

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

  const html = useMemo(
    () => perf.timeMarkdown(contentPageId ?? pageId, body.length, () => renderMarkdown(body, workspaceId)),
    [body, workspaceId, contentPageId, pageId],
  );

  const articleRef = useRef<HTMLElement>(null);

  // Paint completion. Double rAF: the first callback runs before the frame carrying this commit
  // is painted, the second at the start of the next one — i.e. after presentation. That
  // over-reports by up to one frame, uniformly, so comparisons stay valid.
  useEffect(() => {
    if (contentPageId === null) return;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        // Only the content view paints an <article>; a studio/model view is a different render.
        if (articleRef.current !== null) perf.painted(contentPageId, html.length);
      });
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [contentPageId, html]);

  // Scroll-to-match: when a search result for THIS page is chosen, the palette parks a
  // target; once the body is rendered we scroll to and highlight the matched text, then
  // clear it so it fires once. Only meaningful in the content view.
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

  // Attachment URLs can't be resolved at render time: a plain <img src> cannot send the
  // bearer, and wiki-ui is a different origin from the server so a cookie is out. Fetch
  // them here instead and swap in object URLs, once the rendered HTML is in the DOM.
  useEffect(() => {
    if (mode !== "content") return;
    const el = articleRef.current;
    if (el === null || html === "") return;
    return resolveAttachmentsIn(el, workspaceId);
  }, [html, workspaceId, mode]);

  // The page renders its own curated child list in the body (e.g. a TOC's "Contents"), so
  // suppress the generic child-pages strip rather than shadow it with a raw duplicate. This
  // reads the model-declared `graphSections:false` signal — no type name is hardcoded.
  const rendersOwnChildren = pageType !== undefined && typesRenderingOwnChildren.has(pageType);
  // Never list archived children in the strip (they live in the sidebar's "Archived" section,
  // matching TreeNav); for a self-rendering type the strip is dropped entirely.
  const children = rendersOwnChildren ? [] : (node?.children ?? []).filter((c) => c.archived !== true);

  // The page TYPE's status FSM, from the worker handshake cache (synchronous). Null before
  // the handshake, on server render, or for an unknown type — the model toggle is then simply
  // not offered. `pageType` only becomes defined once the workspace snapshot arrives (after
  // the handshake), so the descriptor is cached by the time this resolves.
  const fsm = useMemo(() => fsmOf(pageType), [pageType]);
  // The page TYPE's content schema (sections/fields/mutableIn), read synchronously from the
  // build-time-bundled page types — no worker round-trip (see lib/models.ts defOf).
  const def = useMemo(() => defOf(pageType), [pageType]);

  // A type that can INLINE its children declares how to toggle it (which field, which
  // command, which values). Null for every type that cannot — no `toc` literal here.
  const contentsMode = useMemo(() => contentsModeOf(def), [def]);
  const modeField = useMemo(() => {
    const s = def?.render.sections.find((x) => x.section === "@children-content");
    const f = s?.when?.field;
    const dot = f === undefined ? -1 : f.indexOf(".");
    return dot < 0 || f === undefined ? null : { section: f.slice(0, dot), key: f.slice(dot + 1) };
  }, [def]);
  const modeValue = usePageScalar(workspaceId, pageId, modeField?.section ?? null, modeField?.key ?? null);
  const inlined = contentsMode !== null && modeValue === contentsMode.inline;
  const modeMutator = usePageMutator(workspaceId, pageId);
  const [addChildOpen, setAddChildOpen] = useState(false);

  const currentStatus = node?.status ?? fsm?.initial ?? "";
  // The header always shows the current status; a terminal (sealed/final) status gets the
  // distinct filled treatment on top of the always-present chip.
  const isTerminal = fsm !== null && currentStatus !== "" && isTerminalStatus(fsm, currentStatus);
  // The model's own "finished" classifier — see lib/terminal.ts.
  const isDone = fsm?.done?.includes(currentStatus) === true;

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

  // Renaming edits the page's OWN title, not the rendered H1 a type may prefix. Enter
  // commits and blurs, so the blur handler must not commit the same draft twice.
  const renaming = useRef(false);
  const commitTitle = async (): Promise<void> => {
    if (renaming.current) return;
    const next = (titleDraft ?? "").trim();
    if (next === "" || next === node?.title) {
      setTitleDraft(null);
      return;
    }
    renaming.current = true;
    try {
      if (await structural.rename(pageId, next)) setTitleDraft(null);
    } finally {
      renaming.current = false;
    }
  };
  // A studio view opts out of the content column's reading max-width and pins the
  // header while its two columns scroll independently (globals.css, `.page-restate` —
  // both studios share the layout).
  const restateActive = mode === studio && hasStudio;

  return (
    <div className={restateActive ? "page page-restate" : "page"}>
      <header className="page-header">
        <div className="page-header-meta">
          <div className="page-meta-chips">
            {pageType !== undefined && <span className="page-type-chip">{pageType}</span>}
            {currentStatus !== "" && (
              <span
                className={`page-status-badge${isTerminal ? " page-terminal-badge" : ""}${isDone ? " page-done-badge" : ""}`}
                title={
                  isDone
                    ? "Finished — still editable"
                    : isTerminal
                      ? "Terminal status — no further transitions"
                      : "Current status"
                }
              >
                {isDone && <span aria-hidden="true">✓ </span>}
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
                {studio !== null && (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={mode === studio}
                    className={`view-tab ${mode === studio ? "active" : ""}`}
                    onClick={() => selectView(studio)}
                  >
                    {STUDIO_LABEL[studio]}
                  </button>
                )}
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === "content"}
                  className={`view-tab ${mode === "content" ? "active" : ""}`}
                  onClick={() => selectView("content")}
                >
                  Content
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === "model"}
                  className={`view-tab ${mode === "model" ? "active" : ""}`}
                  onClick={() => selectView("model")}
                >
                  Model
                </button>
              </div>
            )}
          </div>
        </div>
        <div className="page-title-row">
          {titleDraft !== null ? (
            <input
              className="page-title page-title-input"
              value={titleDraft}
              autoFocus
              disabled={structural.pending}
              aria-label="Page title"
              title="Enter or click away to rename, Escape to cancel"
              onChange={(e) => setTitleDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void commitTitle();
                if (e.key === "Escape") setTitleDraft(null);
              }}
              onBlur={() => void commitTitle()}
            />
          ) : (
            headerTitle !== null && (
              <h1
                className="page-title"
                role="button"
                tabIndex={0}
                title="Click to rename"
                onClick={() => setTitleDraft(node?.title ?? headerTitle)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") setTitleDraft(node?.title ?? headerTitle);
                }}
              >
                {headerTitle}
              </h1>
            )
          )}
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
        </div>
      </header>
      {structural.error !== null && (
        <p className="page-archive-error" role="alert">
          {structural.error}
        </p>
      )}

      {mode === "model" && fsm !== null ? (
        <div className="model-view">
          <FsmGraph
            fsm={fsm}
            currentStatus={currentStatus}
            descriptors={descriptors}
            workspaceId={workspaceId}
            pageId={pageId}
          />
          {def !== null && <SchemaInspector def={def} currentStatus={currentStatus} />}
        </div>
      ) : mode === "restate" && studio === "restate" ? (
        <RestateStudio
          key={`${workspaceId}/${pageId}`}
          workspaceId={workspaceId}
          pageId={pageId}
          status={currentStatus}
          specMarkdown={markdown}
        />
      ) : mode === "study" && studio === "study" ? (
        <StudyStudio
          key={`${workspaceId}/${pageId}`}
          workspaceId={workspaceId}
          pageId={pageId}
          status={currentStatus}
          pageTitle={headerTitle}
          pageMarkdown={markdown}
        />
      ) : mode === "glossary" && studio === "glossary" ? (
        <GlossaryStudio
          key={`${workspaceId}/${pageId}`}
          workspaceId={workspaceId}
          pageId={pageId}
          status={currentStatus}
          pageTitle={headerTitle}
          pageMarkdown={markdown}
        />
      ) : mode === "article" && studio === "article" ? (
        <ArticleStudio
          key={`${workspaceId}/${pageId}`}
          workspaceId={workspaceId}
          pageId={pageId}
          status={currentStatus}
          pageMarkdown={markdown}
        />
      ) : mode === "recipe" && studio === "recipe" ? (
        <RecipeStudio
          key={`${workspaceId}/${pageId}`}
          workspaceId={workspaceId}
          pageId={pageId}
          pageTitle={headerTitle ?? ""}
          status={currentStatus}
          pageMarkdown={markdown}
        />
      ) : loading && markdown === null ? (
        <p className="muted">Loading page…</p>
      ) : (
        <>
          {contentsMode !== null && (
            <div className="contents-controls">
              <div className="mode-toggle" role="group" aria-label="How to show child pages">
                {[
                  { value: contentsMode.links, label: "List" },
                  { value: contentsMode.inline, label: "Feed" },
                ].map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    aria-pressed={inlined === (opt.value === contentsMode.inline)}
                    disabled={modeMutator.pending}
                    onClick={() => {
                      void modeMutator.run(contentsMode.command, { [contentsMode.arg]: opt.value });
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <button type="button" onClick={() => setAddChildOpen(true)}>
                + New page here
              </button>
              {modeMutator.error !== null && <span className="error">{modeMutator.error}</span>}
            </div>
          )}
          {addChildOpen && (
            <CreatePageModal
              workspaceId={workspaceId}
              initialParentId={pageId}
              onClose={() => setAddChildOpen(false)}
            />
          )}
          {/* eslint-disable-next-line react/no-danger */}
          <article
            ref={articleRef}
            className="markdown"
            data-page-id={contentPageId ?? undefined}
            onClick={onClick}
            dangerouslySetInnerHTML={{ __html: html }}
          />
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
