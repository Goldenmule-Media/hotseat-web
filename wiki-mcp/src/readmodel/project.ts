/**
 * The projection apply step (DESIGN §5.1, ADR-M3): **fold then serialize**.
 *
 * For each commit (an ordered event batch ending at some `version`) we fold the
 * workspace's full history with the engine's PUBLIC `foldWorkspace` to the
 * resulting `IWorkspaceState`, then serialize that state into SQL rows. Reusing the
 * engine fold means the read model can never *semantically* diverge from the write
 * model (same upcasting, same unknown-type policy) — the only mapping we own is
 * state→rows, done here.
 *
 * Each apply writes the workspace's row set AND the new `applied_version` in ONE
 * transaction, so `projection_offsets.applied_version` never reports ahead of the
 * data (§5.1 "atomic per commit"). The append is **idempotent**: events with
 * `version <= applied_version` are skipped, so re-delivery causes no double-apply.
 */
import { ROOT } from "wiki";
import { Registry } from "wiki/registry";
import { foldWorkspace } from "wiki";
import type {
  IBlock,
  IField,
  IInline,
  IPageNode,
  ISection,
  IEventEnvelope,
  IWorkspaceState,
  PageId,
  RefTarget,
  WorkspaceId,
} from "wiki";
import type { Insertable, Kysely } from "kysely";

import { createLanguageRegistry } from "../models/analyzers/index.js";
import type { LanguageRegistry } from "../models/language-registry.js";
import type {
  EventsTable,
  LinksTable,
  OutlineTable,
  PagesTable,
  ReadModelDatabase,
  ReferenceIndexTable,
  SymbolIndexTable,
  TreeEdgesTable,
  XrefIndexTable,
} from "./schema.js";

/** Insertable row shapes: JSONB columns are `string` on the way in (we serialize). */
type PageInsert = Insertable<PagesTable>;
type TreeEdgeInsert = Insertable<TreeEdgesTable>;
type LinkInsert = Insertable<LinksTable>;
type EventInsert = Insertable<EventsTable>;
type OutlineInsert = Insertable<OutlineTable>;
type SymbolInsert = Insertable<SymbolIndexTable>;
type ReferenceInsert = Insertable<ReferenceIndexTable>;
type XrefInsert = Insertable<XrefIndexTable>;

