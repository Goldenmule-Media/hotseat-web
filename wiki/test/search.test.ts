/**
 * Full-text search — the engine's Kysely-backed content index (the first content
 * projection). Two surfaces: the {@link SqlSearchIndex} in isolation (reconcile + ranked
 * query + archived filter + delete-missing), and the end-to-end handle path where
 * `createWiki({ search })` indexes off the fold and `handle.search` is read-your-writes
 * over the page's deterministic Markdown — finding pages by BODY, not just title.
 */
import { afterEach, describe, expect, it } from "vitest";

import { createWiki, encodeToken, ReadModelClosedError, SearchIndexUnavailableError } from "../src/index";
import type { Committed, IWorkspaceHandle, PageId, WorkspaceId } from "../src/api";
import { SqlSearchIndex, type SearchDoc } from "../src/search";
import { startTestServer, type ITestServer } from "../src/testing";
import { featurePageTypes } from "wiki-models/feature";

import { makeSearchDb, type SearchTestDb } from "./helpers/search-db";

const WS = "ws:search-unit" as WorkspaceId;
const doc = (over: Partial<SearchDoc> & Pick<SearchDoc, "pageId">): SearchDoc => ({
  type: "note",
  status: "active",
  archived: false,
  title: "",
  body: "",
  version: 1,
  ...over,
});

