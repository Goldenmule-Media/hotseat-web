/**
 * The SharedWorker host (feature: shared engine in a SharedWorker). Runs in
 * `SharedWorkerGlobalScope`: ONE engine, ONE PGlite (one writer), ONE Durable-Stream tail and
 * reachability probe per workspace — shared across every browser tab. Tabs are thin Comlink
 * clients (lib/host-client.ts) over a per-tab `MessagePort`.
 *
 * What lives here (relocated off the tab): `createWiki`, PGlite + the Kysely search DB
 * (lib/search-db.ts), the page-type bundles (lib/config.ts → lib/models.ts), the reachability
 * probe and the one-time search priming. The engine's live tail works in worker scope because
 * the Durable-Streams client tails over `fetch` + `ReadableStream` (not `EventSource`, which is
 * absent here).
 *
 * What it exposes: the flat {@link WikiHostApi}. A per-connecting-port api object (so each call
 * knows its tab) registers snapshot callbacks and a heartbeat; the worker folds each commit
 * once and fans a {@link WorkspaceSnapshot} out to that workspace's subscribers. Engine throws
 * are marshalled to plain {@link WikiErrorDTO} objects at the edge.
 *
 * Lifecycle: a heartbeat reaper drops a port's subscriptions when its tab goes silent (no
 * reliable port-closed event); when the LAST port disconnects the engine is closed and the
 * boot is reset, so a freshly-opened tab cold-starts the host.
 */
import * as Comlink from "comlink";
import { createWiki, type IEventEnvelope, type IWiki, type IWorkspaceHandle, type Unsubscribe } from "wiki";
import type { PageId, WorkspaceId } from "wiki";
import { getConfig } from "./config";
import { closeSearchDb, openSearchDb } from "./search-db";
import {
  classifyError,
  toWikiErrorDTO,
  type HostSearchOpts,
  type LoadError,
  type SnapshotCallback,
  type WikiHostApi,
  type WorkspaceSnapshot,
} from "./wiki-host-api";

// ── minimal SharedWorker typings ────────────────────────────────────────────────
// The tsconfig `lib` is DOM (not WebWorker), so `SharedWorkerGlobalScope`/`onconnect` aren't
// in scope. Adding the webworker lib would clash with DOM's globals; instead declare the one
// shape we touch (MessagePort/Event are already in the DOM lib).
interface ConnectEvent extends Event {
  readonly ports: ReadonlyArray<MessagePort>;
}
const scope = self as unknown as { onconnect: ((e: ConnectEvent) => void) | null };

// ── auth token (worker-scoped, tab-supplied) ────────────────────────────────────
// ONE token for the whole worker — every tab of one browser profile shares the same
// localStorage session. Tabs push it via `setAuthToken` BEFORE their handshake (so the
// first boot's stream config sees it) and again whenever it changes; a token arriving
// AFTER a header-less boot tears the engine down (the idle path) so the next call
// re-boots with the header function installed.

let currentToken: string | null = null;
/** Flips on the first non-null token and stays true: from then on the stream config
 *  carries the authorization header (whose function reads {@link currentToken} per
 *  request, so a cleared token sends an empty bearer the gated server rejects — by
 *  design). Never flips when auth is disabled, so that path omits headers entirely. */
let tokenProvided = false;

/** The probe's mirror of the engine's stream auth. `undefined` when no token was ever
 *  supplied (auth disabled) so the HEAD request is byte-identical to the old one. */
function probeHeaders(): Record<string, string> | undefined {
  return tokenProvided ? { authorization: `Bearer ${currentToken ?? ""}` } : undefined;
}

// ── one-time engine boot ────────────────────────────────────────────────────────

interface Booted {
  readonly wiki: IWiki;
  readonly cfg: { readonly streamBaseUrl: string; readonly namespace: string };
  readonly fsm: Record<string, import("wiki").FsmDescriptor>;
}

let bootP: Promise<Booted> | null = null;
/** Whether the CURRENT boot's stream config carries the auth-header function. A token
 *  arriving later (via `setAuthToken`) while this is false means the engine would 401
 *  forever — that call tears the boot down so the next one re-installs the header. */
let bootedWithHeaders = false;
/** The in-flight engine/PGlite teardown from {@link shutdownIdle}; the next boot awaits
 *  it so a fresh PGlite never opens the `idb://` store while the old one is closing. */
let teardownP: Promise<void> | null = null;

