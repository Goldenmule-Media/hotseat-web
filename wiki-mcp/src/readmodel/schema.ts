/**
 * The SQL read-model schema as Kysely table types (DESIGN §5.2). One schema serves
 * EVERY page type — the engine's types are pluggable, so type-specific data lives
 * in JSONB (`fields`, `items`, event `payload`), queryable with Postgres JSON
 * operators. These are the relational projection of `IWorkspaceState`; the
 * applied position is the single source of truth in `projection_offsets`, never on
 * `workspaces` (DESIGN §5.2 comment).
 *
 * Kysely column helpers: `Generated<T>` marks a column the DB fills (insert may
 * omit it); `JSONColumnType<T>` is a JSONB column whose Selectable shape is `T`
 * (parsed) while inserts pass a serialized `string`. We serialize JSONB ourselves
 * (`JSON.stringify`) on the way in and read parsed objects out.
 */
import type { ColumnType, JSONColumnType } from "kysely";

/** Any JSON-serializable value. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: JsonValue }
  | JsonValue[];

/**
 * The Selectable shape of a JSONB column — `object | null` to satisfy Kysely's
 * `JSONColumnType` constraint. A page's `fields`/`items` and an event `payload`
 * are always objects or arrays at the top level (never a bare scalar), so this is
 * exact in practice; consumers narrow further per page type.
 */
export type JsonObject = { [key: string]: JsonValue } | JsonValue[] | null;

/**
 * `workspaces(id PK, name, status, updated_at)`. The applied version lives in
 * {@link ProjectionOffsetsTable}, so it is intentionally absent here.
 */
export interface WorkspacesTable {
  id: string;
  name: string;
  status: string;
  updated_at: string;
}

/**
 * `pages(id PK, workspace_id FK, type, parent_id, title, status, archived, sections JSONB,
 * created_at, updated_at)`. Content is the typed section tree (§2), serialized to
 * a single `sections` JSONB column.
 */
export interface PagesTable {
  id: string;
  workspace_id: string;
  type: string;
  parent_id: string | null;
  title: string;
  status: string;
  /** Hidden from default tree views; an orthogonal visibility flag, not a status (engine ADR-011). */
  archived: boolean;
  /** The page's typed section tree (`node.sections`), serialized to jsonb. */
  sections: JSONColumnType<JsonObject>;
  created_at: string;
  updated_at: string;
}

/** `outline(workspace_id, page_id, section_id, parent_section_id, key, name, ord)` (§11). */
export interface OutlineTable {
  workspace_id: string;
  page_id: string;
  section_id: string;
  parent_section_id: string | null;
  key: string;
  name: string;
  ord: number;
}

/**
 * `symbol_index(...)` — the symbol projection (§6.2). For a `code` field/block whose
 * `lang` has a loaded analyzer (the §7 LanguageRegistry), one row **per declaration**:
 * `name` / `kind` / `def_start` / `def_end` carry the symbol and its `[def_start,
 * def_end)` offset range into canonical source. For a `lang` with **no** analyzer it
 * keeps the Phase-1 STUB shape — one location-only row with `name`/`kind`/offsets null
 * (the "opaque blob served verbatim" case, §12). `source_hash` is the field/block
 * content hash (`def_hash`), so a rename reads source + hash straight from here (§6.4).
 */
export interface SymbolIndexTable {
  workspace_id: string;
  page_id: string;
  section_id: string;
  field: string;
  block_id: string | null;
  lang: string;
  source_hash: string;
  name: string | null;
  kind: string | null;
  /** Containing symbol (e.g. the class of a method), or null. */
  container: string | null;
  /** 0-based start offset of the declaration in canonical source; null for a stub row. */
  def_start: number | null;
  /** End offset (exclusive) of the declaration; null for a stub row. */
  def_end: number | null;
}

/**
 * `reference_index(...)` — the in-source identifier index (§6.2/§11). One row per
 * identifier occurrence inside a `code` field/block whose `lang` has an analyzer; a
 * rename's where-used set and the `references` read tool read this. Resolution to a
 * specific declaration (cross-file / type-aware) is Phase 3 — a reference is keyed by
 * `name` + `[start, end)` offset only.
 */
export interface ReferenceIndexTable {
  workspace_id: string;
  page_id: string;
  section_id: string;
  field: string;
  block_id: string | null;
  lang: string;
  name: string;
  /** 0-based start offset of the occurrence in canonical source. */
  ref_start: number;
  /** End offset (exclusive) of the occurrence. */
  ref_end: number;
}

/** `xref_index(...)` — every `ref` field and inline `ref`, harvested deep (§7). */
export interface XrefIndexTable {
  workspace_id: string;
  from_page: string;
  from_section: string;
  from_field: string;
  target_kind: string;
  target_page: string | null;
  target_section: string | null;
  target_block: string | null;
  target_name: string | null;
}

/** `tree_edges(workspace_id, parent_id, child_id, ord)` — ordered children. */
export interface TreeEdgesTable {
  workspace_id: string;
  /** The sentinel `@root` for top-level pages (DESIGN: ROOT). */
  parent_id: string;
  child_id: string;
  ord: number;
}

/** `links(workspace_id, from_id, to_id, role)` — graph edges beyond the tree. */
export interface LinksTable {
  workspace_id: string;
  from_id: string;
  to_id: string;
  role: string;
}

/** `events(workspace_id, version, type, page_id, payload JSONB, occurred_at)` — the queryable log. */
export interface EventsTable {
  workspace_id: string;
  version: number;
  type: string;
  page_id: string | null;
  payload: JSONColumnType<JsonObject>;
  occurred_at: string;
}

/**
 * `projection_offsets(workspace_id PK, applied_version, cursor, fingerprint)` —
 * the resume cursor + the `IReadModel` applied position. `waitFor({ws, version})`
 * resolves when `applied_version >= version` (the load-bearing semantic, §5.2).
 */
export interface ProjectionOffsetsTable {
  workspace_id: string;
  applied_version: number;
  /** Durable Streams resume cursor (opaque); null before the first applied commit. */
  cursor: string | null;
  /** Registered page-type set + schema version; a change triggers a rebuild (§5.3). */
  fingerprint: string;
}

/** The full read-model database, as Kysely sees it. */
export interface ReadModelDatabase {
  workspaces: WorkspacesTable;
  pages: PagesTable;
  tree_edges: TreeEdgesTable;
  links: LinksTable;
  events: EventsTable;
  projection_offsets: ProjectionOffsetsTable;
  outline: OutlineTable;
  symbol_index: SymbolIndexTable;
  reference_index: ReferenceIndexTable;
  xref_index: XrefIndexTable;
}

/** Convenience: a column that is text both in and out (no JSON parsing). */
export type TextColumn = ColumnType<string, string, string>;
