/**
 * Workspace aggregate reducer / event router.
 *
 * `foldWorkspace` rebuilds `IWorkspaceState` from an event sequence: it asserts
 * `version` contiguity (fail fast on a gap), skips events already covered by a
 * snapshot (`version <= from`), upcasts content-event payloads up to the page
 * type's current schema version, then folds each event via `applyWorkspace`.
 *
 * `applyWorkspace` owns ALL structural/workspace events directly and routes
 * content events to the owning page type's `apply`, writing the result back into
 * the node. Pure & total: no host clock / RNG (time + ids ride in the envelopes).
 */
import type {
  IEventEnvelope,
  IPageNode,
  ISection,
  IWorkspaceState,
  PageId,
  RootId,
  SectionId,
  SectionOpsAppliedPayload,
  PageState,
  WorkspaceId,
} from "../api";
import { ROOT } from "../api";
import { UnknownPageTypeError } from "./errors";
import { applyOps, materializeSectionFields } from "./operations";
import type { Registry } from "./registry";

// ────────────────────────────────────────────────────────────────────────────
// Structural / workspace event taxonomy
// ────────────────────────────────────────────────────────────────────────────

/** Event `type`s handled directly by `applyWorkspace` (never routed to a page). */
export const STRUCTURAL_EVENT_TYPES = [
  "WorkspaceCreated",
  "PageCreated",
  "PageReparented",
  "ChildrenReordered",
  "PageTitleSet",
  "PageArchived",
  "PageUnarchived",
  "LinkAdded",
  "LinkRemoved",
  "WorkspaceRenamed",
  "WorkspaceArchived",
  "WorkspaceUnarchived",
] as const;

/** The single engine content event type — its payload is an ordered `SectionOp[]`. */
export const SECTION_OPS_EVENT = "SectionOpsApplied" as const;

/** Union of the structural/workspace event type tags. */
export type StructuralEventType = (typeof STRUCTURAL_EVENT_TYPES)[number];

const STRUCTURAL_SET: ReadonlySet<string> = new Set<string>(STRUCTURAL_EVENT_TYPES);

/** Whether an event `type` is a structural/workspace event (vs. a routed content event). */
export function isStructuralEvent(type: string): type is StructuralEventType {
  return STRUCTURAL_SET.has(type);
}

// ────────────────────────────────────────────────────────────────────────────
// Structural payload shapes (loosely typed; envelopes are validated upstream)
// ────────────────────────────────────────────────────────────────────────────

interface WorkspaceCreatedPayload {
  readonly name: string;
}
interface WorkspaceRenamedPayload {
  readonly name: string;
}
interface PageCreatedPayload {
  readonly type: string;
  readonly parentId?: PageId | null;
  readonly title: string;
  readonly pinned?: boolean;
  /** Pre-minted ids for the required sections so the reducer stays id-free. */
  readonly requiredSectionIds?: Record<string, SectionId>;
  /** Engine-minted `serial` field values, keyed `section → field → value`. Computed at
   *  decide time from committed state (so the fold stays a pure replay), applied over the
   *  freshly materialized sections below. */
  readonly serials?: Record<string, Record<string, number>>;
}
interface PageReparentedPayload {
  readonly pageId: PageId;
  readonly oldParentId?: PageId | null;
  readonly newParentId: PageId | null;
  readonly position?: number;
}
interface ChildrenReorderedPayload {
  readonly parentId: PageId | null;
  readonly orderedChildIds: readonly PageId[];
}
interface PageTitleSetPayload {
  readonly pageId: PageId;
  readonly title: string;
}
interface PageArchivedPayload {
  readonly pageId: PageId;
}
interface LinkPayload {
  readonly from: PageId;
  readonly to: PageId;
  readonly role: string;
}

// ────────────────────────────────────────────────────────────────────────────
// PageState view (shared-reference window onto an IPageNode)
// ────────────────────────────────────────────────────────────────────────────

/**
 * A {@link PageState} window over a page node. `fields`/`items`/scalars alias the
 * SAME objects the node holds, so a page type's `apply` mutating the view mutates
 * the node. Routing writes any returned scalar/ref changes back onto the node.
 */
export function pageStateView(node: IPageNode): PageState {
  return {
    id: node.id,
    type: node.type,
    parentId: node.parentId,
    title: node.title,
    status: node.status,
    sections: node.sections,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  };
}

/** Copy any node-owned mutations from a PageState view back onto the node. */
function writeBack(node: IPageNode, view: PageState): void {
  node.parentId = view.parentId;
  node.title = view.title;
  node.status = view.status;
  node.sections = view.sections;
  node.updatedAt = view.updatedAt;
}

