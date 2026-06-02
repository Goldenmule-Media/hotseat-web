# wiki-server — Design Document

> Status: **Draft / living document** · Last updated: 2026-06-01 · Owner: @benjamin
>
> The **durable stream host** that `wiki` clients point at. `wiki-server/` runs a standalone
> [Durable Streams](https://durablestreams.com/concepts) server with durable storage and a stable
> address, so any number of `wiki` instances — a CLI, an app, an LLM agent — can **point at the
> same base URL and share state**. It is plumbing: it imports `@durable-streams/server`, **never
> `wiki`**, and knows nothing about workspaces, pages, FSMs, or events. It just hosts streams.

---

## Table of contents

1. [Motivation & goals](#1-motivation--goals)
2. [Non-goals](#2-non-goals)
3. [What wiki-server is](#3-what-wiki-server-is)
4. [The `@durable-streams/server` it wraps](#4-the-durable-streamsserver-it-wraps)
5. [The client contract](#5-the-client-contract)
6. [Configuration](#6-configuration)
7. [Storage & durability](#7-storage--durability)
8. [Deployment & operations](#8-deployment--operations)
9. [Security](#9-security)
10. [Package structure](#10-package-structure)
11. [Testing strategy](#11-testing-strategy)
12. [Future work](#12-future-work)
13. [References](#13-references)
- [Appendix A: Decision records](#appendix-a-decision-records)

---

## 1. Motivation & goals

`wiki/` is a **transport-free engine** ([wiki/DESIGN.md §1, G1](../wiki/DESIGN.md)): it exposes only
a TypeScript interface and *consumes* a Durable Streams server over HTTP for storage. Its single
storage seam, `EventLog` ([wiki/DESIGN.md §9](../wiki/DESIGN.md)), points at an `IStreamConfig.baseUrl`.
**Something has to serve that URL.** In tests that's an in-process `DurableStreamTestServer`
([wiki/DESIGN.md §10.7, `wiki/testing`](../wiki/DESIGN.md)); for any real, shared, multi-process
deployment it needs a durable, long-running host. **That host is `wiki-server/`.**

The model is deliberately simple: **run `wiki` wherever you want, point each instance at one
`wiki-server`, and they share state through the stream.** There is no app server between the
engine and storage — the engine *is* the application, and `wiki-server` is the durable substrate
underneath it.

### Goals

- **G1 — Be the durable host, nothing more.** Run one Durable Streams server with durable storage
  at a stable base URL. No business logic, no API surface of our own.
- **G2 — Zero coupling to the engine.** `wiki-server` imports `@durable-streams/server` and
  **must not** depend on `wiki` or any wiki type. The only contract is the Durable Streams wire
  protocol; either side can be upgraded or replaced independently.
- **G3 — One shared stream, many clients.** Multiple `wiki` instances connect concurrently and
  rely on the server's per-stream ordering and optimistic concurrency ([§5](#5-the-client-contract))
  for correctness — the server is the synchronization point.
- **G4 — Durable by default.** File-backed storage out of the box; in-memory is a one-line switch
  for dev/test ([§7](#7-storage--durability)).
- **G5 — Trivial locally, sane when shared.** `npx wiki-server` boots a durable host with no
  config; a container image plus a reverse proxy cover the shared case ([§8](#8-deployment--operations)).

---

## 2. Non-goals

- **Not an API over the engine.** `wiki-server` does **not** wrap `wiki` in HTTP/RPC, expose the
  command catalog, validate commands, or know what a "page" is. (This supersedes the earlier
  `wiki-api/` idea, now struck from the plan — see [ADR-S1](#adr-s1--host-streams-do-not-wrap-the-engine-2026-06-01).)
- **No knowledge of the URL layout.** The workspace/snapshot/catalog path shapes are a
  **client-side convention** ([§5.2](#52-the-url-layout-is-the-clients-not-ours)); the server hosts
  whatever stream URLs clients create.
- **No projections / read models / search.** Engine concerns above the stream
  ([wiki/DESIGN.md §18](../wiki/DESIGN.md)).
- **No in-server auth / TLS / rate limiting.** The wrapped server has no request middleware
  ([§4](#4-the-durable-streamsserver-it-wraps)); those are a reverse proxy's job ([§9](#9-security)).
- **Not a CRDT or merge engine.** Ordering and conflict detection are per-stream and native; the
  engine handles rebase-and-retry on top ([wiki/DESIGN.md §15](../wiki/DESIGN.md)).
- **Not a horizontally-scaled cluster.** One durable node at the engine's *gentle* target scale
  ([wiki/DESIGN.md §6.6](../wiki/DESIGN.md)); scale/hardening is a server-side swap to the production
  tier ([§8.3](#83-production-tiers)).

---

## 3. What wiki-server is

In one sentence: **`wiki-server` is `@durable-streams/server` configured for durable storage, given
a stable bind address, a `bin`, and a container** — the thing that "hosts that part." Everything
that makes it *the wiki's* host (the URL layout, event envelopes, folding, OCC versioning) lives in
the **client** ([§5](#5-the-client-contract)); the server is content-agnostic.

```
   wiki client          wiki client            wiki client
   (CLI on a laptop)    (web app on a box)     (LLM agent in CI)
        │                     │                      │
        │  @durable-streams/client (fetch: POST append · GET read · GET live tail)
        └──────────────┬──────┴───────────┬──────────┘
                       │  HTTP, same baseUrl
       (shared deploys: reverse proxy terminates TLS + auth here — §9)
                       │
            ┌──────────▼───────────────────────────────┐
            │  wiki-server  (this package)               │
            │  ── thin wrapper over ──                   │
            │  @durable-streams/server (DurableStreamTestServer)
            │    • one node, stable bind addr            │
            │    • append-only log per stream URL        │
            │    • offsets · Stream-Seq OCC · live tail  │
            │    • storage: file (default) · memory      │
            └──────────────┬─────────────────────────────┘
                           │
                  ┌────────▼─────────┐
                  │  dataDir          │  append-only log files + LMDB metadata (file mode)
                  └───────────────────┘
```

---

## 4. The `@durable-streams/server` it wraps

Verified against the installed **`@durable-streams/server@0.3.5`** (its README, `dist/index.d.ts`,
and `src/server.ts`), consistent with [wiki/BUILD_NOTES.md §1](../wiki/BUILD_NOTES.md):

- **One server class, `DurableStreamTestServer`.** Constructor options
  (`TestServerOptions`): `host`, `port`, `dataDir?`, `longPollTimeout?`, `compression?`,
  `cursorIntervalSeconds?`, `cursorEpoch?`, `onStreamCreated?`, `onStreamDeleted?`. `start()`
  resolves to the bound URL; `stop()`, `get url()`, and `readonly baseUrl`/`port` round it out.
- **Two storage modes, selected by `dataDir` presence:** omit it → **in-memory**; set it →
  **file-backed** (append-only log files + an LMDB metadata index; `lmdb` is a dependency). There is
  **no `acid`/redb tier** in this Node package, and **no `storage` option** — the mode *is* whether
  `dataDir` is set. (ACID/`DS_STORAGE__MODE` belongs to the separate production Rust/Caddy server —
  [§8.3](#83-production-tiers).)
- **It owns its HTTP server privately.** `start()` does `createServer((req,res) => handleRequest(...))`;
  `handleRequest` is private and there is **no middleware hook, no body-size option, and no
  request-level auth** for stream traffic (the only `authorization` reference is a CORS allow-header).
  So **auth, TLS, body caps, and any extra endpoints are a front layer's job, not the server's**
  ([§9](#9-security)) — which also keeps `wiki-server`'s own code tiny.
- **The wire behavior the engine depends on is native:** one `append()` stores exactly one
  message (arrays are *not* split); `Stream-Seq` gives strict-greater OCC (a stale seq → **HTTP
  409**); offsets are opaque resume cursors; live tailing is long-poll/SSE
  ([wiki/BUILD_NOTES.md §1](../wiki/BUILD_NOTES.md)).

> **Production stance (upstream).** The package README scopes itself to "development, testing, and
> prototyping," and points production at the **Caddy plugin / Electric Cloud / Caddy standalone
> binary**. We knowingly run the file-backed Node server as a simple self-host at the engine's
> gentle target scale, with that production tier as a drop-in upgrade — see
> [ADR-S2](#adr-s2--wrap-the-node-server-for-the-self-host-tier-2026-06-01).

---

## 5. The client contract

The "interface" between `wiki` and `wiki-server` is **not TypeScript** — it is the Durable Streams
HTTP protocol plus a few conventions the **client** owns. Keeping those on the client is what lets
the server stay a generic, swappable stream host (G2).

### 5.1 What the host guarantees

| Guarantee | Notes |
|---|---|
| Per-stream **append-only ordering** | strict, monotonic per stream URL |
| **Atomic** single-message append | one `append()` = one durably-stored message (arrays not split) |
| **`Stream-Seq` 409** on stale append | strict-greater optimistic concurrency, surfaced as HTTP 409 |
| **Durable retention** of every message | for the life of the stream (file mode; [§7](#7-storage--durability)) |
| **Live tail** (long-poll / SSE) | resume from an opaque offset cursor |

How the engine *uses* these — folds, per-workspace `version`, rebase-and-retry, replay — is an
engine concern, documented in [wiki/DESIGN.md §8](../wiki/DESIGN.md)/[§15](../wiki/DESIGN.md). The
host neither knows nor cares.

### 5.2 The URL layout is the client's, not ours

`EventLog` constructs every URL it touches ([wiki/DESIGN.md §9.1](../wiki/DESIGN.md)):

```
{baseUrl}/{namespace}/workspace/{workspaceId}            ← the workspace event stream
{baseUrl}/{namespace}/workspace/{workspaceId}/snapshot   ← sibling snapshot stream
{baseUrl}/{namespace}/_catalog                           ← namespace catalog
```

`wiki-server` neither defines nor parses these paths — it serves arbitrary stream URLs under
`baseUrl`. Consequences:

- **A `namespace` is just a path prefix**, not a server-side tenant boundary. Isolation between
  namespaces, if wanted, is enforced at the proxy ([§9](#9-security)), never by the host.
- **Adding stream kinds is a client change only** — the host needs no change.
- **Retention is per-stream and chosen by the client** at create time (`ttlSeconds`); workspace and
  snapshot streams are created with **no TTL** ([wiki/DESIGN.md §9.1](../wiki/DESIGN.md)). The host
  honors whatever the client sets; it imposes no expiry of its own.

---

## 6. Configuration

A small, flat config resolved from **flags → env → defaults** (first wins). Everything has a
working default, so `wiki-server` runs with none. The host knobs map directly onto
`TestServerOptions` ([§4](#4-the-durable-streamsserver-it-wraps)); there are deliberately no
auth/TLS/body knobs here — those live in the proxy ([§9](#9-security)).

```ts
// src/config.ts
export interface WikiServerConfig {
  /** Bind address. Default "127.0.0.1" (loopback — explicit opt-in to expose). */
  readonly host: string;
  /** Port. Default 4437. */
  readonly port: number;
  /** "file" (durable) or "memory" (ephemeral). Default "file". Maps to dataDir presence. */
  readonly storage: "file" | "memory";
  /** Filesystem path for file storage. Default "./.wiki-data". Ignored when storage === "memory". */
  readonly dataDir: string;
  /** Long-poll hold time (ms), passed through to the server. Default 30000. */
  readonly longPollTimeout: number;
  /** Log format. Default "pretty" on a TTY, else "json". */
  readonly logFormat: "pretty" | "json";
}
```

| Flag | Env | Default | Notes |
|---|---|---|---|
| `--host` | `WIKI_SERVER_HOST` | `127.0.0.1` | Set `0.0.0.0` to accept non-local clients — then front it with a proxy ([§9](#9-security)). |
| `--port` | `WIKI_SERVER_PORT` | `4437` | The `baseUrl` clients use is `http(s)://{host}:{port}`. |
| `--storage` | `WIKI_SERVER_STORAGE` | `file` | `file` ⇒ pass `dataDir`; `memory` ⇒ omit it ([§7](#7-storage--durability)). |
| `--data-dir` | `WIKI_SERVER_DATA_DIR` | `./.wiki-data` | Created if absent; must be writable & persistent. |
| `--long-poll-ms` | `WIKI_SERVER_LONG_POLL_MS` | `30000` | Pass-through to the server. |
| `--log-format` | `WIKI_SERVER_LOG_FORMAT` | auto | `pretty` \| `json`. |

`baseUrl` is **derived, not configured**: read it back from `server.url` after `start()` (robust
when `port: 0` auto-assigns), and that string is what goes into each client's `IStreamConfig.baseUrl`.

---

## 7. Storage & durability

`wiki-server` exists to make the stream **durable**, so storage mode is its central decision.

### 7.1 The two modes

| Mode | `dataDir` | Backend | Durability | Use it for |
|---|---|---|---|---|
| `memory` | omitted | in-process | **none** (lost on exit) | unit/integration tests, throwaway demos. Same backend `wiki/testing` uses. |
| `file` *(default)* | set | append-only log files + LMDB index | survives restart; each append fsynced before ack | **the durable self-host** at the gentle target scale. |

The mode is opaque to clients — a workspace folded from a `file` host is byte-identical to one
folded in tests; only the durability/perf envelope differs. This is why the engine has **no storage
port** ([wiki/DESIGN.md ADR-001](../wiki/DESIGN.md)): durability lives *here*, not in `wiki`. For
ACID-grade storage, switch to the production tier ([§8.3](#83-production-tiers)); the Node server
does not offer it.

### 7.2 Crash, restart & retention

- File mode persists (fsyncs) each accepted append **before** acking; on restart the server
  rehydrates streams from `dataDir` and clients resume from their saved offsets/snapshots — no
  client change, no loss of acked writes.
- An append that returned 409 was never committed; the client rebases and retries
  ([wiki/DESIGN.md §15](../wiki/DESIGN.md)) — the host adds nothing here.
- `memory` loses everything on exit **by design**; never run a shared host with it.
- **Retention is the client's choice** ([§5.2](#52-the-url-layout-is-the-clients-not-ours)): the
  workspace/snapshot streams use no TTL, so disk grows monotonically with append volume. Bounding it
  (compaction / GC of superseded snapshot messages) is [future work](#12-future-work); v1 assumes
  disk is cheap relative to the target scale.

### 7.3 Backup & restore

Durability is filesystem state, so backup is **filesystem-level**: snapshot the `dataDir` volume
(filesystem/cloud-disk snapshot) for a consistent copy; restore by putting `dataDir` back and
starting `wiki-server` — clients reconnect and re-tail. Quiesce writes (or use a crash-consistent
volume snapshot) for the cleanest copy.

---

## 8. Deployment & operations

### 8.1 Local / embedded (dev)

For tests and single-process dev, you usually **don't run `wiki-server` at all** — `wiki/testing`
embeds a server in the test process. Run the standalone binary only when a separate process needs a
durable host to point at:

```bash
npx wiki-server                      # file storage in ./.wiki-data on 127.0.0.1:4437
# client: createWiki({ stream: { baseUrl: "http://127.0.0.1:4437", namespace: "dev" }, … })
```

The entrypoint is intentionally tiny — boot the server, read back its URL, trap signals:

```ts
// src/main.ts  (sketch)
import { DurableStreamTestServer } from "@durable-streams/server";
import { loadConfig } from "./config";

const cfg = loadConfig(process.argv, process.env);
const server = new DurableStreamTestServer({
  host: cfg.host,
  port: cfg.port,
  longPollTimeout: cfg.longPollTimeout,
  ...(cfg.storage === "file" ? { dataDir: cfg.dataDir } : {}),   // file vs in-memory = dataDir presence
});
await server.start();
console.log(JSON.stringify({ msg: "wiki-server up", baseUrl: server.url, storage: cfg.storage }));

const shutdown = () =>
  server.stop().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, shutdown);
// stop(): drains connections, cancels long-polls/SSE, closes the store. (Each append is already
// fsynced in file mode, so there is no final-flush window to lose.)
```

### 8.2 Standalone shared host

One durable node many clients share, **behind a reverse proxy** that owns TLS + auth ([§9](#9-security)).
The image is a thin Node runtime over `dist/`, binding off-loopback with a mounted data volume:

```dockerfile
# wiki-server/Dockerfile  (sketch)
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY dist ./dist
ENV WIKI_SERVER_HOST=0.0.0.0 WIKI_SERVER_STORAGE=file WIKI_SERVER_DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 4437
USER node
ENTRYPOINT ["node", "dist/main.js"]
```

Run it with a persistent volume for `/data` and a proxy in front; clients point at the proxy's URL.

### 8.3 Production tiers

`wiki-server` wrapping the file-backed Node server is the **simple self-host** tier — adequate at the
engine's gentle target scale (~5 writers, tens–hundreds of pages per workspace,
[wiki/DESIGN.md §6.6](../wiki/DESIGN.md)). When you want ACID storage, vendor support, or scale, the
swap is **server-side only** — clients keep their `baseUrl`: run the upstream **Caddy plugin** /
**Caddy standalone binary** (`DS_STORAGE__MODE`) or **Electric Cloud**, and repoint DNS. See
[ADR-S2](#adr-s2--wrap-the-node-server-for-the-self-host-tier-2026-06-01).

### 8.4 Operations

- **Health:** the wrapped server exposes no health endpoint, so liveness is a **TCP/HTTP check on
  the port** (or a cheap `GET` of a known stream). If you want `/healthz`/`/readyz`, terminate them
  in the proxy or add a tiny separate health listener; don't expect them from the stream server.
- **Logs:** structured (`json` off-TTY) — startup (host/port/storage/baseUrl), lifecycle hooks
  (`onStreamCreated`/`onStreamDeleted`), graceful-shutdown progress.
- **Capacity:** the bottlenecks at target scale are disk (monotonic, [§7.2](#72-crash-restart--retention))
  and live-tail fan-out — both gentle by design. Watch `dataDir` size.
- **Upgrades:** `wiki-server` and `wiki` version **independently** (G2) as long as the
  `@durable-streams` wire protocol matches. Roll by draining (`stop()` → restart on the same
  `dataDir`); clients transparently reconnect and resume from their offsets.

---

## 9. Security

The wrapped server has **no request-level auth and no TLS** ([§4](#4-the-durable-streamsserver-it-wraps)),
so a reachable port means **anyone who can route to it can read/write any stream**. v1 keeps this
pragmatic and explicit:

- **Local / loopback (default): no auth, no proxy.** Bound to `127.0.0.1`, `wiki-server` runs open —
  the intended frictionless local experience. Skipping security here is correct, not a gap.
- **Shared / networked: front it with a reverse proxy.** Bind `wiki-server` to loopback (or a private
  interface) and put Caddy/nginx/an LB in front to terminate **TLS** and enforce a **bearer token**
  (and, if wanted, a request body-size cap and per-namespace path rules). Clients send the token via
  their `@durable-streams/client` request headers and use an `https://` `baseUrl`.

```caddyfile
# example front (sketch): TLS + a shared bearer token, proxying to a loopback wiki-server
wiki.example.com {
  @unauth not header Authorization "Bearer {env.WIKI_TOKEN}"
  respond @unauth 401
  reverse_proxy 127.0.0.1:4437
}
```

**Deliberately deferred** ([§12](#12-future-work)): per-namespace tokens, per-actor identity, and
read-vs-write scopes. The guiding rule mirrors the engine — **authorization lives above the
substrate**, here literally in front of it.

> ⚠️ Binding to `0.0.0.0` **without** a proxy publishes every stream to anyone who can reach the
> port. `loadConfig` logs a prominent warning when `host` is non-loopback, since the host itself
> cannot authenticate.

---

## 10. Package structure

A new sibling in the monorepo ([wiki/DESIGN.md §16](../wiki/DESIGN.md)). It depends on
`@durable-streams/server` as a **runtime** dependency (in `wiki/` that package is a *devDependency*,
used only by the test server — the contrast captures the whole relationship). It does **not** list
`wiki` as a dependency. The code is deliberately minimal — config + a boot entrypoint:

```
.
├─ wiki/                         # the engine (transport-free; a CLIENT of the stream host)
└─ wiki-server/                  # ← THIS package — the durable stream host
    ├─ package.json             # name "wiki-server"; dep @durable-streams/server; bin → dist/main.js
    ├─ DESIGN.md                # ← this document
    ├─ Dockerfile
    └─ src/
        ├─ main.ts              # entrypoint: load config → start server → log baseUrl → trap signals
        └─ config.ts            # WikiServerConfig + resolve(flags, env, defaults)
```

**Boundaries that keep it honest:**

- **`wiki-server` never imports `wiki`** (or any `wiki/*` subpath) — enforced by lint and by the
  absent dependency. If you feel the urge to import a wiki type here, the design has gone wrong
  ([ADR-S1](#adr-s1--host-streams-do-not-wrap-the-engine-2026-06-01)).
- **All wiki-specific knowledge stays in the client** (`wiki/src/stores/event-log.ts`): URL layout,
  envelopes, OCC seq mapping, snapshot/catalog streams ([§5](#5-the-client-contract)).
- Add `wiki-server` to the root `workspaces` array; it extends `tsconfig.base.json` like the engine.

---

## 11. Testing strategy

`wiki-server` is thin, so its tests assert the **host behaves** — using `@durable-streams/client`
directly, with **no `wiki` import** (G2). The engine's own suite already exercises the protocol
against an in-memory server ([wiki/DESIGN.md §17](../wiki/DESIGN.md)); a full client/host round-trip
belongs there (point a `createWiki` at a real `wiki-server`), not in this package.

- **Smoke (per mode):** boot on an ephemeral port → `POST` a JSON array message → `GET` it back as
  one message → a `live:true` tail sees a subsequent append. Run for `memory` and `file`.
- **Durability (the reason this package exists):** in `file` mode, append → `stop()` → `start()` on
  the same `dataDir` → the message is still readable. `memory` can't provide this.
- **OCC pass-through:** two appends at the same `Stream-Seq` → first `200`, second `409`. Confirms
  the client's `StaleAppendError`/rebase path has a real server to react to.
- **Config resolution:** flags override env override defaults; `storage` toggles `dataDir`
  presence; non-loopback `host` emits the warning.

---

## 12. Future work

- **Auth surface** — graduate [§9](#9-security) beyond a single proxy-checked token: per-namespace
  tokens, actor identity, read/write scopes, access audit.
- **Compaction / retention tooling** — drop events below a durable snapshot; GC superseded snapshot
  messages ([§7.2](#72-crash-restart--retention)).
- **ACID / managed tier as a first-class deployment** — the Caddy/Electric Cloud path documented and
  scripted, not just an escape hatch ([§8.3](#83-production-tiers)).
- **Health/metrics** — an optional sidecar or proxy-level `/healthz` + Prometheus metrics.
- **Backup automation** — scheduled, consistent `dataDir` snapshots with retention.

---

## 13. References

- Durable Streams — Concepts: <https://durablestreams.com/concepts>
- Durable Streams — Deployment / server (storage modes, `DS_STORAGE__MODE`, Caddy): <https://durablestreams.com/deployment>
- `@durable-streams/server` (npm; README scopes it to dev/test/prototyping): <https://www.npmjs.com/package/@durable-streams/server>
- Electric Cloud (hosted) & Durable Streams 0.1.0: <https://electric-sql.com/blog/2025/12/23/durable-streams-0.1.0>
- Engine design (the client): [`wiki/DESIGN.md`](../wiki/DESIGN.md) · verified storage behavior: [`wiki/BUILD_NOTES.md`](../wiki/BUILD_NOTES.md)

---

## Appendix A: Decision records

### ADR-S1 — Host streams; do not wrap the engine (2026-06-01)

**Context.** The original plan had a `wiki-api/` sibling exposing the engine's command catalog over
HTTP/RPC+SSE. Revisiting "where does the durable stream actually run?" reframed the real need.

**Findings.** The engine is *already* a complete application that talks to storage over HTTP via
`@durable-streams/client`. What's missing for any shared, multi-process setup isn't an API in front
of the engine — it's a **durable server behind it**. You don't wrap the streams; you **run `wiki`
wherever you want and point every instance at the same stream host.**

**Decision.** `wiki-server/` is that host: a thin, durable deployment of `@durable-streams/server`.
It imports `@durable-streams/server`, **not** `wiki`, and has no engine knowledge. **`wiki-api/` is
removed from the plan** (struck from `wiki/DESIGN.md` §2/§5/§16/§18).

**Consequences.** Engine and host evolve independently (only the wire protocol couples them). All
wiki-specific structure (URL layout, envelopes, OCC) stays in the client. A CLI (`wiki-cli/`) remains
a separate, genuine *consumer* of the engine — unaffected.

### ADR-S2 — Wrap the Node server for the self-host tier (2026-06-01)

**Context.** Which server does `wiki-server` run? `@durable-streams/server`'s own README scopes it to
"development, testing, and prototyping" and recommends the **Caddy plugin / Electric Cloud / Caddy
standalone binary** for production; [wiki/DESIGN.md ADR-001](../wiki/DESIGN.md) echoes the dev/test/
embedding framing. The Node package also offers only **in-memory and file-backed** storage — no
ACID/redb, no request middleware.

**Decision.** v1 `wiki-server` wraps **`DurableStreamTestServer`** with **file-backed** storage as a
**simple, durable self-host**, with a `bin`, config, and a container. Default storage is `file`;
`memory` is the dev switch. **Auth/TLS are delegated to a reverse proxy** ([§9](#9-security)), since
the server has no middleware. ACID and managed operation are reached by swapping to the production
tier — a **server-side-only** change (clients keep their `baseUrl`, [§8.3](#83-production-tiers)).

**Why this is acceptable despite the upstream framing.** At the engine's *gentle* target scale, a
file-backed node that fsyncs every append before ack is genuinely durable and far simpler than
standing up Caddy. We treat the production tier as a drop-in upgrade rather than a prerequisite, and
we do **not** overclaim: there is no ACID tier in this package, and durability/ops guarantees are
those of file-backed LMDB + append-only logs, nothing more.

**Consequences.** Right-sized for this scale, not a ceiling; monotonic disk growth until compaction
lands ([§7.2](#72-crash-restart--retention)); security depends on the proxy being present whenever the
host is exposed ([§9](#9-security)).