function boot(): Promise<Booted> {
  if (bootP !== null) return bootP;
  const withHeaders = tokenProvided;
  bootedWithHeaders = withHeaders;
  bootP = (async (): Promise<Booted> => {
    if (teardownP !== null) await teardownP;
    const cfg = getConfig();
    const db = await openSearchDb();
    const wiki = createWiki({
      stream: {
        baseUrl: cfg.streamBaseUrl,
        namespace: cfg.namespace,
        // The header FUNCTION is re-evaluated per request, so a token refreshed by any
        // tab (`setAuthToken`) takes effect without rebuilding the wiki. Omitted entirely
        // when no tab ever supplied a token (auth disabled) — wiring identical to before.
        ...(withHeaders ? { headers: { authorization: () => `Bearer ${currentToken ?? ""}` } } : {}),
      },
      pageTypes: cfg.pageTypes,
      search: { db },
    });
    // FSM descriptors are immutable per type and read synchronously — capture them all once so
    // the tab's `fsmOf` stays sync in render (sent at handshake).
    const fsm: Record<string, import("wiki").FsmDescriptor> = {};
    for (const type of wiki.pageTypes()) fsm[type] = wiki.fsmOf(type);
    return { wiki, cfg: { streamBaseUrl: cfg.streamBaseUrl, namespace: cfg.namespace }, fsm };
  })();
  return bootP;
}

// ── per-workspace host (the old tab WorkspaceSession, relocated) ─────────────────

/** Healthy-state probe cadence and the faster retry cadence while disconnected. */
const PROBE_INTERVAL_MS = 10_000;
const PROBE_BACKOFF_MS = 2_000;

/**
 * Owns one workspace: the engine handle, the single tail, the reachability probe, the current
 * {@link WorkspaceSnapshot}, and the set of subscriber callbacks (one per subscribing tab).
 * Mirrors the logic that used to run per-tab in lib/live.tsx, now run ONCE in the worker.
 */
class WorkspaceHost {
  private snap: WorkspaceSnapshot = {
    tree: null,
    connection: "connecting",
    version: null,
    lastEventAt: null,
    error: null,
  };
  private readonly subs = new Map<number, SnapshotCallback>();
  private handleP: Promise<IWorkspaceHandle> | null = null;
  private unsub: Unsubscribe | null = null;
  private probeTimer: ReturnType<typeof setTimeout> | null = null;
  private down = false;
  private disposed = false;

  constructor(
    private readonly wiki: IWiki,
    readonly id: WorkspaceId,
    private readonly cfg: { readonly streamBaseUrl: string; readonly namespace: string },
  ) {
    void this.start();
  }

  /** Add a subscriber and deliver the current snapshot immediately (seed-on-subscribe). */
  addSub(subId: number, cb: SnapshotCallback): void {
    this.subs.set(subId, cb);
    this.deliver(cb);
  }

  removeSub(subId: number): void {
    this.subs.delete(subId);
  }

  hasSubs(): boolean {
    return this.subs.size > 0;
  }

  /** The current snapshot — read by `setAuthToken` to drop hosts a stale 401 poisoned. */
  snapshot(): WorkspaceSnapshot {
    return this.snap;
  }

  /** The shared engine handle, opened once. A failed open clears the cache so a probe-driven
   *  retry can re-open instead of replaying a permanently-rejected promise. */
  handle(): Promise<IWorkspaceHandle> {
    if (this.handleP === null) {
      this.handleP = this.wiki.openWorkspace(this.id).catch((e: unknown) => {
        this.handleP = null;
        throw e;
      });
    }
    return this.handleP;
  }

  private deliver(cb: SnapshotCallback): void {
    try {
      cb(this.snap);
    } catch {
      // A proxied callback to a dead tab can throw; the reaper removes it shortly.
    }
  }

  private set(patch: Partial<WorkspaceSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    for (const cb of this.subs.values()) this.deliver(cb);
  }

  private async start(): Promise<void> {
    try {
      await this.resume();
      this.scheduleProbe(PROBE_INTERVAL_MS);
    } catch (e) {
      this.fail(e, "error");
      // A transport failure can recover — keep probing. A content/schema/membership
      // (`forbidden`) error is deterministic for this build/session, so polling would
      // never clear it.
      if (this.snap.error?.kind === "connection") this.scheduleProbe(PROBE_BACKOFF_MS);
    }
  }

  /** Seed (or re-seed) the tree and ensure we are tailing. Shared by initial start and
   *  probe-detected recovery. */
  private async resume(): Promise<void> {
    const h = await this.handle();
    const tree = await h.tree();
    if (this.disposed) return;
    this.down = false;
    this.set({ tree, connection: "live", error: null });
    if (this.unsub === null) {
      this.unsub = await h.subscribe((e: IEventEnvelope) => void this.onEvent(e));
    }
  }

  private async onEvent(e: IEventEnvelope): Promise<void> {
    // An event arriving is itself proof of liveness.
    this.down = false;
    try {
      const h = await this.handle();
      const tree = await h.tree();
      if (this.disposed) return;
      this.set({ tree, connection: "live", version: e.version, lastEventAt: Date.now(), error: null });
    } catch (err) {
      this.fail(err, "reconnecting");
    }
  }

