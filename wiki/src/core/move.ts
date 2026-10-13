/**
 * Cross-workspace page moves, one workspace at a time. A move spans two streams, so it is a
 * saga of single-stream commits, each idempotent: the source freezes the pages
 * (`PageMoveStarted`), the target imports them (`PagesImported`), and the source finishes
 * (`PageMoveCompleted`, which leaves forwards) or gives up (`PageMoveAborted`). The
 * `wiki/admin` `movePages` saga drives these steps; the journal on the source stream is
 * enough to resume a move that stopped partway.
 */
import {
  ROOT,
  type DomainEvent,
  type IEventEnvelope,
  type IExportedPage,
  type IField,
  type IPageMoveExport,
  type IPageMoveRequest,
  type IPagesImportResult,
  type IPendingMove,
  type ISection,
  type IWorkspaceLink,
  type IWorkspaceState,
  type PageId,
  type RefTarget,
  type SectionOp,
  type WorkspaceId,
} from "../api";
import {
  DuplicateTitleError,
  InvariantViolationError,
  PageMovedError,
  PageMoveInProgressError,
  PageNotFoundError,
  ParentNotFoundError,
} from "./errors";
import { validatePageContent } from "./ingestion";
import type { Registry } from "./registry";
import { maxSerial, serialFieldsOf, type StructureHandler } from "./structure";
import { applyWorkspace, SECTION_OPS_EVENT, type ImportedPageRecord, type PagesImportedPayload } from "./workspace";

/** The pending move a page belongs to, if any. */
export function pendingMoveOf(state: IWorkspaceState, pageId: PageId): IPendingMove | undefined {
  for (const move of state.pendingMoves.values()) {
    if (move.pageIds.includes(pageId)) return move;
  }
  return undefined;
}

/** Throw when any of `pageIds` is frozen by a pending move. */
export function assertNotMoving(state: IWorkspaceState, pageIds: readonly (PageId | null | undefined)[]): void {
  if (state.pendingMoves.size === 0) return;
  for (const id of pageIds) {
    if (id === null || id === undefined) continue;
    const move = pendingMoveOf(state, id);
    if (move !== undefined) throw new PageMoveInProgressError(id, move.moveId);
  }
}

/** The page ids a structural command's args touch (the ones a pending move must not change). */
export function structuralTargets(handler: string, args: unknown): PageId[] {
  if (handler in MOVE_HANDLERS) return []; // each move step checks its own pages
  const a = (args ?? {}) as Record<string, unknown>;
  const ids: unknown[] =
    handler === "moveItem" ? [a["from"], a["to"]] : [a["pageId"], a["parentId"], a["newParentId"], a["from"]];
  return ids.filter((v): v is PageId => typeof v === "string");
}

/** Resolve a page, naming where it went if it moved away. */
export function requireLivePage(state: IWorkspaceState, pageId: PageId): void {
  if (state.pages.has(pageId)) return;
  const forward = state.forwards.get(pageId);
  if (forward !== undefined) throw new PageMovedError(pageId, forward.workspace);
  throw new PageNotFoundError(pageId);
}

/** Every page in the given subtrees, in tree order (archived pages included). */
export function subtreePageIds(state: IWorkspaceState, roots: readonly PageId[]): PageId[] {
  const out: PageId[] = [];
  const visit = (id: PageId): void => {
    out.push(id);
    for (const child of state.children.get(id) ?? []) visit(child);
  };
  for (const root of roots) visit(root);
  return out;
}

/** Validate a move request against the source and resolve the pages it moves. */
export function planMove(state: IWorkspaceState, request: IPageMoveRequest): { roots: PageId[]; pageIds: PageId[] } {
  const to = request.to as string;
  if (typeof to !== "string" || to.length === 0) throw new InvariantViolationError("A move needs a target workspace.");
  if (to === state.id) throw new InvariantViolationError("A move's target must be another workspace; use reparent instead.");
  const asked = [...new Set(request.roots)];
  if (asked.length === 0) throw new InvariantViolationError("A move needs at least one page.");
  for (const id of asked) requireLivePage(state, id);
  // A page inside another requested page's subtree already moves with it.
  const roots = asked.filter((id) => !hasAncestorIn(state, id, asked));
  for (const id of roots) {
    if (state.pages.get(id)!.pinned === true) {
      throw new InvariantViolationError(`Page "${id}" is pinned to its owner; move the owner instead.`);
    }
  }
  const pageIds = subtreePageIds(state, roots);
  assertNotMoving(state, pageIds);
  return { roots, pageIds };
}

