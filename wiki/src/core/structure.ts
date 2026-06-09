/**
 * Structural command handlers + invariants.
 *
 * Each handler is a PURE function over the current workspace `state`, the parsed
 * `args`, the injected `services` (clock + id generation), and the `registry`.
 * It returns the lightweight `DomainEvent`s the command bus will envelope into a
 * single atomic commit, plus an optional `result`. No I/O, no host clock/RNG —
 * time and ids arrive exclusively via `services.now()` / `services.newId()`.
 *
 * The bus is responsible for the "workspace active?" check before invoking a
 * handler; these handlers enforce the structural invariants themselves and
 * additionally reject mutating an archived target page (reads are unaffected).
 */
import {
  ROOT,
  type DomainEvent,
  type IField,
  type IItem,
  type IPageNode,
  type IPageTypeDef,
  type IWorkspaceState,
  type PageId,
  type RootId,
  type SectionOp,
} from "../api";
import {
  CycleError,
  DuplicateRequiredChildError,
  DuplicateTitleError,
  InvariantViolationError,
  ItemNotFoundError,
  LinkTargetNotFoundError,
  PageNotFoundError,
  ParentNotFoundError,
} from "./errors";
import { SECTION_OPS_EVENT } from "./workspace";
import { titleCase } from "./labels";
import type { Registry } from "./registry";
import type { Services } from "./types";

// ────────────────────────────────────────────────────────────────────────────
// Local types
// ────────────────────────────────────────────────────────────────────────────

/** The parent key used in `state.children`: a page id or the ROOT sentinel. */
type ParentKey = PageId | RootId;

/** A pure structural command handler. */
export type StructureHandler = (
  state: IWorkspaceState,
  args: any,
  services: Services,
  registry: Registry,
) => { events: DomainEvent[]; result?: unknown };

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

/** Normalize a nullable parent id to the children-map key. */
function parentKey(parentId: PageId | null | undefined): ParentKey {
  return parentId == null ? ROOT : parentId;
}

/** Ordered child ids under `parentId` (or ROOT), as a fresh array. */
function childrenOf(state: IWorkspaceState, parentId: PageId | null | undefined): PageId[] {
  return [...(state.children.get(parentKey(parentId)) ?? [])];
}

/** Resolve a page node or throw {@link PageNotFoundError}. */
function requirePage(state: IWorkspaceState, pageId: PageId): IPageNode {
  const node = state.pages.get(pageId);
  if (node === undefined) throw new PageNotFoundError(pageId);
  return node;
}

/** Reject mutating an archived target page. */
function assertPageActive(node: IPageNode): void {
  if (node.archived === true) {
    throw new InvariantViolationError(`Page "${node.id}" is archived; structural mutation is blocked.`);
  }
}

/** The `(section, field)` pairs declared `kind: "serial"` on a page type (top-level sections). */
function serialFieldsOf(def: IPageTypeDef): { section: string; field: string }[] {
  const out: { section: string; field: string }[] = [];
  for (const [section, sd] of Object.entries(def.sections)) {
    for (const [field, fd] of Object.entries(sd.fields)) {
      if (fd.kind === "serial") out.push({ section, field });
    }
  }
  return out;
}

/** A page's current `(section, field)` serial value, or 0 when unset/absent (the placeholder). */
function serialValueOf(node: IPageNode, section: string, field: string): number {
  const f = node.sections.find((s) => s.key === section)?.fields[field];
  return f !== undefined && f.kind === "scalar" && typeof f.value === "number" ? f.value : 0;
}

/** The highest assigned value of `(type, section, field)` across the workspace (0 if none). */
function maxSerial(state: IWorkspaceState, type: string, section: string, field: string): number {
  let max = 0;
  for (const node of state.pages.values()) {
    if (node.type !== type) continue;
    const v = serialValueOf(node, section, field);
    if (v > max) max = v;
  }
  return max;
}

/**
 * Mint the `serial` field values for a newly created page of `type`: for each field
 * declared `kind: "serial"`, the next number is `max(existing) + 1`, scoped to pages of the
 * SAME TYPE in this workspace (archived pages included, so numbers are never reused), starting
 * at 1. Reads only committed state, so it is deterministic at decide time; the OCC rebase
 * re-runs the create decision against fresh state, so concurrent creates can't collide. Returns
 * a `section → field → value` map, or `undefined` when the type declares no serial fields.
 */