  /**
   * Classify a failure, log it once, and update the snapshot. A network problem reports the
   * given transport state; a content/schema failure leaves the transport "live" (so the tab's
   * indicator shows a schema error, not "Disconnected").
   */
  private fail(e: unknown, lostTransport: "error" | "reconnecting"): void {
    if (this.disposed) return;
    const error: LoadError = classifyError(e);
    if (this.snap.error?.message !== error.message) {
      const tag = error.kind === "connection" ? "unreachable" : error.kind;
      console.error(`[wiki-host] workspace ${this.id}: ${tag} — ${error.message}`);
    }
    if (error.kind === "connection") {
      this.down = true;
      this.set({ connection: lostTransport, error });
    } else {
      this.set({ connection: "live", error });
    }
  }

  private scheduleProbe(delayMs: number): void {
    if (this.disposed) return;
    this.probeTimer = setTimeout(() => void this.probe(), delayMs);
  }

  /** Reachability probe: a HEAD to the workspace stream. A network rejection means the server
   *  is unreachable → "reconnecting" (retried with backoff). On recovery, re-seed + re-tail;
   *  the engine's tail independently replays missed commits, so content also catches up. */
  private async probe(): Promise<void> {
    if (this.disposed) return;
    const base = this.cfg.streamBaseUrl.replace(/\/+$/, "");
    const url = `${base}/${this.cfg.namespace}/workspace/${encodeURIComponent(this.id)}`;
    try {
      // Any HTTP response = reachable (even a 401 — the auth failure surfaces through the
      // engine's own stream calls, classified as `unauthorized`, not as transport loss).
      await fetch(url, { method: "HEAD", headers: probeHeaders() });
      if (this.down || this.unsub === null || this.snap.connection !== "live") {
        try {
          await this.resume();
        } catch (e) {
          this.fail(e, "reconnecting");
        }
      }
      this.scheduleProbe(PROBE_INTERVAL_MS);
    } catch (e) {
      this.fail(e, "reconnecting");
      this.scheduleProbe(PROBE_BACKOFF_MS);
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.probeTimer !== null) clearTimeout(this.probeTimer);
    this.probeTimer = null;
    this.unsub?.();
    this.unsub = null;
    this.subs.clear();
  }
}

// ── shared host state ───────────────────────────────────────────────────────────

const workspaceHosts = new Map<WorkspaceId, WorkspaceHost>();
let subIdSeq = 1;
let primed = false;

async function ensureHost(ws: WorkspaceId): Promise<WorkspaceHost> {
  const { wiki, cfg } = await boot();
  let host = workspaceHosts.get(ws);
  if (host === undefined) {
    host = new WorkspaceHost(wiki, ws, cfg);
    workspaceHosts.set(ws, host);
  }
  return host;
}

/** Fold every active workspace once so search spans all of them. Idempotent; best-effort. */
async function primeSearchIndex(): Promise<void> {
  if (primed) return;
  const { wiki } = await boot();
  primed = true;
  const all = await wiki.listWorkspaces();
  await Promise.allSettled(all.filter((w) => w.status === "active").map((w) => wiki.openWorkspace(w.id)));
}

// ── per-port connection + heartbeat reaper ──────────────────────────────────────

const PING_TIMEOUT_MS = 30_000;
const REAP_INTERVAL_MS = 15_000;

class PortConn {
  lastSeen = Date.now();
  readonly subs = new Set<{ readonly ws: WorkspaceId; readonly subId: number }>();
  constructor(readonly port: MessagePort) {}
}

const ports = new Set<PortConn>();

function dropPort(conn: PortConn): void {
  ports.delete(conn);
  for (const s of conn.subs) workspaceHosts.get(s.ws)?.removeSub(s.subId);
  conn.subs.clear();
  if (ports.size === 0) shutdownIdle();
}

/** The full teardown: dispose every workspace host, close the engine + PGlite, and reset the
 *  boot so the next call cold-starts (re-folds, re-opens PGlite) on a fresh engine. Run when
 *  the last tab disconnects, and by `setAuthToken` when a token reaches a header-less boot. */
function shutdownIdle(): void {
  for (const host of workspaceHosts.values()) host.dispose();
  workspaceHosts.clear();
  primed = false;
  const b = bootP;
  bootP = null;
  teardownP = (async () => {
    try {
      if (b !== null) await (await b).wiki.close();
    } finally {
      await closeSearchDb(); // release the idb:// writer so the cold-start re-opens cleanly
    }
  })().catch(() => {});
}

// One reaper for the whole worker. SharedWorker has no reliable disconnect event, so a port
// whose tab stopped pinging is dropped here.
setInterval(() => {
  const now = Date.now();
  for (const conn of [...ports]) {
    if (now - conn.lastSeen > PING_TIMEOUT_MS) dropPort(conn);
  }
}, REAP_INTERVAL_MS);