describe("SqlSearchIndex — reconcile + ranked query", () => {
  let sdb: SearchTestDb;
  let index: SqlSearchIndex;

  afterEach(async () => {
    await sdb?.close();
  });

  async function seed(docs: readonly SearchDoc[], version = 1): Promise<void> {
    sdb = await makeSearchDb();
    index = new SqlSearchIndex(sdb.db);
    await index.reconcile(WS, version, docs);
  }

  it("matches a term in the BODY, not only the title; ranks higher term-frequency first", async () => {
    // The indexed `body` IS the page's rendered Markdown, whose H1 is the title — so a
    // title word is searchable through the body. These fixtures mirror that: the title is
    // folded into the body (as `renderPage` would), and the index is over `body` alone.
    await seed([
      doc({ pageId: "p1" as PageId, title: "Quarterly report", body: "Quarterly report\nfox, fox, fox — a den of fox by the river" }),
      doc({ pageId: "p2" as PageId, title: "Fox sightings", body: "Fox sightings\na short memo" }),
    ]);

    const fox = await index.query([WS], "fox");
    // p1 mentions "fox" far more often → it outranks p2 (no title boost: rank is term
    // frequency). Order is asserted directly (no .sort() mask) — ts_rank is distinct here.
    expect(fox.map((h) => h.pageId)).toEqual(["p1", "p2"]); // p1 by prose, p2 by its title-in-body
    expect(fox[0].snippet.toLowerCase()).toContain("fox");

    const river = await index.query([WS], "river");
    expect(river.map((h) => h.pageId)).toEqual(["p1"]); // body-only term, still found

    expect(await index.query([WS], "supercalifragilistic")).toEqual([]);
  });

  it("excludes archived pages and drops rows that disappear on reconcile", async () => {
    await seed([
      doc({ pageId: "p1" as PageId, title: "Alpha", body: "shared keyword" }),
      doc({ pageId: "p2" as PageId, title: "Beta", body: "shared keyword" }),
    ]);
    expect((await index.query([WS], "keyword")).map((h) => h.pageId).sort()).toEqual(["p1", "p2"]);

    // Archive p1, delete p2 (omit from the doc set) — both leave the results.
    await index.reconcile(WS, 2, [doc({ pageId: "p1" as PageId, title: "Alpha", body: "shared keyword", archived: true })]);
    expect(await index.query([WS], "keyword")).toEqual([]);
  });

  it("matches a plain query case-insensitively and by word PREFIX", async () => {
    await seed([doc({ pageId: "p1" as PageId, body: "Concurrency Engine\nthe concurrency model" })]);
    // A partial word still finds the page (restores the old substring-ish feel)…
    expect((await index.query([WS], "concur")).map((h) => h.pageId)).toEqual(["p1"]);
    // …and case never matters.
    expect((await index.query([WS], "CONCURRENCY")).map((h) => h.pageId)).toEqual(["p1"]);
    expect(await index.query([WS], "supercalifragilistic")).toEqual([]);
  });

  it("clamps a non-positive limit rather than silently returning nothing", async () => {
    await seed([
      doc({ pageId: "p1" as PageId, body: "shared term here" }),
      doc({ pageId: "p2" as PageId, body: "shared term again" }),
    ]);
    // limit 0 must not reach SQL as `LIMIT 0` (which would return no rows); it clamps to 1.
    expect((await index.query([WS], "shared", { limit: 0 })).length).toBe(1);
    expect((await index.query([WS], "shared", { limit: -5 })).length).toBe(1);
  });

  it("upserts a multi-row batch and regenerates tsv on conflict (changed-body re-reconcile)", async () => {
    await seed([
      doc({ pageId: "p1" as PageId, body: "alpha aardvark" }),
      doc({ pageId: "p2" as PageId, body: "beta boomerang" }),
      doc({ pageId: "p3" as PageId, body: "gamma giraffe" }),
    ]);
    expect((await index.query([WS], "aardvark")).map((h) => h.pageId)).toEqual(["p1"]);

    // Re-reconcile the SAME ids with CHANGED bodies — the excluded-based upsert must update
    // each row AND regenerate the generated tsv (old terms stop matching, new ones start).
    await index.reconcile(WS, 2, [
      doc({ pageId: "p1" as PageId, body: "alpha zebra", version: 2 }),
      doc({ pageId: "p2" as PageId, body: "beta boomerang", version: 2 }),
      doc({ pageId: "p3" as PageId, body: "gamma giraffe", version: 2 }),
    ]);
    expect(await index.query([WS], "aardvark")).toEqual([]);
    expect((await index.query([WS], "zebra")).map((h) => h.pageId)).toEqual(["p1"]);
  });

  it("update() applies a multi-row delta and tolerates an empty doc set", async () => {
    await seed([doc({ pageId: "p1" as PageId, body: "first one" })]);
    // multi-row upsert via update()
    await index.update(
      WS,
      2,
      [
        doc({ pageId: "p2" as PageId, body: "second two", version: 2 }),
        doc({ pageId: "p3" as PageId, body: "third three", version: 2 }),
      ],
      [],
    );
    expect((await index.query([WS], "second")).map((h) => h.pageId)).toEqual(["p2"]);
    expect((await index.query([WS], "third")).map((h) => h.pageId)).toEqual(["p3"]);

    // A remove-only / structure-only commit calls update with NO docs — must not throw
    // (`.values([])` would). It deletes the removed page and still advances the cursor.
    await expect(index.update(WS, 3, [], ["p1"])).resolves.toBeUndefined();
    expect(await index.query([WS], "first")).toEqual([]);
  });

  it("breaks ts_rank ties deterministically by page_id (stable order + stable LIMIT cut)", async () => {
    // Byte-identical bodies → identical ts_rank → a genuine tie. Insert in non-id order so
    // a regression (no tiebreaker) would surface as physical/insertion order, not page_id.
    await seed([
      doc({ pageId: "p2" as PageId, body: "identical body text" }),
      doc({ pageId: "p1" as PageId, body: "identical body text" }),
    ]);
    for (let i = 0; i < 3; i++) {
      expect((await index.query([WS], "identical")).map((h) => h.pageId)).toEqual(["p1", "p2"]);
    }
    // The LIMIT cut keeps the SAME hit every run (page_id order), not an arbitrary one.
    expect((await index.query([WS], "identical", { limit: 1 })).map((h) => h.pageId)).toEqual(["p1"]);
  });

  it("forget() rejects a parked waitFor with ReadModelClosedError (no teardown hang)", async () => {
    await seed([doc({ pageId: "p1" as PageId, body: "anything" })]); // index applied at v1
    // Park a wait for a version the index hasn't reached, with a generous timeout — so a
    // regression (forget that only clears timers) fails as a 1s timeout, not a hang.
    const parked = index.waitFor(encodeToken(WS, 9), { timeoutMs: 1000 });
    // waitFor awaits ensureHydrated before parking, so flush microtasks to ensure the
    // waiter is actually parked before we tear down.
    await new Promise((r) => setTimeout(r, 10));
    index.forget(WS); // teardown while the wait is pending
    await expect(parked).rejects.toBeInstanceOf(ReadModelClosedError);
  });

  it("fail() fast-fails token-gated waiters with SearchIndexUnavailableError, then recovers", async () => {
    await seed([doc({ pageId: "p1" as PageId, body: "seed", version: 1 })]); // applied at v1

    // Park a wait for v2 (not yet applied), then signal a FAILED best-effort reindex to v2.
    const parked = index.waitFor(encodeToken(WS, 2), { timeoutMs: 1000 });
    await new Promise((r) => setTimeout(r, 10)); // ensure parked past ensureHydrated
    const boom = new Error("boom");
    index.fail(WS, 2, boom);
    const rejection = await parked.then(() => undefined, (e: unknown) => e);
    expect(rejection).toBeInstanceOf(SearchIndexUnavailableError);
    expect((rejection as SearchIndexUnavailableError).cause).toBe(boom); // wraps the raw cause

    // A waitFor arriving AFTER the failure also fails fast (no 1s park).
    await expect(index.waitFor(encodeToken(WS, 2), { timeoutMs: 1000 })).rejects.toBeInstanceOf(
      SearchIndexUnavailableError,
    );

    // A successful update to v2 clears the marker → a subsequent waitFor resolves (recovery).
    await index.update(WS, 2, [doc({ pageId: "p1" as PageId, body: "seed two", version: 2 })], []);
    await expect(index.waitFor(encodeToken(WS, 2))).resolves.toBeUndefined();
  });

  it("a restart hydrated from search_offset clears a stale failure marker the cursor COVERS", async () => {
    sdb = await makeSearchDb();
    const idx1 = new SqlSearchIndex(sdb.db);
    await idx1.reconcile(WS, 5, [doc({ pageId: "p1" as PageId, body: "persisted", version: 5 })]); // offset = 5

    const idx2 = new SqlSearchIndex(sdb.db);
    idx2.fail(WS, 5, new Error("stale failure recorded before hydration"));
    // ensureHydrated reads search_offset=5; notifyApplied(5) reaches the failed version (5>=5)
    // so the stale marker clears, and a token already satisfied on disk resolves.
    await expect(idx2.waitFor(encodeToken(WS, 3))).resolves.toBeUndefined();
  });

  it("KEEPS a failure marker recorded BEYOND the hydrated cursor (hydration must not mask it)", async () => {
    sdb = await makeSearchDb();
    const idx1 = new SqlSearchIndex(sdb.db);
    await idx1.reconcile(WS, 5, [doc({ pageId: "p1" as PageId, body: "persisted", version: 5 })]); // offset = 5

    const idx2 = new SqlSearchIndex(sdb.db);
    // A NEWER reindex (v6) failed before this fresh instance ever hydrated.
    idx2.fail(WS, 6, new Error("v6 reindex failed"));
    // Hydration seeds applied=5 but must NOT wipe the v6 marker (5 < 6), so a token-gated
    // search for v6 still FAST-fails (vs. parking to the 1s timeout with the wrong error type).
    await expect(idx2.waitFor(encodeToken(WS, 6), { timeoutMs: 1000 })).rejects.toBeInstanceOf(
      SearchIndexUnavailableError,
    );
    // …while a token the durable cursor DOES cover still resolves.
    await expect(idx2.waitFor(encodeToken(WS, 5))).resolves.toBeUndefined();
  });

  it("a restarted index hydrates from search_offset so concurrent first-readers don't park", async () => {
    sdb = await makeSearchDb();
    const idx1 = new SqlSearchIndex(sdb.db);
    await idx1.reconcile(WS, 5, [doc({ pageId: "p1" as PageId, body: "persisted", version: 5 })]); // search_offset = 5

    // A FRESH index over the SAME db (its in-memory state empty) — like a process restart.
    const idx2 = new SqlSearchIndex(sdb.db);
    // Fire many concurrent first-readers for a version the persisted cursor already covers,
    // with NO intervening update. The memoised hydration shares ONE search_offset read, so
    // all resolve from the durable cursor — none reads a stale empty cursor and parks (which
    // would spuriously time out at 500ms).
    const waits = Array.from({ length: 10 }, () => idx2.waitFor(encodeToken(WS, 3), { timeoutMs: 500 }));
    await expect(Promise.all(waits)).resolves.toHaveLength(10);
  });
});

