# wiki-server — Design Document

> Status: **Draft / living document** · Last updated: 2026-06-02 · Owner: @benjamin
>
> The deployable that **hosts the durable streams and hosts [`wiki-mcp`](../wiki-mcp/DESIGN.md)**.
> `wiki-server/` runs a standalone [Durable Streams](https://durablestreams.com/concepts) server with
> durable storage at a stable address, *and* starts `wiki-mcp` in the same process — the module that
> holds the engine, the SQL read model, and the MCP surface. `wiki-server` itself stays **thin**: it
> **wires** the two together and implements neither's logic. It imports `@durable-streams/server` and
> `wiki-mcp` — **never `wiki` directly** — and owns no business logic of its own.

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

`wiki-server` plays two roles in one process: it is the **durable substrate** (the stream host that
serves those URLs), and it **hosts `wiki-mcp`** — the long-lived module that keeps the engine
hydrated, maintains the SQL read model, and exposes the MCP surface to agents
([wiki-mcp/DESIGN.md](../wiki-mcp/DESIGN.md)). The discipline: `wiki-server` *wires*, it does not
*implement* — all engine/read-model/MCP logic lives in `wiki-mcp`, and the stream-hosting logic is
the wrapped `@durable-streams/server`. (Raw `wiki` clients can still point at the stream URLs
directly; `wiki-mcp` is just the long-lived consumer hosted alongside.)

### Goals

- **G1 — Host, don't implement.** Run one Durable Streams server (durable storage, stable base URL)
  **and** host `wiki-mcp` — but implement neither's logic in `wiki-server`'s own code. `wiki-server`
  is wiring: boot the stream host, start `wiki-mcp`, hand it the local `baseUrl`/namespace + DB config.
- **G2 — Logic lives in `wiki-mcp`, not here.** `wiki-server` depends on `@durable-streams/server`
  and `wiki-mcp`, and **must not import `wiki` directly** — it reaches the engine only through the
  `wiki-mcp` it hosts. It *knows* it has an engine; it does not *own* the engine logic. The
  stream-host layer still speaks only the Durable Streams wire protocol, so **storage stays
  swappable** even though the bundled backend (engine + read model) ships with the host
  ([ADR-S3](#adr-s3--wiki-server-hosts-wiki-mcp-2026-06-02)).
- **G3 — One shared stream, many clients.** Multiple `wiki` instances connect concurrently and
  rely on the server's per-stream ordering and optimistic concurrency ([§5](#5-the-client-contract))
  for correctness — the server is the synchronization point.
- **G4 — Durable by default.** File-backed storage out of the box; in-memory is a one-line switch
  for dev/test ([§7](#7-storage--durability)).
- **G5 — Trivial locally, sane when shared.** `npx wiki-server` boots a durable host with no
  config; a container image plus a reverse proxy cover the shared case ([§8](#8-deployment--operations)).

---

## 2. Non-goals

- **`wiki-server` itself implements no engine API.** It doesn't wrap `wiki` in HTTP/RPC, validate
  commands, or know what a "page" is — that surface (MCP) and the engine live in the **hosted
  `wiki-mcp`**, not in `wiki-server`'s code. (The rejected `wiki-api/` was *`wiki-server` itself*
  becoming an engine wrapper; hosting a separate `wiki-mcp` module is different — see
  [ADR-S1](#adr-s1--host-streams-do-not-wrap-the-engine-2026-06-01) / [ADR-S3](#adr-s3--wiki-server-hosts-wiki-mcp-2026-06-02).)
- **No knowledge of the URL layout in the stream host.** The workspace/snapshot/catalog path shapes
  are a **client-side convention** ([§5.2](#52-the-url-layout-is-the-clients-not-ours)); the stream
  host serves whatever URLs clients create.
- **No projections / read models in `wiki-server`'s own code.** Those live in the hosted `wiki-mcp`
  (a SQL read model over the engine, [wiki-mcp/DESIGN.md](../wiki-mcp/DESIGN.md)) — `wiki-server` hosts
  it but implements none of it.
- **No in-server auth / TLS / rate limiting.** The wrapped server has no request middleware
  ([§4](#4-the-durable-streamsserver-it-wraps)); those are a reverse proxy's job ([§9](#9-security)).
- **Not a CRDT or merge engine.** Ordering and conflict detection are per-stream and native; the
  engine handles rebase-and-retry on top ([wiki/DESIGN.md §15](../wiki/DESIGN.md)).
- **Not a horizontally-scaled cluster.** One durable node at the engine's *gentle* target scale
  ([wiki/DESIGN.md §6.6](../wiki/DESIGN.md)); scale/hardening is a server-side swap to the production
  tier ([§8.3](#83-production-tiers)).

---

## 3. What wiki-server is

In one sentence: **`wiki-server` is one deployable that runs `@durable-streams/server` (durable
storage, stable bind, `bin`, container) *and* starts `wiki-mcp` in the same process.** The
stream-host half stays **content-agnostic** — the URL layout, envelopes, folding, OCC all live in the
client/engine ([§5](#5-the-client-contract)) — while the engine + read model + MCP surface live in the
hosted `wiki-mcp` ([§3.1](#31-hosting-wiki-mcp)). `wiki-server`'s own code is just the wiring.

```
   LLM agents ──MCP──►  ┌──────────────── wiki-server process ────────────────┐
   (tools / resources)  │  hosts BOTH (wiki-server = thin wiring):             │
                        │                                                      │
   raw wiki clients     │   wiki-mcp ── engine (hydrated) + SQL read model     │
   ──@durable-streams──►│              + projection + MCP server               │
                        │       │ tails localhost streams → read model         │
                        │       ▼                                              │
                        │   @durable-streams/server ── durable stream host     │
                        │              (log per URL · OCC · live tail · file)  │
                        └───────┬──────────────────────────────┬───────────────┘
                                │ stream dataDir (logs + LMDB)  │ wiki-mcp DB (PGlite/pg)
                        ┌───────▼────────┐             ┌────────▼────────┐
                        │  stream dataDir│             │  read-model DB  │
                        └────────────────┘             └─────────────────┘
```

### 3.1 Hosting wiki-mcp

`wiki-server`'s entrypoint boots the stream host, then starts `wiki-mcp` **in-process**, passing it the
**localhost** stream `baseUrl`/namespace and the read-model DB config. From there `wiki-mcp` owns
everything engine-facing: it opens the engine as a library, tails the local streams to project them into
its SQL read model (PGlite locally, Postgres in prod), and serves the MCP surface to agents — all
detailed in [wiki-mcp/DESIGN.md](../wiki-mcp/DESIGN.md). `wiki-server` neither imports `wiki` nor
implements any of that; it just supplies the durable streams and the process to run `wiki-mcp` in. The
two halves share one lifecycle: a single `start`, a single graceful `stop` ([§8.1](#81-local--embedded-dev)).
It also hands `wiki-mcp` its **logger** ([§8.5](#85-logging--the-log-api)), so engine/projection telemetry
is consolidated with the stream host's into one log stream the host exposes.

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
  So **auth, TLS, and body caps are a front layer's job** ([§9](#9-security)); and since the wrapped
  server hosts **no extra paths**, `wiki-server` runs its **own small control listener** for the
  log/health API ([§8.5](#85-logging--the-log-api)) — its only non-trivial code beyond wiring.
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
the stream host stay a generic, swappable substrate ([ADR-S3](#adr-s3--wiki-server-hosts-wiki-mcp-2026-06-02)).

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
  /** Port for the control listener (log/health API, §8.5). Default port+1 (4438). */
  readonly controlPort: number;
  /** History ring-buffer size for `GET /_server/logs` (§8.5). Default 1000 records. */
  readonly logBuffer: number;
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
| `--control-port` | `WIKI_SERVER_CONTROL_PORT` | `4438` | The log/health API listener ([§8.5](#85-logging--the-log-api)); behind the proxy when shared. |
| `--log-buffer` | `WIKI_SERVER_LOG_BUFFER` | `1000` | Records retained for `GET /_server/logs` history. |

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

- **Health & logs:** served by `wiki-server`'s **control listener** ([§8.5](#85-logging--the-log-api)):
  `GET /_server/health` (liveness/readiness — this closes the old "no health endpoint" gap) and
  `GET /_server/logs` (consolidated history + SSE tail of the stream host **and** `wiki-mcp`).
- **Capacity:** the bottlenecks at target scale are disk (monotonic, [§7.2](#72-crash-restart--retention))
  and live-tail fan-out — both gentle by design. Watch `dataDir` size.
- **Upgrades:** the **stream-host/storage layer** stays swappable behind the wire protocol
  ([§8.3](#83-production-tiers)), but `wiki-mcp` + the engine now ship **bundled** with `wiki-server`
  ([ADR-S3](#adr-s3--wiki-server-hosts-wiki-mcp-2026-06-02)) — version them together. Roll by draining
  (`stop()` the stream host **and** `wiki-mcp`, restart on the same `dataDir`); stream clients reconnect
  and resume from their offsets, and `wiki-mcp` resumes its read model from its applied position.

### 8.5 Logging & the log API

`wiki-server` owns a single **consolidating logger** and exposes it over a small **log API** — the host
is the natural place to unify telemetry from *both* planes it runs (the stream host **and** `wiki-mcp`).

**The logger.** `wiki-server` constructs one structured `Logger` that fans every record out three ways:
to **stdout** (`json` off-TTY), to a **bounded in-memory history ring buffer** (`--log-buffer`, default
1000), and to any **live tail subscribers**. Three sources feed it:

- its **own** lifecycle (startup / config / shutdown);
- the **stream host's** lifecycle hooks (`onStreamCreated` / `onStreamDeleted`, [§4](#4-the-durable-streamsserver-it-wraps)) — the operationally meaningful stream events; and
- **`wiki-mcp`'s** logs, by passing this logger in as `wiki-mcp`'s injected `Logger`
  ([wiki-mcp/DESIGN.md §9](../wiki-mcp/DESIGN.md)) — so engine / projection / MCP telemetry lands in the
  same stream.

Each record is `{ seq, boot, ts, level, source, msg, …fields }`: `seq` is a monotonic per-process counter;
`boot` identifies the process (so a tail detects a restart and resyncs rather than gapping); `source` ∈
`server | stream | mcp` tags origin. (The wrapped server still writes some *internal* chatter straight to
stdout — it accepts no logger — so those lines aren't in the buffer; everything `wiki-server` and
`wiki-mcp` emit is.)

**This is not a Durable Stream.** Logs are **ephemeral operational data**, deliberately kept off the
durable, event-sourced stream plane — a bounded ring buffer, not a retained log.

**The control listener.** The wrapped `DurableStreamTestServer` can host no extra paths
([§4](#4-the-durable-streamsserver-it-wraps)), so `wiki-server` runs its **own** `http.createServer` on
`--control-port` (default `4438` = stream port + 1), serving:

| Method · path | Purpose | Response |
|---|---|---|
| `GET /_server/logs?since=<seq>&boot=<id>&limit=<n>&level=<lvl>&source=<src>` | log **history** from the ring buffer | `200` JSON `{ boot, records: LogRecord[], next: seq, truncated?: bool }` |
| `GET /_server/logs?follow=1&since=<seq>&boot=<id>` | log **tail** (backlog then live) | `200 text/event-stream` (SSE), one `LogRecord` per event |
| `GET /_server/health` | liveness/readiness (closes the old gap) | `200 {status:"ok"}` / `503` |
| `GET /_server/info` | server facts | `200 { version, boot, storage, baseUrl, pid, uptimeMs }` |

The control listener has **no built-in auth** either, so for a shared deploy it sits **loopback-only
behind the same reverse proxy**, which routes `/_server/*` to the control port and stream traffic to the
stream port — both behind one bearer-token check ([§9](#9-security)).

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
# example front (sketch): TLS + a shared bearer token, in front of a loopback wiki-server
wiki.example.com {
  @unauth not header Authorization "Bearer {env.WIKI_TOKEN}"
  respond @unauth 401
  handle_path /_server/* { reverse_proxy 127.0.0.1:4438 }   # log/health control API (§8.5)
  reverse_proxy 127.0.0.1:4437                               # stream traffic
}
```

The **control listener** ([§8.5](#85-logging--the-log-api)) has no built-in auth either, so it binds
**loopback-only** and the proxy routes `/_server/*` to it — same token, same edge.

**Deliberately deferred** ([§12](#12-future-work)): per-namespace tokens, per-actor identity, and
read-vs-write scopes. The guiding rule mirrors the engine — **authorization lives above the
substrate**, here literally in front of it.

> ⚠️ Binding to `0.0.0.0` **without** a proxy publishes every stream to anyone who can reach the
> port. `loadConfig` logs a prominent warning when `host` is non-loopback, since the host itself
> cannot authenticate.

---

## 10. Package structure

A sibling in the monorepo ([wiki/DESIGN.md §16](../wiki/DESIGN.md)). Runtime deps:
`@durable-streams/server` (the stream host) **and `wiki-mcp`** (the hosted engine/read-model/MCP
module). It does **not** depend on `wiki` *directly* — it reaches the engine only through `wiki-mcp`.
`wiki-server`'s own code stays minimal — config + a boot entrypoint that starts both:

```
.
├─ wiki/                         # the engine (transport-free; consumed by wiki-mcp)
├─ wiki-mcp/                     # hosted module: engine + SQL read model + projection + MCP server
└─ wiki-server/                  # ← THIS package — hosts the streams AND wiki-mcp
    ├─ package.json             # name "wiki-server"; deps @durable-streams/server, wiki-mcp; bin → dist/main.js
    ├─ DESIGN.md                # ← this document
    ├─ Dockerfile
    └─ src/
        ├─ main.ts              # config → logger → start stream host → start wiki-mcp(logger) → control listener → signals
        ├─ config.ts            # WikiServerConfig (+ wiki-mcp namespace/db knobs, control-port, log-buffer)
        ├─ logger.ts            # consolidating Logger: stdout + ring buffer + subscribers (§8.5)
        └─ control.ts           # control HTTP listener: /_server/logs · /_server/health · /_server/info (§8.5)
```

**Boundaries that keep it honest:**

- **`wiki-server` never imports `wiki` *directly*** (only via `wiki-mcp`) and **implements no engine
  logic**. If you feel the urge to write a fold, a projection, or a command handler here, it belongs in
  `wiki-mcp` ([ADR-S3](#adr-s3--wiki-server-hosts-wiki-mcp-2026-06-02)).
- **Stream-host knowledge stays minimal:** the URL layout, envelopes, and OCC mapping live in the
  engine's client (`wiki/src/stores/event-log.ts`, [§5](#5-the-client-contract)); the stream host just
  serves arbitrary stream URLs.
- Add `wiki-server` to the root `workspaces` array; it extends `tsconfig.base.json` like the engine.

---

## 11. Testing strategy

`wiki-server` is thin, so its tests assert the **stream host behaves** — using `@durable-streams/client`
directly (no `wiki` import). The engine's suite exercises the protocol against an in-memory server
([wiki/DESIGN.md §17](../wiki/DESIGN.md)), and `wiki-mcp` owns the engine/read-model/MCP tests
([wiki-mcp/DESIGN.md §11](../wiki-mcp/DESIGN.md)); `wiki-server`'s own tests cover only the host plus a
**wiring smoke test** — boot the process, confirm the stream host serves and `wiki-mcp`'s MCP endpoint
answers.

- **Smoke (per mode):** boot on an ephemeral port → `POST` a JSON array message → `GET` it back as
  one message → a `live:true` tail sees a subsequent append. Run for `memory` and `file`.
- **Durability (the reason this package exists):** in `file` mode, append → `stop()` → `start()` on
  the same `dataDir` → the message is still readable. `memory` can't provide this.
- **OCC pass-through:** two appends at the same `Stream-Seq` → first `200`, second `409`. Confirms
  the client's `StaleAppendError`/rebase path has a real server to react to.
- **Config resolution:** flags override env override defaults; `storage` toggles `dataDir`
  presence; non-loopback `host` emits the warning.
- **Log API & consolidation:** a `wiki-mcp`-sourced record (via the injected logger) shows up in
  `GET /_server/logs`; a `follow=1` SSE tail receives a later record; `/_server/health` and
  `/_server/info` answer; history honors `since`/`boot`/`source` ([§8.5](#85-logging--the-log-api)).

---

## 12. Future work

- **Auth surface** — graduate [§9](#9-security) beyond a single proxy-checked token: per-namespace
  tokens, actor identity, read/write scopes, access audit.
- **Compaction / retention tooling** — drop events below a durable snapshot; GC superseded snapshot
  messages ([§7.2](#72-crash-restart--retention)).
- **ACID / managed tier as a first-class deployment** — the Caddy/Electric Cloud path documented and
  scripted, not just an escape hatch ([§8.3](#83-production-tiers)).
- **Metrics** — a `/_server/metrics` (Prometheus) endpoint on the control listener
  ([§8.5](#85-logging--the-log-api)); health + logs already ship there.
- **Backup automation** — scheduled, consistent `dataDir` snapshots with retention.

---

## 13. References

- Durable Streams — Concepts: <https://durablestreams.com/concepts>
- Durable Streams — Deployment / server (storage modes, `DS_STORAGE__MODE`, Caddy): <https://durablestreams.com/deployment>
- `@durable-streams/server` (npm; README scopes it to dev/test/prototyping): <https://www.npmjs.com/package/@durable-streams/server>
- Electric Cloud (hosted) & Durable Streams 0.1.0: <https://electric-sql.com/blog/2025/12/23/durable-streams-0.1.0>
- Engine: [`wiki/DESIGN.md`](../wiki/DESIGN.md) · hosted module: [`wiki-mcp/DESIGN.md`](../wiki-mcp/DESIGN.md) · verified storage behavior: [`wiki/BUILD_NOTES.md`](../wiki/BUILD_NOTES.md)

---

## Appendix A: Decision records

### ADR-S1 — Host streams; do not wrap the engine (2026-06-01)

**Context.** The original plan had a `wiki-api/` sibling exposing the engine's command catalog over
HTTP/RPC+SSE. Revisiting "where does the durable stream actually run?" reframed the real need.

**Findings.** The engine is *already* a complete application that talks to storage over HTTP via
`@durable-streams/client`. What's missing for any shared, multi-process setup isn't an API in front
of the engine — it's a **durable server behind it**. You don't wrap the streams; you **run `wiki`
wherever you want and point every instance at the same stream host.**

**Decision.** `wiki-server/` is that host: a durable deployment of `@durable-streams/server`. It does
not *itself* wrap the engine in an HTTP/RPC API. **`wiki-api/` is removed from the plan** (struck from
`wiki/DESIGN.md` §2/§5/§16/§18). *(Later — [ADR-S3](#adr-s3--wiki-server-hosts-wiki-mcp-2026-06-02) —
`wiki-server` additionally **hosts** the `wiki-mcp` module, which embeds the engine and exposes MCP;
hosting a separate module is distinct from `wiki-server` itself becoming the engine wrapper that
`wiki-api` would have been.)*

**Consequences.** The *stream-host layer* and the engine couple only through the wire protocol — URL
layout, envelopes, OCC stay in the client. The agent-facing surface is **`wiki-mcp`**, hosted by
`wiki-server` ([ADR-S3](#adr-s3--wiki-server-hosts-wiki-mcp-2026-06-02)) — superseding the earlier
sketch of `wiki-cli` as the primary consumer.

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

### ADR-S3 — wiki-server hosts wiki-mcp (2026-06-02)

**Context.** A stateless consumer re-folds history per call (a non-starter); the long-lived **`wiki-mcp`**
module (engine kept hydrated + SQL read model + MCP server, [wiki-mcp/DESIGN.md](../wiki-mcp/DESIGN.md))
replaces it. Where does it run?

**Decision.** `wiki-server` **hosts `wiki-mcp` in the same process** — one deployable runs the durable
stream host *and* `wiki-mcp`. There are **no modes**. `wiki-server` stays a **thin wiring layer**: it
boots the stream host, then starts `wiki-mcp` (handing it the localhost `baseUrl`/namespace + the
read-model DB config); the projection tailer reads localhost streams. **All engine/read-model/MCP logic
lives in `wiki-mcp`**, never in `wiki-server`.

**Consequences — a deliberate charter relaxation.** This **softens G1/G2**: `wiki-server` now
transitively depends on the engine (via `wiki-mcp`), so it is no longer "imports nothing but
`@durable-streams/server`," and the **backend** (engine + read model + MCP) no longer versions
independently of the host — they ship together ([§8.4](#84-operations)). Preserved discipline:
`wiki-server` imports `wiki-mcp` (not `wiki` directly) and implements **no** engine logic of its own;
and the **stream-host/storage layer** remains a swappable, content-agnostic substrate (server-side-only
swap to the production tier, [ADR-S2](#adr-s2--wrap-the-node-server-for-the-self-host-tier-2026-06-01) /
[§8.3](#83-production-tiers)). The host *knowing* it has an engine is fine; *owning* the logic is not.
