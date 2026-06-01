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
3. [What wiki-server is (and is not)](#3-what-wiki-server-is-and-is-not)
4. [Background: what `@durable-streams/server` provides](#4-background-what-durable-streamsserver-provides)
5. [The client contract](#5-the-client-contract)
6. [Configuration](#6-configuration)
7. [Storage & durability](#7-storage--durability)
8. [Deployment](#8-deployment)
9. [Security (optional, off by default)](#9-security-optional-off-by-default)
10. [Operations](#10-operations)
11. [Package structure](#11-package-structure)
12. [Testing strategy](#12-testing-strategy)
13. [Future work](#13-future-work)
14. [References](#14-references)
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
  protocol. Either side can be upgraded or replaced independently.
- **G3 — One shared stream, many clients.** Multiple `wiki` instances (CLI, app, agents) connect
  concurrently and rely on the server's per-stream ordering and optimistic-concurrency
  ([§5](#5-the-client-contract)) for correctness — the server is the synchronization point.
- **G4 — Durable by default, configurable.** File-backed storage out of the box; `memory` for
  dev/test and `acid` for the strongest guarantees are a one-line switch ([§7](#7-storage--durability)).
- **G5 — Trivial to run locally, sane to run shared.** `npx wiki-server` boots a durable host with
  no config; a container image and a small config surface cover the shared case ([§8](#8-deployment)).
- **G6 — Operable.** Health checks, structured logs, a documented backup/restore story, and
  predictable disk growth ([§10](#10-operations)).

---

## 2. Non-goals

- **Not an API over the engine.** `wiki-server` does **not** wrap `wiki` in HTTP/RPC, expose the
  command catalog, validate commands, or know what a "page" is. (This supersedes the earlier
  `wiki-api/` idea, now struck from the plan — see [ADR-S1](#adr-s1--host-streams-do-not-wrap-the-engine-2026-06-01).)
- **No knowledge of the URL layout.** The `/workspace/{id}` · `/snapshot` · `_catalog` structure is
  a **client-side convention** built in `EventLog` ([§5.2](#52-the-url-layout-is-the-clients-not-ours)).
  The server hosts whatever stream URLs clients create.
- **No projections / read models / search.** Those are engine concerns above the stream
  ([wiki/DESIGN.md §18](../wiki/DESIGN.md)).
- **Not a CRDT or merge engine.** Ordering and conflict detection are per-stream and native to
  Durable Streams; `wiki` handles rebase-and-retry on top ([wiki/DESIGN.md §15](../wiki/DESIGN.md)).
- **No bespoke auth/identity system in v1.** Optional bearer-token gating only; richer access
  control is future work ([§9](#9-security-optional-off-by-default), [§13](#13-future-work)).
- **Not a horizontally-scaled cluster.** One durable node at the engine's *gentle* target scale
  ([wiki/DESIGN.md §6.6](../wiki/DESIGN.md)). Scale-out is an explicit escape hatch
  ([ADR-S2](#adr-s2--wrap-durable-streamsserver-for-production-2026-06-01)).

---

## 3. What wiki-server is (and is not)

```
   wiki client          wiki client            wiki client
   (CLI on a laptop)    (web app on a box)     (LLM agent in CI)
        │                     │                      │
        │  @durable-streams/client (fetch: POST append · GET read · GET live tail)
        └──────────────┬──────┴───────────┬──────────┘
                       │  HTTP, same baseUrl
            ┌──────────▼───────────────────────────────┐
            │  wiki-server  (this package)               │
            │  ── thin wrapper over ──                   │
            │  @durable-streams/server                   │
            │    • one durable node, stable bind addr    │
            │    • append-only log per stream URL        │
            │    • offsets · Stream-Seq OCC · live tail  │
            │    • storage: file (default) · memory · acid
            │    • (optional) bearer-token gate          │
            └──────────────┬─────────────────────────────┘
                           │
                  ┌────────▼─────────┐
                  │  disk / dataDir   │  log files + index (file/acid)
                  └───────────────────┘
```

In one sentence: **`wiki-server` is `@durable-streams/server` configured for durable, shared,
production use and given a `bin` and a container** — the thing that "hosts that part." Everything
that makes it *the wiki's* host (the workspace/snapshot/catalog URL shapes, event envelopes,
folding, OCC versioning) lives in the **client** ([§5](#5-the-client-contract)); the server is
content-agnostic.

---

## 4. Background: what `@durable-streams/server` provides

Verified facts (`@durable-streams/server@0.3.5`, cross-checked in
[wiki/BUILD_NOTES.md §1](../wiki/BUILD_NOTES.md)):

- **A stream is an append-only, durable, strictly-ordered sequence at its own URL.** In JSON mode
  the content type is `application/json`. **One `append()` stores exactly one message** (the whole
  posted body); a posted JSON array is **not** split into per-element messages. `GET` returns one
  item per message for the requested range.
- **`Stream-Seq` gives strict-greater optimistic concurrency.** An append with `seq ≤ lastSeq` is
  rejected as **HTTP 409**. This is what the client turns into `StaleAppendError` →
  rebase-and-retry ([wiki/DESIGN.md §15](../wiki/DESIGN.md)). The server is the authority on order.
- **Offsets are opaque, lexicographically-sortable resume cursors.** Reads resume from a saved
  offset; live tailing is via **long-poll or SSE**.
- **Storage durability is a server setting:** `memory` (default in the test server), `file` (log
  files + LMDB index), or `acid` (redb). Picking it is the server operator's job — exactly the knob
  `wiki-server` owns ([§7](#7-storage--durability)).
- **`@durable-streams/server` is an embeddable Node server.** `wiki/testing` already embeds the
  in-memory `DurableStreamTestServer` for the suite; `wiki-server` runs the **same family**
  long-lived with durable storage and a fixed bind address.

> **Upstream API surface.** This doc uses representative names (`DurableStreamServer`,
> `start()`/`stop()`). The exact exported entrypoint and option names are pinned against the
> installed `@durable-streams/server` version at build time; the *shape* (a constructor taking
> `{ storage, dataDir, host, port }` plus `start`/`stop`) is the contract `wiki-server` targets.

---

## 5. The client contract

The "interface" between `wiki` and `wiki-server` is **not TypeScript** — it is the Durable Streams
HTTP protocol plus a handful of conventions the client owns. Keeping these on the client is what
lets the server stay a generic, swappable stream host (G2).

### 5.1 What the client relies on the server for

| Guarantee | Owned by | Used by the engine for |
|---|---|---|
| Per-stream **append-only ordering** | server | fold order == per-workspace `version` ([wiki/DESIGN.md §8.1](../wiki/DESIGN.md)) |
| **Atomic** single-message append | server | a command's events committed as one array-message ([wiki/BUILD_NOTES.md §1](../wiki/BUILD_NOTES.md)) |
| **`Stream-Seq` 409** on stale append | server | optimistic concurrency → rebase-and-retry ([wiki/DESIGN.md §15](../wiki/DESIGN.md)) |
| **Durable** retention of every message | server (storage mode) | history is the source of truth; replay/time-travel |
| **Live tail** (long-poll / SSE) | server | one tail, all updates — G6 ([wiki/DESIGN.md §8.4](../wiki/DESIGN.md)) |

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
  namespaces (if wanted) is enforced at the edge via auth/routing ([§9](#9-security-optional-off-by-default)),
  never by the stream host.
- **Adding stream kinds is a client change only.** If the engine later adds, say, a per-workspace
  index stream, `wiki-server` needs no change.
- **Retention is per-stream and chosen by the client** at create time (`ttlSeconds`); workspace and
  snapshot streams are created with **no TTL** (infinite retention — [wiki/DESIGN.md §9.1](../wiki/DESIGN.md)).
  `wiki-server` honors whatever the client sets; it does not impose its own expiry ([§7.3](#73-retention--disk-growth)).

---

## 6. Configuration

A small, flat config resolved from **flags → env → file → defaults** (first wins). Everything has a
working default so `wiki-server` runs with none.

```ts
// src/config.ts
export interface WikiServerConfig {
  /** Bind address. Default "127.0.0.1" (loopback — explicit opt-in to expose). */
  readonly host: string;
  /** Port. Default 4437. */
  readonly port: number;
  /** Storage durability mode. Default "file". */
  readonly storage: "memory" | "file" | "acid";
  /** Filesystem path for file/acid storage. Default "./.wiki-data". Ignored for "memory". */
  readonly dataDir: string;
  /** Optional bearer token; when set, every request must present it (§9). Default: unset (open). */
  readonly authToken?: string;
  /** Max request body bytes (a commit = one array-message). Default 8 MiB. */
  readonly maxBodyBytes: number;
  /** Log format. Default "pretty" on a TTY, else "json". */
  readonly logFormat: "pretty" | "json";
}
```

| Flag | Env | Default | Notes |
|---|---|---|---|
| `--host` | `WIKI_SERVER_HOST` | `127.0.0.1` | Set `0.0.0.0` to accept non-local clients (then read [§9](#9-security-optional-off-by-default)). |
| `--port` | `WIKI_SERVER_PORT` | `4437` | The `baseUrl` clients point at is `http(s)://{host}:{port}`. |
| `--storage` | `WIKI_SERVER_STORAGE` | `file` | `memory` \| `file` \| `acid` ([§7](#7-storage--durability)). |
| `--data-dir` | `WIKI_SERVER_DATA_DIR` | `./.wiki-data` | Created if absent; must be writable & persistent. |
| `--auth-token` | `WIKI_SERVER_AUTH_TOKEN` | _(unset)_ | Unset ⇒ no auth (fine for loopback/local). |
| `--max-body-bytes` | `WIKI_SERVER_MAX_BODY_BYTES` | `8388608` | Caps one commit's array-message. |
| `--log-format` | `WIKI_SERVER_LOG_FORMAT` | auto | `pretty` \| `json`. |

`baseUrl` is **derived, not configured**: it's simply `http(s)://{host}:{port}`, and that string is
what goes into each client's `IStreamConfig.baseUrl`.

---

## 7. Storage & durability

`wiki-server` exists to make the stream **durable**, so storage mode is its central decision.

### 7.1 The three modes

| Mode | Backend | Durability | Use it for |
|---|---|---|---|
| `memory` | in-process | **none** (lost on exit) | unit/integration tests, throwaway demos. Same backend `wiki/testing` uses. |
| `file` *(default)* | log files + LMDB index | survives restart; fsync on append | **the default shared host** at the gentle target scale. |
| `acid` | redb | strongest atomicity/crash-consistency | when you want database-grade guarantees or expect rougher crashes. |

The mode is opaque to clients — a workspace folded from a `file` host is byte-identical to one
folded from an `acid` host; only the durability/perf envelope differs. This is why the engine has
**no storage port** ([wiki/DESIGN.md ADR-001](../wiki/DESIGN.md)): durability is *here*, not in `wiki`.

### 7.2 Crash & restart semantics

- `file`/`acid` persist every accepted append before acking; on restart the server rehydrates all
  streams from `dataDir` and clients resume from their saved offsets/snapshots — no client-side
  change, no data loss for acked writes.
- An append that returned 409 (stale seq) was never committed; the client rebases and retries
  ([wiki/DESIGN.md §15](../wiki/DESIGN.md)). `wiki-server` adds nothing here — it surfaces the
  server's native semantics.
- `memory` loses everything on exit **by design**; never run a shared host with it.

### 7.3 Retention & disk growth

Workspace and snapshot streams are created with **infinite retention** (no TTL — the client's
choice, [§5.2](#52-the-url-layout-is-the-clients-not-ours)), because **history is the source of
truth**. Therefore disk grows monotonically with activity. Bounding it is a known, *deferred*
concern:

- **Snapshots reduce read cost, not disk** ([wiki/DESIGN.md §8.3](../wiki/DESIGN.md)): superseded
  snapshots linger harmlessly. They speed rehydration; they do **not** trim the log.
- **Compaction** (dropping events below a durable snapshot, or GC'ing old snapshot messages) is a
  future server-or-tooling feature ([§13](#13-future-work)). v1 assumes disk is cheap relative to
  the target scale (tens–hundreds of pages per workspace, gentle write rates).
- **Sizing guidance:** ~1 commit per command, each a small JSON array; back-of-envelope a busy
  project is megabytes, not gigabytes. Monitor `dataDir` size ([§10](#10-operations)).

### 7.4 Backup & restore

Because durability is filesystem state, backup is **filesystem-level**:

- Stop writes or snapshot the volume (filesystem/cloud-disk snapshot) for a consistent copy of
  `dataDir`; for `acid` (redb), a hot copy during a checkpoint is safe — confirm against the
  storage engine's guarantees.
- Restore = drop `dataDir` back in place and start `wiki-server`; clients reconnect and re-tail.
- A logical backup is also possible (drain each stream via `GET` and re-`POST` to a fresh host),
  but the volume snapshot is the simple, recommended path.

---

## 8. Deployment

### 8.1 Local / embedded (dev)

For tests and single-process dev, **you usually don't run `wiki-server` at all** — `wiki/testing`
already embeds a server in the test process. Run the standalone binary only when you want a durable
host a separate process can point at:

```bash
npx wiki-server                      # file storage in ./.wiki-data on 127.0.0.1:4437
# clients: createWiki({ stream: { baseUrl: "http://127.0.0.1:4437", namespace: "dev" }, … })
```

### 8.2 Standalone shared host (the main case)

One durable node many clients share. Container image (multi-stage; Node runtime):

```dockerfile
# wiki-server/Dockerfile  (sketch)
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY dist ./dist
ENV WIKI_SERVER_HOST=0.0.0.0 \
    WIKI_SERVER_STORAGE=file \
    WIKI_SERVER_DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 4437
USER node
ENTRYPOINT ["node", "dist/main.js"]
```

```yaml
# compose (sketch) — durable volume + loopback-free bind behind your own TLS/ingress
services:
  wiki-server:
    image: wiki-server:0.1.0
    ports: ["4437:4437"]
    environment:
      WIKI_SERVER_STORAGE: file
      WIKI_SERVER_AUTH_TOKEN: ${WIKI_SERVER_AUTH_TOKEN:-}   # optional (§9)
    volumes: [ "wiki-data:/data" ]
volumes: { wiki-data: {} }
```

The `main.ts` entrypoint is intentionally tiny:

```ts
// src/main.ts  (sketch)
import { DurableStreamServer } from "@durable-streams/server";
import { loadConfig } from "./config";
import { withAuth } from "./auth";        // no-op unless authToken set (§9)
import { startHealth } from "./health";   // /healthz, /readyz (§10)

const cfg = loadConfig(process.argv, process.env);
const server = new DurableStreamServer({
  host: cfg.host, port: cfg.port,
  storage: cfg.storage, dataDir: cfg.dataDir,
  maxBodyBytes: cfg.maxBodyBytes,
  middleware: [withAuth(cfg.authToken)],   // shape TBD vs upstream; else front with a proxy (§9)
});
await server.start();
startHealth(server, cfg);
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => server.stop().then(() => process.exit(0)));   // graceful: finish in-flight, fsync, exit
```

### 8.3 Production escape hatches (not needed at target scale)

If a single Node host is ever insufficient, the swap is **server-side only** — clients keep their
`baseUrl`: run the upstream **Rust server** / **Caddy plugin** (`DS_STORAGE__MODE`) or
**Electric Cloud**, and repoint DNS. `wiki-server` wrapping `@durable-streams/server` is the
right-sized default ([ADR-S2](#adr-s2--wrap-durable-streamsserver-for-production-2026-06-01)), not a
ceiling.

---

## 9. Security (optional, off by default)

A shared, networked stream host means **anyone who can reach the URL can read or write any
workspace** — there are no per-workspace permissions below the engine. v1 keeps this pragmatic and
**explicitly opt-in**:

- **Local / loopback (default): no auth.** Bound to `127.0.0.1`, `wiki-server` runs open — the
  intended frictionless local experience. Skipping auth here is correct, not a gap.
- **Shared / networked: optional bearer token.** Set `WIKI_SERVER_AUTH_TOKEN`; the server then
  requires `Authorization: Bearer <token>` on every request and returns `401` otherwise. The same
  token goes in the clients' request headers (via the `@durable-streams/client` fetch options).
  A single shared secret — coarse but enough to keep a private host private.
- **TLS is terminated upstream.** Run `wiki-server` behind a reverse proxy / ingress (Caddy, nginx,
  a cloud LB) for HTTPS and, if wanted, finer routing. `wiki-server` speaks plain HTTP; clients
  just use an `https://` `baseUrl`.

**Deliberately deferred** ([§13](#13-future-work)): per-namespace tokens, per-actor identity,
read-vs-write scopes, audit of access (distinct from the event log's actor metadata). The guiding
rule mirrors the engine: **authorization lives above the substrate**, not inside it.

> ⚠️ Binding to `0.0.0.0` **without** a token or upstream auth publishes every workspace to anyone
> who can route to the port. `loadConfig` logs a prominent warning when `host` is non-loopback and
> `authToken` is unset.

---

## 10. Operations

- **Health:** `/healthz` (process up) and `/readyz` (storage open & writable) on the same port,
  exempt from auth, for liveness/readiness probes. (Served by `startHealth`, beside the stream
  server.)
- **Logs:** structured (`json` off-TTY): startup config (with secrets redacted), per-request
  method/path/status/seq-conflict, storage open/close, graceful-shutdown progress.
- **Metrics (lightweight v1):** append count, 409 (conflict) rate, live-tail subscriber count,
  `dataDir` bytes, request latency. Expose via logs in v1; a `/metrics` endpoint is
  [future work](#13-future-work).
- **Capacity:** the bottleneck at target scale is disk (monotonic, [§7.3](#73-retention--disk-growth))
  and live-tail fan-out. Watch `dataDir` growth and subscriber count; both are gentle by design.
- **Upgrades:** `wiki-server` and `wiki` version **independently** (G2) as long as the
  `@durable-streams` wire protocol matches. Roll `wiki-server` by draining (stop accepting, finish
  in-flight, fsync, exit) and restarting on the same `dataDir`; clients transparently reconnect and
  resume from their offsets.

---

## 11. Package structure

A new sibling in the monorepo ([wiki/DESIGN.md §16](../wiki/DESIGN.md)). It depends on
`@durable-streams/server` as a **runtime** dependency (in `wiki/` that package is a *devDependency*,
used only by the test server — the contrast captures the whole relationship). It does **not** list
`wiki` as a dependency.

```
.
├─ wiki/                         # the engine (transport-free; a CLIENT of the stream host)
└─ wiki-server/                  # ← THIS package — the durable stream host
    ├─ package.json             # name "wiki-server"; dep @durable-streams/server; bin → dist/main.js
    ├─ DESIGN.md                # ← this document
    ├─ Dockerfile
    └─ src/
        ├─ main.ts              # entrypoint: load config → start DurableStreamServer → health → signals
        ├─ config.ts            # WikiServerConfig + resolve(flags, env, file, defaults)
        ├─ auth.ts              # optional bearer-token middleware (no-op when unset)
        └─ health.ts            # /healthz, /readyz
```

**Boundaries that keep it honest:**

- **`wiki-server` never imports `wiki`** (or any `wiki/*` subpath). Enforced by lint and by the
  absence of the dep in `package.json`. If you ever feel the urge to import a wiki type here, the
  design has gone wrong ([ADR-S1](#adr-s1--host-streams-do-not-wrap-the-engine-2026-06-01)).
- **All wiki-specific knowledge stays in the client** (`wiki/src/stores/event-log.ts`): URL layout,
  envelopes, OCC seq mapping, snapshot/catalog streams ([§5](#5-the-client-contract)).
- Add `wiki-server` to the root `workspaces` array; it extends `tsconfig.base.json` like the engine.

---

## 12. Testing strategy

`wiki-server` is thin, so its tests assert the **host behaves**, not engine logic (the engine's own
suite already exercises the protocol against an in-memory server, [wiki/DESIGN.md §17](../wiki/DESIGN.md)).

- **Smoke (per storage mode):** boot on an ephemeral port → `POST` a JSON array message → `GET` it
  back as one message → `live:true` tail sees a subsequent append. Run for `memory` and `file`.
- **Durability:** with `file`/`acid`, append → `stop()` → `start()` on the same `dataDir` → the
  message is still readable. This is the property `memory` can't provide and the package exists for.
- **OCC pass-through:** two appends at the same `seq` → first `200`, second `409`. Confirms the
  client's `StaleAppendError`/rebase path has a real server to react to.
- **Auth:** token unset → request `200`; token set + missing/wrong header → `401`; correct header →
  `200`. Health endpoints reachable without the token.
- **Config resolution:** flags override env override file override defaults; non-loopback host with
  no token emits the warning.
- **Engine round-trip (integration):** point a real `createWiki` at a `file`-mode `wiki-server`, run
  a trimmed version of the engine's worked example ([wiki/DESIGN.md §13.3](../wiki/DESIGN.md)), stop
  and restart the server mid-script, and assert the folded workspace survives — proving the
  client/host contract end-to-end across a real restart.

---

## 13. Future work

- **Compaction / retention tooling** — drop events below a durable snapshot; GC superseded snapshot
  messages ([§7.3](#73-retention--disk-growth)).
- **Per-namespace tokens, actor identity, read/write scopes** — graduate [§9](#9-security-optional-off-by-default)
  beyond a single shared secret; audit access.
- **`/metrics` endpoint** (Prometheus) and richer operational dashboards.
- **Managed multi-node / Rust+Caddy tier** as a first-class, documented deployment rather than an
  escape hatch ([§8.3](#83-production-escape-hatches-not-needed-at-target-scale)).
- **Backup automation** — scheduled, consistent `dataDir` snapshots with retention.

---

## 14. References

- Durable Streams — Concepts: <https://durablestreams.com/concepts>
- Durable Streams — JSON mode: <https://durablestreams.com/json-mode>
- Durable Streams — Deployment / server (storage modes, `DS_STORAGE__MODE`, Caddy): <https://durablestreams.com/deployment>
- `@durable-streams/server` (npm): <https://www.npmjs.com/package/@durable-streams/server>
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
wiki-specific structure (URL layout, envelopes, OCC) stays in the client. A CLI (`wiki-cli/`)
remains a separate, genuine *consumer* of the engine — unaffected by this change.

### ADR-S2 — Wrap `@durable-streams/server` for production (2026-06-01)

**Context.** `wiki/DESIGN.md` (ADR-001) notes `@durable-streams/server` is "built for
dev/test/CI/embedding," with production "via Caddy / Electric Cloud." So: is it legitimate to run it
as the *production* host?

**Findings.** At the engine's stated target scale — a workspace ≈ one project, ~5 gentle concurrent
writers, tens–hundreds of pages ([wiki/DESIGN.md §6.6](../wiki/DESIGN.md)) — a single Node node with
**`file`** (or **`acid`**) storage is amply durable and simple: one dependency, one process, one
volume. The heavier Rust server / Caddy tier solves scale and ops needs this deployment doesn't
have yet.

**Decision.** v1 `wiki-server` **wraps `@durable-streams/server`** with durable storage, a stable
bind, a `bin`, and a container. Default storage is **`file`** (durable, light); `acid` and `memory`
are one switch away.

**Consequences.** Production-grade *for this scale*, not a ceiling. The upstream Rust/Caddy server
and Electric Cloud remain drop-in, **server-side-only** swaps (clients keep their `baseUrl`,
[§8.3](#83-production-escape-hatches-not-needed-at-target-scale)) if scale or stricter ops ever
demand it. We accept monotonic disk growth until compaction lands ([§7.3](#73-retention--disk-growth)).

### ADR-S3 — Security is optional and off by default (2026-06-01)

**Context.** A networked stream host has no per-workspace permissions; whoever reaches the URL can
read/write everything. But the primary experience is local and should stay frictionless.

**Decision.** No auth by default (loopback bind). For shared deployments, an **optional single
bearer token** (`WIKI_SERVER_AUTH_TOKEN`) gates all requests; **TLS is terminated by an upstream
proxy.** Per-namespace/per-actor authorization is deferred ([§13](#13-future-work)).

**Consequences.** Local use needs zero security config. Exposing the host is a deliberate two-step
(bind off-loopback **and** set a token / front a proxy); `wiki-server` warns loudly if you do the
first without the second. Authorization stays *above* the substrate, consistent with the engine.