/** Serialize a JS value to the `string` JSONB columns expect on insert. */
function toJsonb(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/**
 * The default {@link LanguageRegistry} (built-in TS/JS analyzer) used when a caller
 * doesn't inject one — constructed once and shared (the analyzer is stateless/pure).
 */
const DEFAULT_LANGUAGES: LanguageRegistry = createLanguageRegistry();

/** Build the `pages` rows for a folded workspace state. */
function pageRows(state: IWorkspaceState): PageInsert[] {
  const rows: PageInsert[] = [];
  for (const node of state.pages.values()) {
    rows.push({
      id: node.id,
      workspace_id: state.id,
      type: node.type,
      parent_id: node.parentId,
      title: node.title,
      status: node.status,
      // JSONB column: Insertable type is `string`; we serialize ourselves.
      sections: toJsonb(node.sections),
      created_at: node.createdAt,
      updated_at: node.updatedAt,
    });
  }
  return rows;
}

/** Build `outline` rows — the section tree, straight from folded state (§11). */
function outlineRows(state: IWorkspaceState): OutlineInsert[] {
  const rows: OutlineInsert[] = [];
  for (const node of state.pages.values()) {
    for (const sec of node.sections) {
      rows.push({
        workspace_id: state.id,
        page_id: node.id,
        section_id: sec.id,
        parent_section_id: sec.parentId,
        key: sec.key,
        name: sec.name,
        ord: sec.order,
      });
    }
  }
  return rows;
}

/**
 * Build the `symbol_index` + `reference_index` rows over every `code` field and `code`
 * block (recursing `blocks` fields, §6.2). For a `lang` with a loaded analyzer
 * ({@link LanguageRegistry}) we parse canonical source and emit one symbol row **per
 * declaration** (name/kind/container/offsets) plus one reference row per identifier
 * occurrence. For a `lang` with **no** analyzer we keep the Phase-1 STUB: a single
 * location-only symbol row (name/kind/offsets null), serving the code as an opaque
 * canonical blob (§12). Pure + deterministic: the analyzer is pure over its source, the
 * walk is source-ordered, so equal state yields equal rows (§10).
 */
function symbolAndReferenceRows(
  state: IWorkspaceState,
  langs: LanguageRegistry,
): { symbols: SymbolInsert[]; references: ReferenceInsert[] } {
  const symbols: SymbolInsert[] = [];
  const references: ReferenceInsert[] = [];

  const pushCode = (
    node: IPageNode,
    sec: ISection,
    field: string,
    blockId: string | null,
    lang: string,
    source: string,
    hash: string,
  ): void => {
    const analyzer = langs.get(lang);
    if (analyzer === undefined) {
      // No analyzer for this lang → the STUB: one location-only row (§12).
      symbols.push({
        workspace_id: state.id,
        page_id: node.id,
        section_id: sec.id,
        field,
        block_id: blockId,
        lang,
        source_hash: hash,
        name: null,
        kind: null,
        container: null,
        def_start: null,
        def_end: null,
      });
      return;
    }
    for (const sym of analyzer.symbols(source, lang)) {
      symbols.push({
        workspace_id: state.id,
        page_id: node.id,
        section_id: sec.id,
        field,
        block_id: blockId,
        lang,
        source_hash: hash,
        name: sym.name,
        kind: sym.kind,
        container: sym.container ?? null,
        def_start: sym.defStart,
        def_end: sym.defEnd,
      });
    }
    for (const ref of analyzer.references(source, undefined, lang)) {
      references.push({
        workspace_id: state.id,
        page_id: node.id,
        section_id: sec.id,
        field,
        block_id: blockId,
        lang,
        name: ref.name,
        ref_start: ref.start,
        ref_end: ref.end,
      });
    }
  };

  const walkBlocks = (node: IPageNode, sec: ISection, field: string, blocks: IBlock[]): void => {
    for (const b of blocks) {
      if (b.kind === "code") pushCode(node, sec, field, b.id, b.lang, b.source, b.hash);
      else if (b.kind === "quote") walkBlocks(node, sec, field, b.blocks);
      else if (b.kind === "list") for (const item of b.items) walkBlocks(node, sec, field, item);
    }
  };
  for (const node of state.pages.values()) {
    for (const sec of node.sections) {
      for (const [fk, f] of Object.entries(sec.fields)) {
        if (f.kind === "code") pushCode(node, sec, fk, null, f.lang, f.source, f.hash);
        else if (f.kind === "blocks") walkBlocks(node, sec, fk, f.blocks);
      }
    }
  }
  return { symbols, references };
}

/** Build `xref_index` rows — every `ref` field + inline ref, harvested deep (§7). */
function xrefRows(state: IWorkspaceState): XrefInsert[] {
  const rows: XrefInsert[] = [];
  const push = (node: IPageNode, sec: ISection, field: string, target: RefTarget): void => {
    rows.push({
      workspace_id: state.id,
      from_page: node.id,
      from_section: sec.id,
      from_field: field,
      target_kind: target.kind,
      target_page: target.kind === "page" ? target.id : null,
      target_section: target.kind === "section" ? target.id : "section" in target ? target.section : null,
      target_block: target.kind === "block" ? target.block : null,
      target_name: target.kind === "symbol" ? target.name : null,
    });
  };
  const walkInlines = (node: IPageNode, sec: ISection, field: string, inlines: IInline[]): void => {
    for (const run of inlines) if (run.kind === "ref") push(node, sec, field, run.target);
  };
  const walkBlocks = (node: IPageNode, sec: ISection, field: string, blocks: IBlock[]): void => {
    for (const b of blocks) {
      if (b.kind === "paragraph" || b.kind === "heading") walkInlines(node, sec, field, b.inlines);
      else if (b.kind === "quote") walkBlocks(node, sec, field, b.blocks);
      else if (b.kind === "list") for (const item of b.items) walkBlocks(node, sec, field, item);
      else if (b.kind === "table") {
        for (const cell of b.header) walkInlines(node, sec, field, cell);
        for (const row of b.rows) for (const cell of row) walkInlines(node, sec, field, cell);
      }
    }
  };
  const walkField = (node: IPageNode, sec: ISection, field: string, f: IField): void => {
    if (f.kind === "ref") push(node, sec, field, f.target);
    else if (f.kind === "blocks") walkBlocks(node, sec, field, f.blocks);
    else if (f.kind === "list") for (const el of f.elements) for (const [efk, ef] of Object.entries(el.fields)) walkField(node, sec, `${field}.${efk}`, ef);
  };
  for (const node of state.pages.values()) {
    for (const sec of node.sections) {
      for (const [fk, f] of Object.entries(sec.fields)) walkField(node, sec, fk, f);
    }
  }
  return rows;
}

/** Build the ordered `tree_edges` rows (one per parent→child, with `ord`). */
function treeEdgeRows(state: IWorkspaceState): TreeEdgeInsert[] {
  const rows: TreeEdgeInsert[] = [];
  for (const [parent, children] of state.children) {
    children.forEach((childId, ord) => {
      rows.push({
        workspace_id: state.id,
        // ROOT (`@root`) is stored verbatim so top-level pages are queryable.
        parent_id: parent === ROOT ? ROOT : (parent as string),
        child_id: childId,
        ord,
      });
    });
  }
  return rows;
}

/** Build the `links` rows for a folded workspace state. */
function linkRows(state: IWorkspaceState): LinkInsert[] {
  return state.links.map((l) => ({
    workspace_id: state.id,
    from_id: l.from,
    to_id: l.to,
    role: l.role,
  }));
}

/** Build the `events` rows for the commit's event batch. */
function eventRows(workspaceId: WorkspaceId, events: readonly IEventEnvelope[]): EventInsert[] {
  return events.map((e) => ({
    workspace_id: workspaceId,
    version: e.version,
    type: e.type,
    page_id: (e.pageId as PageId | undefined) ?? null,
    payload: toJsonb(e.payload),
    occurred_at: e.meta.occurredAt,
  }));
}

/**
 * The applied position is the engine's per-workspace `version` == **stream length**
 * (event count), which is exactly the value the engine stamps into a write's
 * {@link ConsistencyToken} (`committedVersion`) and feeds to its read model's
 * `notifyApplied`. So `appliedVersion` must equal the folded `state.version`, NOT
 * the head event's 0-based `version` (`state.version - 1`) — using the latter would
 * leave `appliedToken` one short of every write token, hanging `waitFor`.
 */

/** A commit to apply: the workspace's FULL event history and its resume cursor. */
export interface Commit {
  readonly workspaceId: WorkspaceId;
  /** The full, contiguous event history `[WorkspaceCreated, …]` for the fold. */
  readonly events: readonly IEventEnvelope[];
  /** Durable Streams resume cursor at the head of this commit (opaque). */
  readonly cursor?: string;
}

/** Read the applied version for a workspace, or `-1` if it has never been projected. */
export async function appliedVersion(
  db: Kysely<ReadModelDatabase>,
  workspaceId: WorkspaceId,
): Promise<number> {
  const row = await db
    .selectFrom("projection_offsets")
    .select("applied_version")
    .where("workspace_id", "=", workspaceId)
    .executeTakeFirst();
  return row?.applied_version ?? -1;
}

/**
 * Apply a {@link Commit}: fold its history, serialize the resulting state into SQL,
 * and advance `applied_version` — all in ONE transaction. Returns the new applied
 * version (the folded `state.version - 1`, i.e. the head event's `version`).
 *
 * Idempotent: if the commit's head `version` is already `<= applied_version`, the
 * apply is a no-op and the current applied version is returned.
 *
 * @param fingerprint the registry fingerprint stamped on the offset row (§5.3).
 * @param languages the {@link LanguageRegistry} the symbol/reference projection
 *   consults per `code` field/block `lang` (§6.2); a lang with no analyzer keeps the
 *   location-only stub row.
 */
export async function applyCommit(
  db: Kysely<ReadModelDatabase>,
  registry: Registry,
  commit: Commit,
  fingerprint: string,
  languages: LanguageRegistry = DEFAULT_LANGUAGES,
): Promise<number> {
  if (commit.events.length === 0) return appliedVersion(db, commit.workspaceId);

  // The applied position is the stream length (== the write token's version, the
  // head event's 0-based `version` + 1).
  const headApplied = commit.events[commit.events.length - 1].version + 1;
  const already = await appliedVersion(db, commit.workspaceId);
  if (headApplied <= already) return already;

  // Fold the full history with the engine's public, pure reducer (ADR-M3).
  const state = foldWorkspace(commit.events, registry);
  // `version` == stream length == the write token's `committedVersion` (the applied
  // position the engine's own read model tracks via `notifyApplied`).
  const newApplied = state.version;

  const pages = pageRows(state);
  const edges = treeEdgeRows(state);
  const links = linkRows(state);
  const events = eventRows(commit.workspaceId, commit.events);
  const outline = outlineRows(state);
  const { symbols, references } = symbolAndReferenceRows(state, languages);
  const xrefs = xrefRows(state);
  const cursor = commit.cursor ?? null;

  await db.transaction().execute(async (trx) => {
    // Replace the workspace's projected rows from the freshly-folded state. The
    // read model is a derived cache, so a full per-workspace re-serialize is the
    // simplest faithful state→rows mapping (no per-event diffing).
    await trx.deleteFrom("pages").where("workspace_id", "=", commit.workspaceId).execute();
    await trx.deleteFrom("tree_edges").where("workspace_id", "=", commit.workspaceId).execute();
    await trx.deleteFrom("links").where("workspace_id", "=", commit.workspaceId).execute();
    await trx.deleteFrom("outline").where("workspace_id", "=", commit.workspaceId).execute();
    await trx.deleteFrom("symbol_index").where("workspace_id", "=", commit.workspaceId).execute();
    await trx.deleteFrom("reference_index").where("workspace_id", "=", commit.workspaceId).execute();
    await trx.deleteFrom("xref_index").where("workspace_id", "=", commit.workspaceId).execute();

    await trx
      .insertInto("workspaces")
      .values({ id: state.id, name: state.name, status: state.status, updated_at: isoNow(state) })
      .onConflict((oc) =>
        oc.column("id").doUpdateSet({ name: state.name, status: state.status, updated_at: isoNow(state) }),
      )
      .execute();

    if (pages.length > 0) await trx.insertInto("pages").values(pages).execute();
    if (edges.length > 0) await trx.insertInto("tree_edges").values(edges).execute();
    if (links.length > 0) await trx.insertInto("links").values(links).execute();
    if (outline.length > 0) await trx.insertInto("outline").values(outline).execute();
    if (symbols.length > 0) await trx.insertInto("symbol_index").values(symbols).execute();
    if (references.length > 0) await trx.insertInto("reference_index").values(references).execute();
    if (xrefs.length > 0) await trx.insertInto("xref_index").values(xrefs).execute();

    // Append the commit's events (idempotent on the (workspace, version) PK).
    if (events.length > 0) {
      await trx
        .insertInto("events")
        .values(events)
        .onConflict((oc) => oc.columns(["workspace_id", "version"]).doNothing())
        .execute();
    }

    // Advance the applied position + resume cursor in the SAME transaction.
    await trx
      .insertInto("projection_offsets")
      .values({
        workspace_id: commit.workspaceId,
        applied_version: newApplied,
        cursor,
        fingerprint,
      })
      .onConflict((oc) =>
        oc.column("workspace_id").doUpdateSet({ applied_version: newApplied, cursor, fingerprint }),
      )
      .execute();
  });

  return newApplied;
}

/** The most-recent `updatedAt` across the workspace's pages, else its creation-derived stamp. */
function isoNow(state: IWorkspaceState): string {
  let latest = "";
  for (const node of state.pages.values()) {
    if (node.updatedAt > latest) latest = node.updatedAt;
  }
  return latest;
}
