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

/** `{ component: [...], question: [...], commit: [...] }` — items keyed by item type. */
export type ItemsJson = Record<string, Array<Record<string, unknown>>>;

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
 * `pages(id PK, workspace_id FK, type, parent_id, title, status, fields JSONB,
 * items JSONB, created_at, updated_at)`.
 */
export interface PagesTable {
  id: string;
  workspace_id: string;
  type: string;
  parent_id: string | null;
  title: string;
  status: string;
  /** The page type's typed `fields` (opaque to the read model). */
  fields: JSONColumnType<JsonObject>;
  /** e.g. `{ question: [...], task: [...] }`. */
  items: JSONColumnType<ItemsJson>;
  created_at: string;
  updated_at: string;
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
}

/** Convenience: a column that is text both in and out (no JSON parsing). */
export type TextColumn = ColumnType<string, string, string>;