describe("createWiki({ search }) — read-your-writes over page content", () => {
  let server: ITestServer;
  let sdb: SearchTestDb;
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (close !== undefined) await close();
    await sdb?.close();
    await server?.stop();
  });

  it("indexes off the fold: finds a brief by summary body, reflects edits, hides archived", async () => {
    server = await startTestServer();
    sdb = await makeSearchDb();
    const wiki = createWiki({
      stream: { baseUrl: server.url, namespace: "search" },
      pageTypes: featurePageTypes,
      search: { db: sdb.db },
    });
    close = () => wiki.close();

    const handle: IWorkspaceHandle = await wiki.createWorkspace({ name: "Search WS" });
    const created = await handle.createPage("feature-brief", { title: "Concurrency Engine", parentId: null });
    const brief = created.value;

    // Distinctive words that live ONLY in the body (summary), never in any title.
    const t1 = (await handle.mutate(brief, "setSummary", {
      text: "Quasar telemetry ingestion across the warp manifold.",
    })) as Committed<unknown>;

    const quasar = await handle.search("quasar", { consistentWith: t1.token });
    expect(quasar.map((h) => h.pageId)).toContain(brief);
    expect(quasar.find((h) => h.pageId === brief)?.snippet.toLowerCase()).toContain("quasar");

    expect((await handle.search("manifold", { consistentWith: t1.token })).map((h) => h.pageId)).toContain(brief);
    expect(await handle.search("nonexistentxyzzy", { consistentWith: t1.token })).toEqual([]);

    // Title is the H1 of the render, so a title word still matches (search strictly gains).
    expect((await handle.search("concurrency", { consistentWith: t1.token })).map((h) => h.pageId)).toContain(brief);

    // Editing the summary re-indexes: the old word stops matching, the new one starts.
    const t2 = (await handle.mutate(brief, "setSummary", {
      text: "Neutrino detector calibration log.",
    })) as Committed<unknown>;
    expect(await handle.search("quasar", { consistentWith: t2.token })).toEqual([]);
    expect((await handle.search("neutrino", { consistentWith: t2.token })).map((h) => h.pageId)).toContain(brief);

    // Archiving removes the page from results.
    const t3 = await handle.archivePage(brief);
    expect(await handle.search("neutrino", { consistentWith: t3.token })).toEqual([]);
  }, 30000);

  it("re-indexes incrementally: editing one page never drops the others from the index", async () => {
    server = await startTestServer();
    sdb = await makeSearchDb();
    const wiki = createWiki({
      stream: { baseUrl: server.url, namespace: "search" },
      pageTypes: featurePageTypes,
      search: { db: sdb.db },
    });
    close = () => wiki.close();

    const handle: IWorkspaceHandle = await wiki.createWorkspace({ name: "Multi WS" });
    const a = (await handle.createPage("feature-brief", { title: "Alpha page", parentId: null })).value;
    const b = (await handle.createPage("feature-brief", { title: "Beta page", parentId: null })).value;
    await handle.mutate(a, "setSummary", { text: "alpha distinctive aardvark" });
    const tB = (await handle.mutate(b, "setSummary", { text: "beta distinctive boomerang" })) as Committed<unknown>;

    // Both pages are indexed by their own distinctive body terms.
    expect((await handle.search("aardvark", { consistentWith: tB.token })).map((h) => h.pageId)).toContain(a);
    expect((await handle.search("boomerang", { consistentWith: tB.token })).map((h) => h.pageId)).toContain(b);

    // Edit ONLY page a. The incremental update must re-render a (new term in, old term out)
    // WITHOUT touching b — b stays findable (a full-replace bug would have dropped it).
    const tA2 = (await handle.mutate(a, "setSummary", { text: "alpha distinctive zebra" })) as Committed<unknown>;
    expect((await handle.search("zebra", { consistentWith: tA2.token })).map((h) => h.pageId)).toContain(a);
    expect(await handle.search("aardvark", { consistentWith: tA2.token })).toEqual([]);
    expect((await handle.search("boomerang", { consistentWith: tA2.token })).map((h) => h.pageId)).toContain(b);
  }, 30000);

  it("fast-fails a token-gated search when the best-effort reindex fails, then recovers", async () => {
    server = await startTestServer();
    sdb = await makeSearchDb();
    // Inject index-write failures by intercepting `db.transaction()` (used only by
    // reconcile/update). Reads (selectFrom — hydration + query) pass straight through, so the
    // failure is scoped to the off-write-path reindex, exactly as a transient DB error would be.
    let failWrites = false;
    const realDb = sdb.db;
    const db = new Proxy(realDb, {
      get(target, prop, receiver) {
        if (prop === "transaction" && failWrites) {
          return () => ({ execute: async () => { throw new Error("injected index write failure"); } });
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    }) as typeof realDb;

    const wiki = createWiki({
      stream: { baseUrl: server.url, namespace: "search" },
      pageTypes: featurePageTypes,
      search: { db },
    });
    close = () => wiki.close();

    const handle: IWorkspaceHandle = await wiki.createWorkspace({ name: "Fail WS" });
    const brief = (await handle.createPage("feature-brief", { title: "Doomed", parentId: null })).value;
    const ok = (await handle.mutate(brief, "setSummary", { text: "indexed fine" })) as Committed<unknown>;
    expect((await handle.search("indexed", { consistentWith: ok.token })).map((h) => h.pageId)).toContain(brief);

    // Break index writes, then write again: the off-write-path reindex throws and the swallow
    // handler must fail() the token-gated search FAST with SearchIndexUnavailableError rather
    // than hang to the timeout. The 2s timeout means a regression (silent swallow) would
    // surface as a slow ConsistencyTimeoutError of the wrong type.
    failWrites = true;
    const broken = (await handle.mutate(brief, "setSummary", { text: "never indexed" })) as Committed<unknown>;
    await expect(
      handle.search("nonsense", { consistentWith: broken.token, timeoutMs: 2000 }),
    ).rejects.toBeInstanceOf(SearchIndexUnavailableError);

    // Recovery: writes work again; the next write's delta spans the gap and a successful
    // reindex clears the failure marker, so a token-gated search resolves once more.
    failWrites = false;
    const fixed = (await handle.mutate(brief, "setSummary", { text: "indexed again xenon" })) as Committed<unknown>;
    expect((await handle.search("xenon", { consistentWith: fixed.token })).map((h) => h.pageId)).toContain(brief);
  }, 30000);
});
