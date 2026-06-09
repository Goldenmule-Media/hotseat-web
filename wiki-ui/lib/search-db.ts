/**
 * The full-text search database — now owned by the SharedWorker (lib/wiki-host.worker.ts),
 * which runs the ONE engine and therefore the ONE PGlite writer. The wiki engine's FTS is a
 * content-read projection backed by Kysely over a Postgres-compatible DB; in the browser
 * that DB is {@link PGlite} persisted to IndexedDB (`idb://`), so the index survives reloads.
 *
 * Single-writer by construction. Previously each tab opened its own `new PGlite("idb://…")`
 * over the SAME IndexedDB store — and PGlite's `idb://` FS is single-connection/last-flush-
 * wins, so concurrent tabs raced and could diverge. Consolidating the engine into one
 * SharedWorker means exactly one PGlite opens this store; the cross-tab hazard is gone.
 *
 * Assets are passed EXPLICITLY. PGlite needs an 8 MB wasm module + a 5 MB Postgres data
 * image; rather than depend on webpack emitting them for the worker chunk (fragile), we
 * fetch them from `public/pglite/*` (copied there by scripts/copy-pglite-assets.mjs) and
 * hand them to `PGlite.create(dataDir, { wasmModule, fsBundle })`, bypassing PGlite's
 * implicit `import.meta.url` fetch entirely.
 *
 * Async, and migrated before return. Unlike the old tab path (which had to keep engine
 * construction synchronous and so gated the dialect on a separate migration handle), the
 * worker boots asynchronously, so we simply `await migrateSearchToLatest` BEFORE handing the
 * handle to `createWiki` — no gate, no second Kysely handle, no race.
 *
 * Worker-only: never imported by a tab module (PGlite must not instantiate on the main
 * thread or the server).
 */
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { migrateSearchToLatest, type WikiSearchDatabase } from "wiki";
import { PGliteDialect } from "./pglite-dialect";

/** IndexedDB store name for the persisted index. Bump to invalidate a bad local index. */
const IDB_NAME = "idb://wiki-ui-search";
/** Absolute URLs served from `public/pglite/` (resolve identically in tab and worker). */
const WASM_URL = "/pglite/postgres.wasm";
const DATA_URL = "/pglite/postgres.data";

let dbP: Promise<Kysely<WikiSearchDatabase>> | undefined;

/**
 * Open the engine-facing search DB: compile PGlite's wasm, load the FS image, create the one
 * PGlite over `idb://wiki-ui-search`, run the schema migration, and return a Kysely handle
 * ready for `createWiki({ search: { db } })`. Singleton per worker.
 */
export function openSearchDb(): Promise<Kysely<WikiSearchDatabase>> {
  if (dbP !== undefined) return dbP;
  dbP = (async () => {
    const [wasmModule, fsBundle] = await Promise.all([compileWasm(WASM_URL), fetchBlob(DATA_URL)]);
    const pglite = await PGlite.create(IDB_NAME, { wasmModule, fsBundle });
    const db = new Kysely<WikiSearchDatabase>({ dialect: new PGliteDialect(pglite) });
    // The whole worker boot awaits this, so the engine never folds/queries before the
    // `search_doc`/`search_offset` tables exist.
    await migrateSearchToLatest(db);
    return db;
  })().catch((err: unknown) => {
    // A failed open leaves an unusable index; surface it but let the worker continue —
    // search just returns nothing rather than crashing the host. Reset so a later attempt
    // (next worker boot) can retry.
    dbP = undefined;
    console.error("[wiki-ui] search DB open failed:", err);
    throw err;
  });
  return dbP;
}

/**
 * Close + forget the search DB so a subsequent {@link openSearchDb} cold-starts a fresh PGlite.
 * Called when the last tab disconnects (the worker tears the engine down). `db.destroy()`
 * propagates through the dialect driver to `PGlite.close()`, releasing the `idb://` writer.
 */
export async function closeSearchDb(): Promise<void> {
  const p = dbP;
  dbP = undefined;
  if (p === undefined) return;
  try {
    const db = await p;
    await db.destroy();
  } catch {
    /* already closed / failed to open — nothing to release */
  }
}

/** Compile the wasm, tolerating servers that don't send `application/wasm` (compileStreaming
 *  requires that MIME; fall back to a buffer compile). */
async function compileWasm(url: string): Promise<WebAssembly.Module> {
  try {
    return await WebAssembly.compileStreaming(fetch(url));
  } catch {
    const res = await fetch(url);
    return WebAssembly.compile(await res.arrayBuffer());
  }
}

async function fetchBlob(url: string): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  return res.blob();
}
