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
 * `pages(id PK, workspace_id FK, type, parent_id, title, status, sections JSONB,
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
 * `symbol_index(...)` — a STUB (§11/§12): one row per `code` field/block with its
 * canonical source location + hash. `name`/`kind`/`range` are filled in Phase 3 by
 * the LanguageRegistry; null in Phase 1 (no parser).
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
  range: string | null;
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
  xref_index: XrefIndexTable;
}

/** Convenience: a column that is text both in and out (no JSON parsing). */
export type TextColumn = ColumnType<string, string, string>;
