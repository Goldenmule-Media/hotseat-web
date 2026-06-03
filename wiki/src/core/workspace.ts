/**
 * Workspace aggregate reducer / event router (DESIGN §6.2, §8.2, §8.5; BUILD_NOTES §2).
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
// Structural / workspace event taxonomy (BUILD_NOTES §2)
// ────────────────────────────────────────────────────────────────────────────

/** Event `type`s handled directly by `applyWorkspace` (never routed to a page). */
export const STRUCTURAL_EVENT_TYPES = [
  "WorkspaceCreated",
  "PageCreated",
  "PageReparented",
  "ChildrenReordered",
  "PageTitleSet",
  "PageArchived",
  "LinkAdded",
  "LinkRemoved",
  "WorkspaceArchived",
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
interface PageCreatedPayload {
  readonly type: string;
  readonly parentId?: PageId | null;
  readonly title: string;
  readonly pinned?: boolean;
  /** Pre-minted ids for the required sections so the reducer stays id-free (§2.4). */
  readonly requiredSectionIds?: Record<string, SectionId>;
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
    version: created.version + 1,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Upcasting (DESIGN §8.5)
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

// ────────────────────────────────────────────────────────────────────────────
// applyWorkspace — the router
// ────────────────────────────────────────────────────────────────────────────

/**
 * Fold one envelope into `state` (mutating in place) and return it. Structural
 * events are handled here; content events are upcast and routed to the owning
 * page type's `apply`. Unknown page/event types → {@link UnknownPageTypeError}.
 */
export function applyWorkspace(
  state: IWorkspaceState,
  event: IEventEnvelope,
  registry: Registry,
): IWorkspaceState {
  if (isStructuralEvent(event.type)) {
    return applyStructural(state, event, registry);
  }
  return applyContent(state, event, registry);
}

function applyStructural(
  state: IWorkspaceState,
  event: IEventEnvelope,
  registry: Registry,
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
      const def = registry.page(p.type);
      const parentKey: PageId | RootId = p.parentId ?? ROOT;

      // Auto-materialize required sections empty, keyed by declared key (§6), with
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
      state.children.set(key, [...p.orderedChildIds]);
      return state;
    }

    case "PageTitleSet": {
      const p = event.payload as PageTitleSetPayload;
      const node = requireNode(state, p.pageId);
      node.title = p.title;
      node.updatedAt = event.meta.occurredAt;
      return state;
    }

    case "PageArchived": {
      const p = event.payload as PageArchivedPayload;
      const node = requireNode(state, p.pageId);
      node.status = "archived";
      node.updatedAt = event.meta.occurredAt;
      return state;
    }

    case "LinkAdded": {
      const p = event.payload as LinkPayload;
      const exists = state.links.some(
        (l) => l.from === p.from && l.to === p.to && l.role === p.role,
      );
      if (!exists) state.links.push({ from: p.from, to: p.to, role: p.role });
      return state;
    }

    case "LinkRemoved": {
      const p = event.payload as LinkPayload;
      state.links = state.links.filter(
        (l) => !(l.from === p.from && l.to === p.to && l.role === p.role),
      );
      return state;
    }

    case "WorkspaceArchived": {
      state.status = "archived";
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
): IWorkspaceState {
  const pageId = event.pageId;
  if (pageId === undefined) {
    // A non-structural event must target a page to be routable.
    throw new UnknownPageTypeError([event.type]);
  }
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
 * snapshot read stays idempotent (DESIGN §8.3). Returns the folded state.
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

    state = applyWorkspace(state as IWorkspaceState, event, registry);
    (state as IWorkspaceState).version = event.version + 1;
    lastVersion = event.version;
  }

  if (state === undefined) {
    throw new UnknownPageTypeError(["<empty history: missing WorkspaceCreated>"]);
  }
  return state;
}
