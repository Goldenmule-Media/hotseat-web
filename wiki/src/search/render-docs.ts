/**
 * Render a workspace's pages into {@link SearchDoc}s — the indexed document per page is
 * its deterministic `renderPage` Markdown (the same bytes a reader sees), so search is
 * schema-agnostic: it never inspects a concrete page type, only its rendered text.
 *
 * Two granularities: {@link renderSearchDocs} renders the WHOLE workspace (initial index /
 * catch-up), {@link renderAffectedDocs} renders only the pages a commit could have changed
 * (the steady-state delta), with {@link affectedPageIds} computing that set from the
 * commit's new events. Both produce the same per-page {@link SearchDoc} via the shared
 * {@link renderDoc}.
 */
import type { IEventEnvelope, IPageNode, IWorkspaceState, PageId } from "../api";
import type { Registry } from "../core/registry";
import { SECTION_OPS_EVENT, type StructuralEventType } from "../core/workspace";
import { renderPage } from "../render/read-model";
import type { SearchDoc } from "./schema";

/** Optional render-side hooks threaded through the doc builders (engine-internal plumbing). */
export interface RenderOpts {
  /** Best-effort signal that a page failed to render (it is indexed with an empty body). */
  readonly onRenderError?: (pageId: string, err: unknown) => void;
}

/** Build one {@link SearchDoc} for `node` (its rendered Markdown body). */
function renderDoc(state: IWorkspaceState, node: IPageNode, registry: Registry, opts?: RenderOpts): SearchDoc {
  let body: string;
  try {
    body = renderPage(state, node.id, registry);
  } catch (err) {
    // A render failure must not break indexing — index an empty body; the title is also the
    // render's H1, so a failed render drops it from search until the next successful index.
    // Surface it via the optional hook, itself guarded so a throwing hook can never abort the
    // synchronous render snapshot (and thus the write that drives it).
    try {
      opts?.onRenderError?.(node.id, err);
    } catch {
      /* observation hook must never break indexing */
    }
    body = "";
  }
  return {
    pageId: node.id,
    type: node.type,
    status: node.status,
    archived: node.archived === true,
    title: node.title,
    body,
    version: state.version,
  };
}

/** Build one {@link SearchDoc} per live page in `state` (the whole-workspace render). */
export function renderSearchDocs(state: IWorkspaceState, registry: Registry, opts?: RenderOpts): SearchDoc[] {
  const docs: SearchDoc[] = [];
  for (const node of state.pages.values()) docs.push(renderDoc(state, node, registry, opts));
  return docs;
}

/** Build a {@link SearchDoc} for each affected page that still exists (skips removed ids). */
export function renderAffectedDocs(
  state: IWorkspaceState,
  affected: Iterable<PageId>,
  registry: Registry,
  opts?: RenderOpts,
): SearchDoc[] {
  const docs: SearchDoc[] = [];
  for (const id of affected) {
    const node = state.pages.get(id);
    if (node !== undefined) docs.push(renderDoc(state, node, registry, opts));
  }
  return docs;
}

/** Add `value` to `set` when it is a real page id (string), ignoring ROOT / null parents. */
function addPageId(set: Set<PageId>, value: unknown): void {
  if (typeof value === "string" && value.length > 0) set.add(value as PageId);
}

/**
 * The pages whose rendered Markdown a commit's `newEvents` could have changed — the set
 * to re-render. A page's render embeds the TITLES of its children (child list) and its
 * outgoing-link targets (references), so a STRUCTURAL or title change ripples to those
 * render-dependents: for each directly-touched page we also re-render its parent (whose
 * child list shows it) and any page that links to it (whose references show it).
 *
 * Pure content edits (no title/structure change) ripple to nobody, so they stay O(1):
 * only the edited page is returned. The one residual is a cross-page REF label pointing
 * at an element of an edited page — that self-heals when the referring page is next
 * touched, an acceptable lag for a best-effort search index.
 */