// ── the exposed RPC api (one instance per connecting port) ──────────────────────

function makeApi(conn: PortConn): WikiHostApi {
  return {
    async setAuthToken(token: string | null) {
      // Deliberately does NOT boot(): tabs call this before their handshake so the
      // engine's first boot already sees the token; afterwards the per-request header
      // function simply reads the updated value.
      currentToken = token;
      if (token === null) return;
      tokenProvided = true;
      if (bootP !== null && !bootedWithHeaders) {
        // The engine booted WITHOUT the header function (a pre-auth tab, a transient
        // /auth/config failure, a reload inside the heartbeat window) — it would ignore
        // this token forever: every call 401s and notifyUnauthorized clears the freshly
        // minted token, an endless sign-in loop. Tear down exactly like the idle reaper
        // (full reset); the next handshake/RPC re-boots with the header installed.
        shutdownIdle();
        return;
      }
      // A cached host that 401'd under the OLD token would replay its unauthorized
      // snapshot to a freshly authenticated subscriber (seed-on-subscribe), tripping the
      // sign-out path and clearing the NEW token. Drop such hosts; the next subscribe
      // recreates them with the updated header.
      for (const [ws, host] of [...workspaceHosts]) {
        if (host.snapshot().error?.kind === "unauthorized") {
          host.dispose();
          workspaceHosts.delete(ws);
        }
      }
    },
    async handshake() {
      const { fsm } = await boot();
      return { fsm };
    },
    async listWorkspaces() {
      const { wiki } = await boot();
      try {
        return await wiki.listWorkspaces();
      } catch (e) {
        throw toWikiErrorDTO(e);
      }
    },
    async search(query: string, opts: HostSearchOpts) {
      const { wiki } = await boot();
      try {
        return await wiki.search(query, opts);
      } catch (e) {
        throw toWikiErrorDTO(e);
      }
    },
    async primeSearchIndex() {
      await primeSearchIndex();
    },
    async ensureWorkspace(ws: WorkspaceId) {
      await ensureHost(ws);
    },
    async toMarkdown(ws: WorkspaceId, page: PageId) {
      const host = await ensureHost(ws);
      try {
        const h = await host.handle();
        return await h.toMarkdown(page);
      } catch (e) {
        throw toWikiErrorDTO(e);
      }
    },
    async describeMutations(ws: WorkspaceId, page: PageId) {
      const host = await ensureHost(ws);
      try {
        const h = await host.handle();
        const view = await h.page(page);
        return await view.describeMutations();
      } catch (e) {
        throw toWikiErrorDTO(e);
      }
    },
    async mutate(ws: WorkspaceId, page: PageId, command: string, args: Record<string, unknown>) {
      const host = await ensureHost(ws);
      try {
        const h = await host.handle();
        // The committed event flows back through this workspace's tail and re-projects every
        // subscribed tab, so we discard the token here.
        await h.mutate(page, command as never, args as never);
      } catch (e) {
        throw toWikiErrorDTO(e);
      }
    },
    async archivePage(ws: WorkspaceId, page: PageId) {
      const host = await ensureHost(ws);
      try {
        const h = await host.handle();
        await h.archivePage(page);
      } catch (e) {
        throw toWikiErrorDTO(e);
      }
    },
    async unarchivePage(ws: WorkspaceId, page: PageId) {
      const host = await ensureHost(ws);
      try {
        const h = await host.handle();
        await h.unarchivePage(page);
      } catch (e) {
        throw toWikiErrorDTO(e);
      }
    },
    async renameWorkspace(ws: WorkspaceId, name: string) {
      const host = await ensureHost(ws);
      try {
        const h = await host.handle();
        await h.rename(name);
      } catch (e) {
        throw toWikiErrorDTO(e);
      }
    },
    async subscribe(ws: WorkspaceId, onSnapshot: SnapshotCallback) {
      const host = await ensureHost(ws);
      const subId = subIdSeq++;
      conn.subs.add({ ws, subId });
      host.addSub(subId, onSnapshot);
      return subId;
    },
    async unsubscribe(ws: WorkspaceId, subId: number) {
      workspaceHosts.get(ws)?.removeSub(subId);
      for (const s of conn.subs) {
        if (s.ws === ws && s.subId === subId) {
          conn.subs.delete(s);
          break;
        }
      }
    },
    async ping() {
      conn.lastSeen = Date.now();
    },
  };
}

scope.onconnect = (e: ConnectEvent): void => {
  const port = e.ports[0];
  const conn = new PortConn(port);
  ports.add(conn);
  // Comlink.expose calls port.start(); each connecting tab gets its own api instance over the
  // shared engine, so subscribe/ping know which port (and thus which tab) they belong to.
  Comlink.expose(makeApi(conn), port);
};