function mintSerials(
  state: IWorkspaceState,
  type: string,
  registry: Registry,
): Record<string, Record<string, number>> | undefined {
  const fields = serialFieldsOf(registry.page(type));
  if (fields.length === 0) return undefined;
  const serials: Record<string, Record<string, number>> = {};
  for (const { section, field } of fields) {
    (serials[section] ??= {})[field] = maxSerial(state, type, section, field) + 1;
  }
  return serials;
}

/**
 * Reject a duplicate title among the siblings under `parentId`, ignoring the
 * page identified by `excludeId` (used by reparent/setPageTitle on the page
 * itself). Comparison is exact-match on the denormalized node title.
 */
function assertUniqueSiblingTitle(
  state: IWorkspaceState,
  parentId: PageId | null,
  title: string,
  excludeId?: PageId,
): void {
  for (const childId of childrenOf(state, parentId)) {
    if (childId === excludeId) continue;
    const child = state.pages.get(childId);
    if (child !== undefined && child.title === title) {
      throw new DuplicateTitleError(parentId, title, child.id, child.archived === true);
    }
  }
}

/** Is `candidate` `pageId` itself or a descendant of `pageId` in the tree? */
function isSelfOrDescendant(state: IWorkspaceState, pageId: PageId, candidate: PageId): boolean {
  if (candidate === pageId) return true;
  // BFS/DFS over the subtree rooted at pageId.
  const stack: PageId[] = childrenOf(state, pageId);
  const seen = new Set<PageId>();
  while (stack.length > 0) {
    const cur = stack.pop() as PageId;
    if (cur === candidate) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const grand of childrenOf(state, cur)) stack.push(grand);
  }
  return false;
}

// ────────────────────────────────────────────────────────────────────────────
// createPage
// ────────────────────────────────────────────────────────────────────────────

/**
 * Create a page (+ its required children, recursively, as pinned children) in
 * ONE atomic commit. Generates `pageId = `${type}:${newId()}``. Result is the
 * top-level page's id.
 */
export const createPage: StructureHandler = (state, args, services, registry) => {
  const { type, title, parentId } = args as {
    type: string;
    title: string;
    parentId: PageId | null;
  };
  const normalizedParent: PageId | null = parentId ?? null;

  // The registry must know the type (also throws UnknownPageTypeError on miss).
  if (!registry.has(type)) {
    throw new InvariantViolationError(`Unknown page type "${type}".`);
  }

  // Parent (when present) must exist and not be archived.
  if (normalizedParent !== null) {
    const parent = requirePage(state, normalizedParent);
    if (parent.archived === true) {
      throw new ParentNotFoundError(normalizedParent);
    }
    // Reject re-creating one of the parent type's auto-materialized required children: those are
    // spawned (pinned) in the parent's own create commit, so a manual second one is an unmanaged
    // duplicate. Catch it HERE (at the second create) rather than letting the duplicate linger.
    const parentDef = registry.page(parent.type);
    if ((parentDef.requiredChildren ?? []).includes(type)) {
      // Only an ACTIVE same-typed child blocks: an archived one no longer satisfies the
      // parent's required-child contract, so re-creating is legitimate recovery (and the
      // "author into that page" guidance would be wrong for an archived, unmutatable page).
      const existing = childrenOf(state, normalizedParent)
        .map((cid) => state.pages.get(cid))
        .find((c) => c !== undefined && c.type === type && c.archived !== true);
      if (existing !== undefined) {
        throw new DuplicateRequiredChildError(normalizedParent, type, existing.id);
      }
    }
  }

  // Unique sibling title under the parent.
  assertUniqueSiblingTitle(state, normalizedParent, title);

  const events: DomainEvent[] = [];

  /**
   * Emit a `PageCreated` for `pageType` under `parent`, then recurse into its
   * required children (pinned). Returns the created page id.
   */
  const emitPage = (
    pageType: string,
    pageTitle: string,
    parent: PageId | null,
    pinned: boolean,
  ): PageId => {
    // Resolve the def (throws UnknownPageTypeError on an unregistered required child).
    const def = registry.page(pageType);
    const id = `${pageType}:${services.newId()}` as PageId;
    const serials = mintSerials(state, pageType, registry);

    events.push({
      type: "PageCreated",
      pageId: id,
      payload: {
        type: pageType,
        parentId: parent,
        title: pageTitle,
        ...(pinned ? { pinned: true } : {}),
        ...(serials !== undefined ? { serials } : {}),
      },
    });

    // Required children are created atomically as pinned children, recursively. Each gets a
    // FRIENDLY default title derived from its parent: the child def's `label` (else a title-cased
    // type id) suffixed with the parent's title — e.g. "Implementation plan — App Shell" rather
    // than a bare "Implementation plan". This keeps the child recognizable in the global tree /
    // search / rendered H1 and makes it read as a real page, not a placeholder. Deterministic
    // (parent title is known at decide time); no page-type knowledge in the engine.
    for (const childType of def.requiredChildren ?? []) {
      const childDef = registry.page(childType);
      const childLabel = childDef.label ?? titleCase(childType);
      emitPage(childType, `${childLabel} — ${pageTitle}`, id, true);
    }
    return id;
  };

  const topId = emitPage(type, title, normalizedParent, false);
  return { events, result: topId };
};