export function affectedPageIds(
  newEvents: readonly IEventEnvelope[],
  state: IWorkspaceState,
): Set<PageId> {
  const touched = new Set<PageId>();
  let structural = false; // any event that can change a page's title / place in a list
  for (const ev of newEvents) {
    addPageId(touched, ev.pageId);
    // The single content event ripples to nobody (O(1)): only the edited page re-renders.
    if (ev.type === SECTION_OPS_EVENT) continue;
    const p = (ev.payload ?? {}) as Record<string, unknown>;
    // Bind a union-typed local so the `default` arm narrows to `never` — adding a new
    // structural event type to the engine taxonomy then fails THIS typecheck (forcing it to
    // be classified here) instead of silently under-indexing render-dependents.
    const t = ev.type as StructuralEventType;
    switch (t) {
      case "PageReparented":
        addPageId(touched, p["oldParentId"]);
        addPageId(touched, p["newParentId"]);
        structural = true;
        break;
      case "ChildrenReordered":
        addPageId(touched, p["parentId"]);
        structural = true;
        break;
      case "PageCreated":
      case "PageTitleSet":
      case "PageArchived":
      case "PageUnarchived":
        structural = true;
        break;
      case "LinkAdded":
      case "LinkRemoved":
        // A link change ripples only to its endpoints (the `from` page's references section
        // embeds the target's title) — NOT to parents/backlinkers, so it is NOT structural.
        addPageId(touched, p["from"]);
        addPageId(touched, p["to"]);
        break;
      case "WorkspaceCreated":
      case "WorkspaceArchived":
      case "WorkspaceUnarchived":
        break; // workspace-level events have no page render impact
      default: {
        const _exhaustive: never = t; // a new structural type lands here → TS2322
        void _exhaustive;
        break;
      }
    }
  }
  if (!structural) return touched;

  const result = new Set<PageId>(touched);
  for (const id of touched) {
    const node = state.pages.get(id);
    // The parent's child list shows this page (its title / presence / order).
    if (node?.parentId != null && state.pages.has(node.parentId as PageId)) {
      result.add(node.parentId as PageId);
    }
    // Any page linking TO this one shows its title in their references section.
    for (const l of state.links) if (l.to === id) result.add(l.from);
  }
  return result;
}

/**
 * Does a commit's `newEvents` change any page's TITLE, EXISTENCE, archived flag, or place in
 * the tree — i.e. can it move a page's position in the rendered tree? Mirrors the `structural`
 * classification inside {@link affectedPageIds} (same exhaustive `StructuralEventType` switch,
 * so a new structural event type fails the `never` check until it is classified here too).
 *
 * Doc-only consumers (the search index) don't need this — `affectedPageIds` already ripples a
 * title/structure change to its render-dependents. But a consumer that maps the tree onto a
 * filesystem PATH (the Markdown-disk mirror) does: a structural commit can move a whole
 * subtree's paths, far beyond the directly-touched pages, so such a sink rebuilds wholesale.
 */
export function isStructuralCommit(newEvents: readonly IEventEnvelope[]): boolean {
  for (const ev of newEvents) {
    if (ev.type === SECTION_OPS_EVENT) continue; // the lone content event — never structural
    const t = ev.type as StructuralEventType;
    switch (t) {
      case "PageReparented":
      case "ChildrenReordered":
      case "PageCreated":
      case "PageTitleSet":
      case "PageArchived":
      case "PageUnarchived":
        return true;
      case "LinkAdded":
      case "LinkRemoved":
      case "WorkspaceCreated":
      case "WorkspaceArchived":
      case "WorkspaceUnarchived":
        break; // no effect on a page's title / existence / tree position
      default: {
        const _exhaustive: never = t; // a new structural type lands here → TS2322
        void _exhaustive;
        break;
      }
    }
  }
  return false;
}
