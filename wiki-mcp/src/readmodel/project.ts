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
import type { IEventEnvelope, IWorkspaceState, PageId, WorkspaceId } from "wiki";
import type { Insertable, Kysely } from "kysely";

import type {
  EventsTable,
  LinksTable,
  PagesTable,
  ReadModelDatabase,
  TreeEdgesTable,
} from "./schema.js";

/** Insertable row shapes: JSONB columns are `string` on the way in (we serialize). */
type PageInsert = Insertable<PagesTable>;
type TreeEdgeInsert = Insertable<TreeEdgesTable>;
type LinkInsert = Insertable<LinksTable>;
type EventInsert = Insertable<EventsTable>;

/** Serialize a JS value to the `string` JSONB columns expect on insert. */
function toJsonb(value: unknown): string {
  return JSON.stringify(value ?? null);
}

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
      // JSONB columns: Insertable type is `string`; we serialize ourselves.
      fields: toJsonb(node.fields),
      items: toJsonb(node.items),
      created_at: node.createdAt,
      updated_at: node.updatedAt,
    });
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
 */
export async function applyCommit(
  db: Kysely<ReadModelDatabase>,
  registry: Registry,
  commit: Commit,
  fingerprint: string,
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
  const cursor = commit.cursor ?? null;

  await db.transaction().execute(async (trx) => {
    // Replace the workspace's projected rows from the freshly-folded state. The
    // read model is a derived cache, so a full per-workspace re-serialize is the
    // simplest faithful state→rows mapping (no per-event diffing).
    await trx.deleteFrom("pages").where("workspace_id", "=", commit.workspaceId).execute();
    await trx.deleteFrom("tree_edges").where("workspace_id", "=", commit.workspaceId).execute();
    await trx.deleteFrom("links").where("workspace_id", "=", commit.workspaceId).execute();

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