// ────────────────────────────────────────────────────────────────────────────
// reparent
// ────────────────────────────────────────────────────────────────────────────

/**
 * Move `pageId` under `newParentId` (or ROOT). Rejects cycles, missing parents,
 * and moving a pinned page out of its current owner. Emits `PageReparented`
 * plus a `ChildrenReordered` (to insert at `position`) when needed.
 */
export const reparent: StructureHandler = (state, args) => {
  const { pageId, newParentId, position } = args as {
    pageId: PageId;
    newParentId: PageId | null;
    position?: number;
  };
  const newParent: PageId | null = newParentId ?? null;

  const node = requirePage(state, pageId);
  assertPageActive(node);

  // Pinned pages cannot be reparented out of their owner.
  if (node.pinned === true && node.parentId !== newParent) {
    throw new InvariantViolationError(`Page "${pageId}" is pinned and cannot be reparented out of its owner.`);
  }

  // New parent (when present) must exist and not be archived.
  if (newParent !== null) {
    const parent = state.pages.get(newParent);
    if (parent === undefined || parent.archived === true) {
      throw new ParentNotFoundError(newParent);
    }
    // Cycle: newParent must not be the page itself or a descendant of it.
    if (isSelfOrDescendant(state, pageId, newParent)) {
      throw new CycleError(pageId, newParent);
    }
  }

  const oldParent: PageId | null = node.parentId;

  const events: DomainEvent[] = [
    {
      type: "PageReparented",
      pageId,
      payload: {
        pageId,
        oldParentId: oldParent,
        newParentId: newParent,
        ...(position !== undefined ? { position } : {}),
      },
    },
  ];

  // If a position was requested, emit the resulting sibling order explicitly so
  // the reducer doesn't have to guess. Compute the order after the move.
  if (position !== undefined) {
    const siblings = childrenOf(state, newParent).filter((id) => id !== pageId);
    const clamped = Math.max(0, Math.min(position, siblings.length));
    siblings.splice(clamped, 0, pageId);
    events.push({
      type: "ChildrenReordered",
      payload: { parentId: newParent, orderedChildIds: siblings },
    });
  }

  return { events };
};

// ────────────────────────────────────────────────────────────────────────────
// reorder
// ────────────────────────────────────────────────────────────────────────────

/**
 * Reorder the children under `parentId` (or ROOT). The supplied ids must be a
 * permutation of the current children (same membership, no dupes, no extras).
 */