function hasAncestorIn(state: IWorkspaceState, id: PageId, candidates: readonly PageId[]): boolean {
  let cur = state.pages.get(id)?.parentId ?? null;
  while (cur !== null) {
    if (candidates.includes(cur)) return true;
    cur = state.pages.get(cur)?.parentId ?? null;
  }
  return false;
}

/** Freeze the pages of a move out of this workspace. */
export const beginPageMove: StructureHandler = (state, args, services) => {
  const request = args as IPageMoveRequest;
  const { roots, pageIds } = planMove(state, request);
  const move: IPendingMove = {
    moveId: `move:${services.newId()}`,
    to: request.to as WorkspaceId,
    toParentId: request.toParentId ?? null,
    ...(request.position !== undefined ? { position: request.position } : {}),
    roots,
    pageIds,
  };
  return { events: [{ type: "PageMoveStarted", payload: move }], result: move };
};

/** Finish a move out. A move that already finished is a no-op. */
export const completePageMove: StructureHandler = (state, args) => {
  const { moveId } = args as { moveId: string };
  const move = state.pendingMoves.get(moveId);
  if (move === undefined) {
    if (finished(state, moveId)) return { events: [] };
    throw new InvariantViolationError(`No pending move "${moveId}".`);
  }
  // `to` and `pageIds` repeat the journal so a consumer reading one commit sees what left.
  return { events: [{ type: "PageMoveCompleted", payload: { moveId, to: move.to, pageIds: move.pageIds } }] };
};

/** Unfreeze a move the target refused. A move no longer pending is a no-op. */
export const abortPageMove: StructureHandler = (state, args) => {
  const { moveId, reason } = args as { moveId: string; reason?: string };
  if (!state.pendingMoves.has(moveId)) {
    if (finished(state, moveId)) throw new InvariantViolationError(`Move "${moveId}" already completed.`);
    return { events: [] };
  }
  return { events: [{ type: "PageMoveAborted", payload: { moveId, reason: reason ?? "" } }] };
};

function finished(state: IWorkspaceState, moveId: string): boolean {
  for (const f of state.forwards.values()) if (f.moveId === moveId) return true;
  return false;
}

// ────────────────────────────────────────────────────────────────────────────
// Export (source side, pure)
// ────────────────────────────────────────────────────────────────────────────

const ATTACHMENT_RE = /attachment:([0-9a-f]{64})/g;

/**
 * Build the import payload for a move from the (frozen) source state. Ids are kept, so refs
 * between moved pages stay as they are. A ref or link that leaves the moved pages becomes a
 * cross-workspace one back to the source (or to wherever its target already moved), and one
 * into the target workspace becomes local there.
 */