// ────────────────────────────────────────────────────────────────────────────
// Empty state from WorkspaceCreated
// ────────────────────────────────────────────────────────────────────────────

/**
 * Seed an empty active workspace from its `WorkspaceCreated` envelope. The
 * children map is initialised with an empty top-level (`@root`) bucket and
 * `version` is set to the creation event's version (0-based stream head + 1 once
 * folded — here it reflects having consumed exactly the creation event).
 */
export function emptyWorkspace(created: IEventEnvelope): IWorkspaceState {
  if (created.type !== "WorkspaceCreated") {
    throw new UnknownPageTypeError([created.type]);
  }
  const payload = (created.payload ?? {}) as WorkspaceCreatedPayload;
  const children = new Map<PageId | RootId, PageId[]>();
  children.set(ROOT, []);
  return {
    id: created.streamId as WorkspaceId,
    name: payload.name,
    status: "active",
    pages: new Map<PageId, IPageNode>(),
    children,
    links: [],
    retired: new Set<PageId>(),
    version: created.version + 1,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Upcasting
// ────────────────────────────────────────────────────────────────────────────

/**
 * Compose a content event's payload up to the page type's current schema version
 * by chaining the registered `upcasters` from `event.schemaVersion`. A
 * `schemaVersion` greater than the registered `version` is a hard error.
 */
function upcastPayload(
  registry: Registry,
  pageType: string,
  schemaVersion: number,
  payload: unknown,
): unknown {
  const def = registry.page(pageType);
  if (schemaVersion > def.version) {
    throw new UnknownPageTypeError([`${pageType}@${schemaVersion}`]);
  }
  let current = payload;
  const upcasters = def.upcasters ?? {};
  for (let v = schemaVersion; v < def.version; v++) {
    const step = upcasters[v];
    if (step !== undefined) current = step(current);
  }
  return current;
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function childList(state: IWorkspaceState, key: PageId | RootId): PageId[] {
  let list = state.children.get(key);
  if (list === undefined) {
    list = [];
    state.children.set(key, list);
  }
  return list;
}

function removeFromChildren(state: IWorkspaceState, key: PageId | RootId, id: PageId): void {
  const list = state.children.get(key);
  if (list === undefined) return;
  const idx = list.indexOf(id);
  if (idx !== -1) list.splice(idx, 1);
}

function requireNode(state: IWorkspaceState, id: PageId): IPageNode {
  const node = state.pages.get(id);
  if (node === undefined) throw new UnknownPageTypeError([`page:${id}`]);
  return node;
}

/**
 * A page type the registry NO LONGER declares, in a LOADED registry (≥1 type), is RETIRED:
 * its instances fold as ABSENT (skipped), so removing a page type can never brick a
 * workspace whose history still holds that type's events. An unknown type in an EMPTY
 * registry is "models not loaded yet" (the boot race) — the caller throws so the projection
 * halts and retries once the bundles land, rather than silently dropping every page.
 */
function isRetiredType(registry: Registry, type: string): boolean {
  return registry.types().length > 0 && !registry.has(type);
}

// ────────────────────────────────────────────────────────────────────────────
// applyWorkspace — the router
// ────────────────────────────────────────────────────────────────────────────

/**
 * Fold one envelope into `state` (mutating in place) and return it. Structural
 * events are handled here; content events are upcast and routed to the owning
 * page type's `apply`. Unknown page/event types → {@link UnknownPageTypeError}.
 *
 * `skipped` accumulates the ids of pages whose type was RETIRED (see {@link isRetiredType});
 * every later event targeting such a page is folded as a no-op. It defaults to (and is
 * normally) `state.retired`, so the set persists across a full fold AND incremental tail
 * applies — a content event arriving later for a retired page still skips.
 */
export function applyWorkspace(
  state: IWorkspaceState,
  event: IEventEnvelope,
  registry: Registry,
  skipped: Set<PageId> = state.retired ?? new Set(),
): IWorkspaceState {
  if (isStructuralEvent(event.type)) {
    return applyStructural(state, event, registry, skipped);
  }
  return applyContent(state, event, registry, skipped);
}

function applyStructural(
  state: IWorkspaceState,
  event: IEventEnvelope,
  registry: Registry,
  skipped: Set<PageId>,
): IWorkspaceState {
  switch (event.type as StructuralEventType) {
    case "WorkspaceCreated": {
      // Re-asserting creation on an already-seeded state is a no-op for the name.
      const p = (event.payload ?? {}) as WorkspaceCreatedPayload;
      state.name = p.name;
      state.status = "active";
      if (!state.children.has(ROOT)) state.children.set(ROOT, []);
      return state;
    }

    case "PageCreated": {
      const p = event.payload as PageCreatedPayload;
      const id = event.pageId as PageId;
      if (!registry.has(p.type)) {
        // Retired type → fold the page as absent (and remember it, so its later content/
        // structural events skip too). An unknown type in an empty registry throws (boot race).
        if (isRetiredType(registry, p.type)) {
          skipped.add(id);
          return state;
        }
        throw new UnknownPageTypeError([p.type]);
      }
      const def = registry.page(p.type);
      const parentKey: PageId | RootId = p.parentId ?? ROOT;

      // Auto-materialize required sections empty, keyed by declared key, with
      // pre-minted ids from the event payload so the reducer stays id-free.
      const sections: ISection[] = [];
      const required = registry.requiredSectionsOf(p.type);
      required.forEach((req, idx) => {
        const sectionId =
          (p.requiredSectionIds?.[req.key] ?? (`sec:${id}:${req.key}` as SectionId)) as SectionId;
        const section: ISection = {
          id: sectionId,
          key: req.key,
          name: req.decl.name,
          ...(req.decl.description !== undefined ? { description: req.decl.description } : {}),
          order: idx,
          parentId: null,
          fields: {},
        };
        materializeSectionFields(section, req.decl);
        sections.push(section);
      });

      // Overwrite engine-assigned `serial` placeholders with their minted values.
      if (p.serials !== undefined) {
        for (const sec of sections) {
          const fieldVals = p.serials[sec.key];
          if (fieldVals === undefined) continue;
          for (const [fk, val] of Object.entries(fieldVals)) {
            sec.fields[fk] = { kind: "scalar", value: val };
          }
        }
      }

      const node: IPageNode = {
        id,
        type: p.type,
        parentId: p.parentId ?? null,
        title: p.title,
        status: def.initialStatus,
        sections,
        pinned: p.pinned === true ? true : undefined,
        createdAt: event.meta.occurredAt,
        updatedAt: event.meta.occurredAt,
      };
      state.pages.set(id, node);
      const siblings = childList(state, parentKey);
      if (!siblings.includes(id)) siblings.push(id);
      return state;
    }

    case "PageReparented": {
      const p = event.payload as PageReparentedPayload;
      if (skipped.has(p.pageId)) return state;
      const node = requireNode(state, p.pageId);
      const oldKey: PageId | RootId = node.parentId ?? ROOT;
      removeFromChildren(state, oldKey, p.pageId);
      node.parentId = p.newParentId;
      node.updatedAt = event.meta.occurredAt;
      const newKey: PageId | RootId = p.newParentId ?? ROOT;
      const siblings = childList(state, newKey);
      const filtered = siblings.filter((c) => c !== p.pageId);
      if (p.position !== undefined && p.position >= 0 && p.position <= filtered.length) {
        filtered.splice(p.position, 0, p.pageId);
      } else {
        filtered.push(p.pageId);
      }
      state.children.set(newKey, filtered);
      return state;
    }

    case "ChildrenReordered": {
      const p = event.payload as ChildrenReorderedPayload;
      const key: PageId | RootId = p.parentId ?? ROOT;
      if (key !== ROOT && skipped.has(key)) return state;
      // Drop any retired-page ids from the order so they don't linger as dangling children.
      state.children.set(key, p.orderedChildIds.filter((c) => !skipped.has(c)));
      return state;
    }

    case "PageTitleSet": {
      const p = event.payload as PageTitleSetPayload;
      if (skipped.has(p.pageId)) return state;
      const node = requireNode(state, p.pageId);
      node.title = p.title;
      node.updatedAt = event.meta.occurredAt;
      return state;
    }

    case "PageArchived": {
      const p = event.payload as PageArchivedPayload;
      if (skipped.has(p.pageId)) return state;
      const node = requireNode(state, p.pageId);
      node.archived = true;
      node.updatedAt = event.meta.occurredAt;
      return state;
    }

    case "PageUnarchived": {
      const p = event.payload as PageArchivedPayload;
      if (skipped.has(p.pageId)) return state;
      const node = requireNode(state, p.pageId);
      node.archived = undefined;
      node.updatedAt = event.meta.occurredAt;
      return state;
    }

    case "LinkAdded": {
      const p = event.payload as LinkPayload;
      if (skipped.has(p.from) || skipped.has(p.to)) return state;
      const exists = state.links.some(
        (l) => l.from === p.from && l.to === p.to && l.role === p.role,
      );
      if (!exists) state.links.push({ from: p.from, to: p.to, role: p.role });
      return state;
    }

    case "LinkRemoved": {
      const p = event.payload as LinkPayload;
      if (skipped.has(p.from) || skipped.has(p.to)) return state;
      state.links = state.links.filter(
        (l) => !(l.from === p.from && l.to === p.to && l.role === p.role),
      );
      return state;
    }

    case "WorkspaceRenamed": {
      const p = event.payload as WorkspaceRenamedPayload;
      state.name = p.name;
      return state;
    }

    case "WorkspaceArchived": {
      state.status = "archived";
      return state;
    }

    case "WorkspaceUnarchived": {
      state.status = "active";
      return state;
    }

    default: {
      // Exhaustiveness guard — should be unreachable given isStructuralEvent().
      throw new UnknownPageTypeError([event.type]);
    }
  }
}

function applyContent(
  state: IWorkspaceState,
  event: IEventEnvelope,
  registry: Registry,
  skipped: Set<PageId>,
): IWorkspaceState {
  const pageId = event.pageId;
  if (pageId === undefined) {
    // A non-structural event must target a page to be routable.
    throw new UnknownPageTypeError([event.type]);
  }
  // A content event for a retired-type page (its creation was skipped) folds as a no-op.
  if (skipped.has(pageId)) return state;
  if (event.type !== SECTION_OPS_EVENT) {
    throw new UnknownPageTypeError([event.type]);
  }
  const node = state.pages.get(pageId);
  if (node === undefined) throw new UnknownPageTypeError([`page:${pageId}`]);

  const def = registry.page(node.type);
  const upcasted = upcastPayload(registry, node.type, event.schemaVersion, event.payload) as SectionOpsAppliedPayload;
  const view = pageStateView(node);
  applyOps(view, upcasted.ops, {
    now: event.meta.occurredAt,
    def,
    pageNext: (status, ev) => registry.pageGuard(node.type).next(status, ev),
    elementNext: (elType, status, ev) => registry.elementGuard(node.type, elType)?.next(status, ev),
  });
  writeBack(node, view);
  return state;
}

// ────────────────────────────────────────────────────────────────────────────
// foldWorkspace — the entry point
// ────────────────────────────────────────────────────────────────────────────

/**
 * Fold an event sequence into workspace state. With no `from` snapshot,
 * `events[0]` must be `WorkspaceCreated`. Asserts `version` contiguity (throws on
 * a gap) but SKIPS any event with `version <= fromVersion` so a coarse-cursor
 * snapshot read stays idempotent. Returns the folded state.
 *
 * @param from optional snapshot state to fold the tail onto.
 * @param fromVersion the workspace version a `from` snapshot already covers; events
 *   with `version <= fromVersion` are skipped (defaults to -1 = consume all).
 */
export function foldWorkspace(
  events: readonly IEventEnvelope[],
  registry: Registry,
  from?: { state: IWorkspaceState; fromVersion: number },
): IWorkspaceState {
  let state: IWorkspaceState | undefined = from?.state;
  // A snapshot deserialized by an older build may predate `retired`; the skip set must
  // be a single accumulating instance, so materialize it before any apply.
  if (state !== undefined && (state.retired as Set<PageId> | undefined) === undefined) {
    state.retired = new Set<PageId>();
  }
  const fromVersion = from?.fromVersion ?? -1;

  let lastVersion = state !== undefined ? state.version - 1 : -1;
  let seeded = state !== undefined;

  for (const event of events) {
    // Snapshot skip: events already baked into the `from` state.
    if (event.version <= fromVersion) {
      lastVersion = event.version;
      continue;
    }

    if (!seeded) {
      // First consumed event must be the workspace creation.
      state = emptyWorkspace(event);
      lastVersion = event.version;
      seeded = true;
      continue;
    }

    // Contiguity: each consumed event's version must be exactly one past the last.
    if (event.version !== lastVersion + 1) {
      throw new RangeError(
        `Non-contiguous workspace history: expected version ${lastVersion + 1}, saw ${event.version}.`,
      );
    }

    // Retired-page skips accumulate on `state.retired` (the applyWorkspace default), so
    // a retired page's later content/structural events skip across the whole history.
    state = applyWorkspace(state as IWorkspaceState, event, registry);
    (state as IWorkspaceState).version = event.version + 1;
    lastVersion = event.version;
  }

  if (state === undefined) {
    throw new UnknownPageTypeError(["<empty history: missing WorkspaceCreated>"]);
  }
  return state;
}