export const reorder: StructureHandler = (state, args) => {
  const { parentId, orderedChildIds } = args as {
    parentId: PageId | null;
    orderedChildIds: readonly PageId[];
  };
  const normalizedParent: PageId | null = parentId ?? null;

  const current = childrenOf(state, normalizedParent);
  const next = [...orderedChildIds];

  const dupeCheck = new Set<PageId>();
  for (const id of next) {
    if (dupeCheck.has(id)) {
      throw new InvariantViolationError(`reorder list contains a duplicate child "${id}".`);
    }
    dupeCheck.add(id);
  }

  const currentSet = new Set(current);
  if (next.length !== current.length || next.some((id) => !currentSet.has(id))) {
    throw new InvariantViolationError(
      `reorder must be a permutation of the current children under "${normalizedParent ?? ROOT}".`,
    );
  }

  return {
    events: [
      {
        type: "ChildrenReordered",
        payload: { parentId: normalizedParent, orderedChildIds: next },
      },
    ],
  };
};

// ────────────────────────────────────────────────────────────────────────────
// setPageTitle
// ────────────────────────────────────────────────────────────────────────────

/** Rename a page; the new title must be unique among its siblings. */
export const setPageTitle: StructureHandler = (state, args) => {
  const { pageId, title } = args as { pageId: PageId; title: string };

  const node = requirePage(state, pageId);
  assertPageActive(node);
  assertUniqueSiblingTitle(state, node.parentId, title, pageId);

  return {
    events: [{ type: "PageTitleSet", pageId, payload: { pageId, title } }],
  };
};

// ────────────────────────────────────────────────────────────────────────────
// archivePage / unarchivePage
// ────────────────────────────────────────────────────────────────────────────

/**
 * Archive a page — hide it from default views. Sets an orthogonal `archived` flag;
 * the page's lifecycle `status` is preserved. Pinned pages cannot be archived alone
 * (archive their owner instead). Idempotent: a no-op on an already-archived page.
 */
export const archivePage: StructureHandler = (state, args) => {
  const { pageId } = args as { pageId: PageId };

  const node = requirePage(state, pageId);
  if (node.archived === true) return { events: [] };
  if (node.pinned === true) {
    throw new InvariantViolationError(`Page "${pageId}" is pinned and cannot be archived independently.`);
  }

  return {
    events: [{ type: "PageArchived", pageId, payload: { pageId } }],
  };
};

/**
 * Unarchive a page — restore it to default views. The lifecycle `status` was never
 * touched by archiving, so the page becomes visible (and mutable) again at the status
 * it held. Idempotent: a no-op on a page that is not archived.
 */
export const unarchivePage: StructureHandler = (state, args) => {
  const { pageId } = args as { pageId: PageId };

  const node = requirePage(state, pageId);
  if (node.archived !== true) return { events: [] };

  return {
    events: [{ type: "PageUnarchived", pageId, payload: { pageId } }],
  };
};

// ────────────────────────────────────────────────────────────────────────────
// link / unlink
// ────────────────────────────────────────────────────────────────────────────

/** Add a graph edge `from -[role]-> to`. Both endpoints must exist. */
export const link: StructureHandler = (state, args) => {
  const { from, to, role } = args as { from: PageId; to: PageId; role: string };

  if (!state.pages.has(from)) throw new LinkTargetNotFoundError(from);
  if (!state.pages.has(to)) throw new LinkTargetNotFoundError(to);

  return {
    events: [{ type: "LinkAdded", payload: { from, to, role } }],
  };
};

/** Remove a graph edge `from -[role]-> to`. Both endpoints must exist. */
export const unlink: StructureHandler = (state, args) => {
  const { from, to, role } = args as { from: PageId; to: PageId; role: string };

  if (!state.pages.has(from)) throw new LinkTargetNotFoundError(from);
  if (!state.pages.has(to)) throw new LinkTargetNotFoundError(to);

  return {
    events: [{ type: "LinkRemoved", payload: { from, to, role } }],
  };
};

// ────────────────────────────────────────────────────────────────────────────
// moveItem
// ────────────────────────────────────────────────────────────────────────────

/**
 * Move a list element (by id) from one page's `(section, field)` list to another's,
 * atomically. The element must exist on `from` (else {@link ItemNotFoundError}).
 * Emits one `SectionOpsApplied{removeElement}` on `from` + one
 * `SectionOpsApplied{addElement}` on `to` in ONE batch.
 */