export function exportMove(state: IWorkspaceState, move: IPendingMove): IPageMoveExport {
  const moved = new Set(move.pageIds);
  const roots = new Set(move.roots);
  const where = (id: PageId): { workspace: WorkspaceId; title: string } | undefined => {
    const node = state.pages.get(id);
    if (node !== undefined) return { workspace: state.id, title: node.title };
    const forward = state.forwards.get(id);
    return forward === undefined ? undefined : { workspace: forward.workspace, title: forward.title };
  };

  const retarget = (target: RefTarget, holder: PageId): RefTarget => {
    const { workspace, title: _title, ...local } = target;
    if (workspace !== undefined && workspace !== state.id) return workspace === move.to ? (local as RefTarget) : target;
    const owner = target.kind === "page" ? target.id : (target.page ?? holder);
    if (moved.has(owner)) return local as RefTarget;
    const found = where(owner);
    if (found === undefined) return target;
    if (found.workspace === move.to) return local as RefTarget;
    const label =
      target.kind === "section"
        ? (state.pages.get(owner)?.sections.find((s) => s.id === target.id)?.name ?? found.title)
        : target.kind === "symbol"
          ? target.name
          : found.title;
    return target.kind === "page"
      ? ({ ...local, workspace: found.workspace, title: label } as RefTarget)
      : ({ ...local, page: owner, workspace: found.workspace, title: label } as RefTarget);
  };

  const rewrite = (value: unknown, holder: PageId): unknown => {
    if (Array.isArray(value)) return value.map((v) => rewrite(v, holder));
    if (value === null || typeof value !== "object") return value;
    const o = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) out[k] = rewrite(v, holder);
    if (o["kind"] === "ref" && o["target"] !== null && typeof o["target"] === "object") {
      out["target"] = retarget(o["target"] as RefTarget, holder);
    }
    return out;
  };

  const pages: IExportedPage[] = [];
  const blobs = new Set<string>();
  for (const id of move.pageIds) {
    const node = state.pages.get(id);
    if (node === undefined) continue;
    const sections = rewrite(node.sections, id) as ISection[];
    for (const m of JSON.stringify(sections).matchAll(ATTACHMENT_RE)) blobs.add(m[1]!);
    pages.push({
      id,
      type: node.type,
      parentId: roots.has(id) ? null : node.parentId,
      title: node.title,
      status: node.status,
      ...(node.archived === true ? { archived: true } : {}),
      ...(node.pinned === true ? { pinned: true } : {}),
      createdAt: node.createdAt,
      sections,
    });
  }

  const links: IWorkspaceLink[] = [];
  for (const l of state.links) {
    if (!moved.has(l.from)) continue;
    if (l.workspace !== undefined) {
      links.push(l.workspace === move.to ? { from: l.from, to: l.to, role: l.role } : { ...l });
    } else if (moved.has(l.to)) {
      links.push({ from: l.from, to: l.to, role: l.role });
    } else {
      const found = where(l.to);
      if (found === undefined) continue;
      links.push(
        found.workspace === move.to
          ? { from: l.from, to: l.to, role: l.role }
          : { from: l.from, to: l.to, role: l.role, workspace: found.workspace, title: found.title },
      );
    }
  }

  return {
    moveId: move.moveId,
    from: state.id,
    fromVersion: state.version,
    to: move.to,
    toParentId: move.toParentId,
    ...(move.position !== undefined ? { position: move.position } : {}),
    pages,
    links,
    blobs: [...blobs].sort(),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Import (target side)
// ────────────────────────────────────────────────────────────────────────────

/** Ops that rebuild a page's sections from empty: each section, then its fields and meta. */
function contentOps(sections: readonly ISection[]): SectionOp[] {
  const ops: SectionOp[] = [];
  const seen = new Set<string>();
  const visit = (parent: ISection["parentId"]): void => {
    const level = sections.filter((s) => s.parentId === parent).sort((a, b) => a.order - b.order);
    for (const sec of level) {
      ops.push({
        op: "addSection",
        id: sec.id,
        key: sec.key,
        name: sec.name,
        ...(sec.description !== undefined ? { description: sec.description } : {}),
        parentSection: sec.parentId,
      });
      // Field ops address a section by key, so only the first section with a key can carry
      // content; any later one holds the empty fields its declaration materializes.
      if (!seen.has(sec.key)) {
        seen.add(sec.key);
        for (const [field, value] of Object.entries(sec.fields)) {
          ops.push({ op: "setField", section: sec.key, field, value: structuredClone(value) });
        }
        for (const [k, v] of Object.entries(sec.meta ?? {})) {
          ops.push({ op: "setMeta", section: sec.key, path: [k], value: structuredClone(v) });
        }
      }
      visit(sec.id);
    }
  };
  visit(null);
  return ops;
}

/**
 * Import a move in one commit: `PagesImported` (node fields, tree placement, links) plus one
 * `SectionOpsApplied` per page rebuilding its content, so the content stays an op history
 * that the page type's upcasters apply to. Serial fields are re-minted after this
 * workspace's own numbers. Statuses arrive as they were; no FSM edges are replayed.
 */
export const importPages: StructureHandler = (state, args, _services, registry) => {
  const p = args as IPageMoveExport;
  const prior = state.imports.get(p.moveId);
  if (prior !== undefined) {
    const result: IPagesImportResult = { moveId: p.moveId, pageIds: prior.pageIds, alreadyImported: true, serials: {} };
    return { events: [], result };
  }
  if (p.to !== state.id) throw new InvariantViolationError(`This move is for workspace "${p.to}", not "${state.id}".`);
  if (p.from === state.id) throw new InvariantViolationError("A workspace can't import its own pages.");

  const parentId = p.toParentId ?? null;
  if (parentId !== null) {
    requireLivePage(state, parentId);
    if (state.pages.get(parentId)!.archived === true) throw new ParentNotFoundError(parentId);
    assertNotMoving(state, [parentId]);
  }

  const unknown = [...new Set(p.pages.map((pg) => pg.type).filter((t) => !registry.has(t)))];
  if (unknown.length > 0) {
    throw new InvariantViolationError(`This workspace's server has no page type ${unknown.map((t) => `"${t}"`).join(", ")}.`);
  }
  for (const pg of p.pages) {
    if (state.pages.has(pg.id)) throw new InvariantViolationError(`Page "${pg.id}" already exists here.`);
  }

  const siblings = (state.children.get(parentId ?? ROOT) ?? [])
    .map((id) => state.pages.get(id))
    .filter((n): n is NonNullable<typeof n> => n !== undefined);
  const rootTitles = new Set<string>();
  for (const pg of p.pages) {
    if (pg.parentId !== null) continue;
    const clash = siblings.find((s) => s.title === pg.title);
    if (clash !== undefined) throw new DuplicateTitleError(parentId, pg.title, clash.id, clash.archived === true);
    if (rootTitles.has(pg.title)) throw new InvariantViolationError(`Two moved pages are both titled "${pg.title}".`);
    rootTitles.add(pg.title);
  }

  const { records, sections, serials } = remintSerials(state, p.pages, registry);
  const imported = new Set(p.pages.map((pg) => pg.id));
  const links = p.links.filter((l) => l.workspace !== undefined || imported.has(l.to) || state.pages.has(l.to));

  const payload: PagesImportedPayload = {
    moveId: p.moveId,
    from: p.from,
    fromVersion: p.fromVersion,
    parentId,
    ...(p.position !== undefined ? { position: p.position } : {}),
    pages: records,
    links,
  };
  const events: DomainEvent[] = [{ type: "PagesImported", payload }];
  for (const pg of p.pages) {
    const ops = contentOps(sections.get(pg.id)!);
    if (ops.length > 0) events.push({ type: SECTION_OPS_EVENT, pageId: pg.id, payload: { ops } });
  }

  validateImport(state, events, records, registry);
  const result: IPagesImportResult = { moveId: p.moveId, pageIds: records.map((r) => r.id), alreadyImported: false, serials };
  return { events, result };
};

/** Give each serial field the next number after this workspace's own, in import order. */
function remintSerials(
  state: IWorkspaceState,
  pages: readonly IExportedPage[],
  registry: Registry,
): {
  records: ImportedPageRecord[];
  sections: Map<PageId, ISection[]>;
  serials: Record<string, Record<string, Record<string, { from: number; to: number }>>>;
} {
  const next = new Map<string, number>();
  const records: ImportedPageRecord[] = [];
  const sections = new Map<PageId, ISection[]>();
  const serials: Record<string, Record<string, Record<string, { from: number; to: number }>>> = {};
  for (const pg of pages) {
    const secs = structuredClone(pg.sections) as ISection[];
    const original: Record<string, Record<string, number>> = {};
    for (const { section, field } of serialFieldsOf(registry.page(pg.type))) {
      const sec = secs.find((s) => s.key === section);
      const current = sec?.fields[field];
      if (sec === undefined || current === undefined || current.kind !== "scalar" || typeof current.value !== "number") continue;
      if (current.value === 0) continue; // never assigned in the source; `assignSerials` fills it later
      const key = `${pg.type}\u0000${section}\u0000${field}`;
      const n = (next.get(key) ?? maxSerial(state, pg.type, section, field)) + 1;
      next.set(key, n);
      sec.fields[field] = { kind: "scalar", value: n } as IField;
      (original[section] ??= {})[field] = current.value;
      ((serials[pg.id] ??= {})[section] ??= {})[field] = { from: current.value, to: n };
    }
    sections.set(pg.id, secs);
    records.push({
      id: pg.id,
      type: pg.type,
      parentId: pg.parentId,
      title: pg.title,
      status: pg.status,
      ...(pg.archived === true ? { archived: true } : {}),
      ...(pg.pinned === true ? { pinned: true } : {}),
      createdAt: pg.createdAt,
      ...(Object.keys(original).length > 0 ? { originalSerials: original } : {}),
    });
  }
  return { records, sections, serials };
}

/** Fold the import onto a copy of the state and check every imported page's content. */
function validateImport(
  state: IWorkspaceState,
  events: readonly DomainEvent[],
  records: readonly ImportedPageRecord[],
  registry: Registry,
): void {
  const work = structuredClone(state);
  const types = new Map(records.map((r) => [r.id, r.type]));
  for (const ev of events) {
    const type = ev.pageId === undefined ? undefined : types.get(ev.pageId);
    const env: IEventEnvelope = {
      eventId: "import-dry-run",
      streamId: work.id,
      ...(ev.pageId !== undefined ? { pageId: ev.pageId } : {}),
      version: work.version,
      type: ev.type,
      schemaVersion: type !== undefined && ev.type === SECTION_OPS_EVENT ? registry.page(type).version : 0,
      payload: ev.payload,
      meta: { occurredAt: "" },
    };
    applyWorkspace(work, env, registry);
    work.version += 1;
  }
  for (const r of records) {
    const node = work.pages.get(r.id);
    if (node !== undefined) validatePageContent(work, node);
  }
}

export const MOVE_HANDLERS: Readonly<Record<string, StructureHandler>> = {
  beginPageMove,
  completePageMove,
  abortPageMove,
  importPages,
};

/** Move steps that must still run on an archived workspace (so a move can always finish). */
export const MOVE_FINISHERS: ReadonlySet<string> = new Set(["completePageMove", "abortPageMove"]);