export const moveItem: StructureHandler = (state, args) => {
  const { from, to, section, field, itemId } = args as {
    from: PageId;
    to: PageId;
    section: string;
    field: string;
    itemId: string;
  };

  const fromNode = requirePage(state, from);
  const toNode = requirePage(state, to);
  assertPageActive(fromNode);
  assertPageActive(toNode);

  const fromSec = fromNode.sections.find((s) => s.key === section);
  const listField: IField | undefined = fromSec?.fields[field];
  const moved: IItem | undefined =
    listField !== undefined && listField.kind === "list"
      ? listField.elements.find((e) => e.id === itemId)
      : undefined;
  if (moved === undefined) throw new ItemNotFoundError(`${section}.${field}`, itemId);

  const added = {
    op: "addElement" as const,
    section,
    field,
    id: moved.id,
    fields: structuredClone(moved.fields),
    ...(moved.status !== undefined ? { status: moved.status } : {}),
    ...(moved.meta !== undefined ? { meta: structuredClone(moved.meta) } : {}),
  };

  return {
    events: [
      { type: SECTION_OPS_EVENT, pageId: from, payload: { ops: [{ op: "removeElement", section, field, id: itemId }] } },
      { type: SECTION_OPS_EVENT, pageId: to, payload: { ops: [added] } },
    ],
  };
};

// ────────────────────────────────────────────────────────────────────────────
// archiveWorkspace
// ────────────────────────────────────────────────────────────────────────────

/** Archive the whole workspace. */
export const archiveWorkspace: StructureHandler = () => {
  return { events: [{ type: "WorkspaceArchived", payload: {} }] };
};

/** Unarchive the whole workspace (the inverse of {@link archiveWorkspace}). Exempt from the
 *  command bus's archived-workspace guard — it is the one structural verb that runs while the
 *  workspace IS archived (the way back). */
export const unarchiveWorkspace: StructureHandler = () => {
  return { events: [{ type: "WorkspaceUnarchived", payload: {} }] };
};

// ────────────────────────────────────────────────────────────────────────────
// assignSerials
// ────────────────────────────────────────────────────────────────────────────

/**
 * Backfill engine-assigned `serial` fields onto pages that predate the field — the
 * schema-evolution path for adding a serial to a type that ALREADY has pages (their
 * `PageCreated` carried no minted value, so the field materialized to the placeholder 0).
 * For each type with serial field(s), assigns the unset pages — in CREATION order (ids are
 * time-sortable) — the next value after the current max, as one `setField` per page in ONE
 * atomic commit. IMMUTABLE: a page whose serial is already set is never touched. Idempotent:
 * emits nothing once every serial is assigned, so it is safe to re-run.
 */
export const assignSerials: StructureHandler = (state, _args, _services, registry) => {
  const events: DomainEvent[] = [];
  for (const type of registry.types()) {
    const fields = serialFieldsOf(registry.page(type));
    if (fields.length === 0) continue;
    const pages = [...state.pages.values()]
      .filter((n) => n.type === type)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const { section, field } of fields) {
      let next = maxSerial(state, type, section, field);
      for (const node of pages) {
        if (serialValueOf(node, section, field) !== 0) continue; // already assigned — immutable
        next += 1;
        const op: SectionOp = { op: "setField", section, field, value: { kind: "scalar", value: next } as IField };
        events.push({ type: SECTION_OPS_EVENT, pageId: node.id, payload: { ops: [op] } });
      }
    }
  }
  return { events };
};

// ────────────────────────────────────────────────────────────────────────────
// Handler map (keyed by command name)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Structural command handlers, keyed by the public command name. The command
 * bus dispatches `structural({ handlerName, args })` through this table.
 * Aliases: `archive`/`unlink` map to the workspace/link handlers respectively.
 */
export const STRUCTURAL_HANDLERS: Readonly<Record<string, StructureHandler>> = {
  createPage,
  reparent,
  reorder,
  setPageTitle,
  archivePage,
  unarchivePage,
  link,
  unlink,
  moveItem,
  archiveWorkspace,
  unarchiveWorkspace,
  assignSerials,
  // The IWorkspaceHandle exposes `archive()` / `unarchive()` for workspace archival.
  archive: archiveWorkspace,
  unarchive: unarchiveWorkspace,
};
