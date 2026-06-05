# wiki-cli — Design Document

> Status: **Draft / living document** · Last updated: 2026-06-02 · Owner: @benjamin
>
> A configurable command-line client for the wiki engine. `wiki-cli/` **embeds the `wiki` engine**
> ([wiki/DESIGN.md](../wiki/DESIGN.md)) and points it at a **`wiki-server`**
> ([wiki-server/DESIGN.md](../wiki-server/DESIGN.md)) — local or remote — selected by a named
> **profile**. It exposes the engine's operations as commands, and manages servers **by degrees**:
> data and observability commands work against *any* reachable server; process management only
> against a *locally-managed* one.

---

## Table of contents

1. [Motivation & goals](#1-motivation--goals)
2. [Non-goals](#2-non-goals)
3. [Where it sits](#3-where-it-sits)
4. [Configuration & profiles](#4-configuration--profiles)
5. [The command surface](#5-the-command-surface)
6. [Admin "by degrees"](#6-admin-by-degrees)
7. [The wiki-server control API (consumed)](#7-the-wiki-server-control-api-consumed)
8. [Local server management](#8-local-server-management)
9. [Remote auth](#9-remote-auth)
10. [Output, errors & exit codes](#10-output-errors--exit-codes)
11. [Package structure](#11-package-structure)
12. [Testing strategy](#12-testing-strategy)
13. [Future work](#13-future-work)
14. [References](#14-references)
- [Appendix A: Decision records](#appendix-a-decision-records)

---

## 1. Motivation & goals

The engine is **transport-free** — it exposes only a TypeScript interface and reaches storage as a
*client* of a Durable Streams server ([wiki/DESIGN.md §1](../wiki/DESIGN.md)). To drive it from a
terminal (or a script, or an agent shelling out), something has to **embed the engine, bind it to a
server, and surface its commands.** That is `wiki-cli`.

It is a **stateless** client: each invocation opens the target workspace from the server (rehydrate
= snapshot + folded tail), performs the operation (an atomic append), and exits. State lives on the
`wiki-server`; the CLI holds none between runs. Two people (or an agent and a person) running
`wiki-cli` against the same server collaborate through the shared stream, with the engine's
optimistic concurrency keeping them consistent ([wiki/DESIGN.md §15](../wiki/DESIGN.md)).

Statelessness has an honest cost: each invocation pays a fresh rehydrate (latest snapshot + folded
tail, [wiki/DESIGN.md §8.3](../wiki/DESIGN.md)) and discards the live-tail projection on exit, so a
tight scripted/agent loop of N mutations does N rehydrates — bounded by `snapshotEvery`/`snapshotIdleMs`
and growing with the tail until server-side compaction lands ([wiki-server/DESIGN.md §7.2](../wiki-server/DESIGN.md)).
A batch/REPL mode that amortizes it is [future work](#13-future-work).

### Goals

- **G1 — Expose the engine.** Workspace/page/item operations, structural edits, deterministic
  Markdown rendering, live tailing, and history — all delegated to `wiki`, never reimplemented.
- **G2 — Profiles.** Named targets (`local`, `prod`, …), each a `wiki-server` endpoint + namespace
  (+ optional auth and local-management info). Switch with one flag or env var.
- **G3 — Admin by degrees.** Every command declares a **locality**: *data* (any reachable server),
  *global-admin* (any reachable server, via the control API), or *local-admin* (a locally-managed
  server only). The CLI refuses out-of-scope commands with an actionable message ([§6](#6-admin-by-degrees)).
- **G4 — Manage local servers.** Start/stop/restart/status a co-located `wiki-server` process, by
  spawning its **binary** — never by importing its code ([§8](#8-local-server-management)).
- **G5 — Agent- & script-friendly.** `--output json`, structured errors with exit codes, and
  `wiki tools` (the command catalog as JSON Schema for function-calling) — the engine is LLM-first
  ([wiki/DESIGN.md §12](../wiki/DESIGN.md)) and the CLI keeps that surface.
- **G6 — Honest, thin coupling.** Depends on `wiki` as a library; treats `wiki-server` as a
  *binary to spawn* and an *HTTP control API to call* — two narrow seams, no shared code.

---

## 2. Non-goals

- **Not a server or daemon.** It runs, acts, and exits. Hosting streams is `wiki-server`'s job;
  serving an engine API was the rejected `wiki-api/` ([wiki-server/DESIGN.md ADR-S1](../wiki-server/DESIGN.md)).
- **No new persistence or domain logic.** The CLI owns no state and no rules; it calls the engine.
- **Does not reimplement page types.** It registers a page-type set the engine understands
  ([§4.3](#43-the-page-type-registry-problem)); it cannot fold a workspace whose types it lacks.
- **Not an init system.** Local process management targets dev / single-box use; production
  lifecycle belongs to systemd/launchd/containers ([§8](#8-local-server-management)).
- **No multi-server fan-out, no TUI** in v1 ([§13](#13-future-work)).

---

## 3. Where it sits

```
                       ┌──────────────────────── wiki-cli (this package) ───────────────────────┐
                       │                                                                          │
   terminal / agent ──▶│  commands → resolve PROFILE → load page types → createWiki(engine)       │
                       │                          │                  │            │               │
                       │                          │                  │            ▼               │
                       │            local-admin   │     data/render  │    embeds `wiki` (library) │
                       │          (spawn binary)  │                  │            │               │
                       └──────────────┼───────────┼──────────────────┼────────────┼──────────────┘
                                      │           │                  │            │
                  spawn wiki-server   │           │ HTTP: control API │  @durable-streams/client
                  process (local only)│           │  /_server/logs …  │  (append · read · tail)
                                      ▼           ▼                  ▼            ▼
                       ┌──────────────────────────────────────────────────────────────────────┐
                       │  wiki-server  (local or remote)  ── hosts streams + a small control API │
                       └──────────────────────────────────────────────────────────────────────┘
```

**Dependency direction (the boundaries that matter):**

- **`wiki-cli → wiki`** — a normal library dependency. The CLI calls `createWiki({ stream, pageTypes, … })`
  and the returned `IWiki`/`IWorkspaceHandle`/`IPageView` ([wiki/DESIGN.md §10](../wiki/DESIGN.md)).
- **`wiki-cli ⇢ wiki-server` (two narrow seams, no code import):**
  1. **spawns its binary** for local process management ([§8](#8-local-server-management)); and
  2. **calls its HTTP control API** for logs/health/info ([§7](#7-the-wiki-server-control-api-consumed)).
  It never imports `wiki-server` source — symmetry with `wiki-server`, which imports neither the CLI
  nor the engine.
- **`wiki-cli` is a leaf** — nothing imports it.

---

## 4. Configuration & profiles

### 4.1 Profiles

A **profile** is a named target. Config lives at `${XDG_CONFIG_HOME:-~/.config}/wiki/config.toml`:

```toml
default_profile = "local"

[profiles.local]
base_url   = "http://127.0.0.1:4437"   # the wiki-server streams origin
namespace  = "dev"
# `manage` present ⇒ this profile is a LOCALLY-MANAGED server (enables local-admin, §6/§8)
[profiles.local.manage]
bin        = "wiki-server"             # resolved binary to spawn (default: the workspace wiki-server)
data_dir   = "./.wiki-data"
storage    = "file"
control_port = 4438
pid_file   = "~/.local/state/wiki/local.pid"
log_file   = "~/.local/state/wiki/local.log"

[profiles.prod]
base_url    = "https://wiki.example.com"
control_url = "https://wiki.example.com"   # proxy multiplexes /_server/* to the control listener (§7.1)
namespace   = "team"
token_env   = "WIKI_PROD_TOKEN"            # bearer token read from this env var (never store secrets in the file)
# no `manage` block ⇒ remote: data + global-admin only; local-admin is refused (§6)
```

| Field | Meaning |
|---|---|
| `base_url` | `wiki-server` streams origin → the engine's `IStreamConfig.baseUrl`. |
| `namespace` | stream namespace → `IStreamConfig.namespace` ([wiki/DESIGN.md §9.1](../wiki/DESIGN.md)). |
| `control_url` | control-API origin ([§7.1](#71-endpoints)); default = `base_url` host + control port (bare/local). For a proxied remote, set it to the proxied origin. |
| `token` / `token_env` | bearer token for an authed server ([§9](#9-remote-auth)); prefer `token_env`. |
| `page_types` | which registered page-type set to load ([§4.3](#43-the-page-type-registry-problem)); default `feature`. |
| `manage` | **local-only**: how to spawn/inspect a co-located server; its presence marks the profile *manageable*. |

### 4.2 Resolution

Precedence (first wins): **flags → env → config file → built-in defaults.**

- `--profile <name>` / `WIKI_PROFILE` selects the profile (else `default_profile`).
- Per-field overrides: `--base-url`/`WIKI_BASE_URL`, `--namespace`/`WIKI_NAMESPACE`,
  `--token`/`WIKI_TOKEN`, `--actor`/`WIKI_ACTOR`, `--output`. This lets one-off commands target an
  ad-hoc server without editing the config — git/gh/kubectl-style.
- `wiki profile` subcommands: `list`, `current`, `use <name>`, `show [name]`, `add`, `remove`.

The engine is built per invocation with **real** `clock`/`ids` (the engine's defaults — wall clock
+ ULID, [wiki/DESIGN.md §10.1](../wiki/DESIGN.md)); the deterministic injectors are for tests only.
`actor` defaults to `cli:${os.userInfo().username}` and is stamped on every event's metadata.

### 4.3 The page-type registry problem

The engine **cannot open a workspace whose page/event types it doesn't have registered** — it fails
closed with `UnknownPageTypeError` ([wiki/DESIGN.md §8.5](../wiki/DESIGN.md)). So the CLI is only as
capable as the page types it loads. v1: load the bundled **`featurePageTypes`** from
`wiki/pages/feature` ([wiki/DESIGN.md §13](../wiki/DESIGN.md)); a profile's `page_types` selects a
named, CLI-registered set. Loading arbitrary third-party page-type packages at runtime is
[future work](#13-future-work). The CLI surfaces an `UnknownPageTypeError` as a clear
"this build doesn't know page type X; the workspace was authored with a type set this CLI wasn't
configured for."

---

## 5. The command surface

`commander`-based, grouped by noun. Workspace id is `<ws>`; page id is `<page>`.

```
wiki profile  list | current | use <name> | show [name] | add | remove
wiki ws       create --name <n> [--id <id>]
              ls
              <ws> tree | render [<page>] | history | tail
              <ws> archive
wiki page     <ws> create <type> --title <t> [--parent <page>]
              <ws> <page> show | render | state | commands
              <ws> <page> mutate <command> --json '<args>'        # generic (§5.1)
wiki ws       <ws> reparent <page> <newParent> [--position n]     # structural commands
              <ws> reorder <parent> <id...>
              <ws> link <from> <to> --role <r> | unlink …
              <ws> move-item --from <p> --to <p> --type <t> --id <i>
wiki tools    [--type <pageType>] [--status <s>]                  # JSON-Schema command catalog
wiki server   start | stop | restart | status | logs | health | info | backup | restore   (§6, §8)
```

Each maps directly to an engine call: `wiki ws create` → `IWiki.createWorkspace`; `wiki page <ws>
create` → `IWorkspaceHandle.createPage`; `render` → `toMarkdown`; `tail` → `subscribe`; `history`
→ `history`; `state`/`commands` → `IPageView.state()`/`describeMutations()`.

### 5.1 Mutations: generic now, generated later

A page command is invoked generically, with arguments as JSON validated by the engine's Zod schema
([wiki/DESIGN.md §10.5](../wiki/DESIGN.md)):

```bash
wiki page my-ws feature-brief:01J… mutate addConstraint --json '{"text":"Export must stream."}'
wiki page my-ws feature-brief:01J… mutate answerQuestion --json '{"questionId":"q1","answer":"CSV+JSON."}'
```

Discovery is first-class: `wiki page <ws> <page> commands` calls `describeMutations()` and lists the
page's commands each with its `available` flag — the FSM's legal-now set (equivalently
`availableMutations()`); `--legal` filters to only the available ones. `wiki tools` dumps every
command's `argsSchema` JSON Schema — ready to paste into an Anthropic/OpenAI tool definition. Generated per-command
subcommands with typed flags (`wiki page <ws> <page> add-constraint --text …`) are ergonomic sugar
deferred to a later phase ([ADR-C5](../docs/wiki/decision-records/generic-mutations-in-v1-generated-subcommands-later.md)).

`--command-id <id>` threads the engine's idempotency key so a retried tool call collapses to one
effect ([wiki/DESIGN.md §15](../wiki/DESIGN.md)).

---

## 6. Admin "by degrees"

Every command carries a **locality** the CLI enforces against the active profile:

| Locality | Reaches the server via | Works when | Examples |
|---|---|---|---|
| **data** | embedded engine + streams | any reachable `base_url` | `ws *`, `page *`, `render`, `tail`, `tools` |
| **global-admin** | the `wiki-server` **control API** — a *coordinated, not-yet-built* addition ([§7](#7-the-wiki-server-control-api-consumed)) | any reachable `control_url` | `server logs`, `server health`, `server info` |
| **local-admin** | spawning/signalling the local process ([§8](#8-local-server-management)) | profile has a `manage` block | `server start\|stop\|restart\|status`, `server backup\|restore` |

The gate is explicit and friendly:

```
$ wiki --profile prod server stop
error: `server stop` is a local-admin command and requires a locally-managed profile.
       Active profile "prod" is remote (no [manage] block). Process control must run on the
       server's host. Did you mean `wiki --profile prod server logs -f` (global) ?
```

This is the user-visible meaning of "by degrees": **logs stream from anywhere** (global, over the
control API); **process control only where the process is** (local). `data` commands are the widest
tier — they need nothing but a reachable streams origin.

---

## 7. The wiki-server control API (consumed)

> **A coordinated, not-yet-built `wiki-server` capability — directed by the owner.** The owner has
> directed that `wiki-server` expose logs (history + tailing) over a small **HTTP control API** that
> *piggybacks its logging interface* — **not** Durable Streams
> ([ADR-C3](../docs/wiki/decision-records/logs-via-the-control-api-not-durable-streams.md)). This **narrows**
> `wiki-server`'s "no API surface of our own" charter ([wiki-server/DESIGN.md §1/§2](../wiki-server/DESIGN.md))
> to *no **engine** API; a minimal **operational** control API is allowed*, so `wiki-server/DESIGN.md`
> must be amended (its own ADR) to own this contract — **it does not describe it yet.** The section
> below is the **contract `wiki-cli` consumes**; until `wiki-server` ships it, only the `log_file`
> fallback ([§7.2](#72-the-wiki-logs-command)) and the data tier work.

### 7.1 Endpoints

The wrapped `DurableStreamTestServer` owns its HTTP handler privately and exposes no route/middleware
hook ([wiki-server/DESIGN.md §4](../wiki-server/DESIGN.md)), so **these paths cannot ride the streams
listener — `wiki-server` must open a *second*, dedicated control listener** (its own `http.createServer`
on `--control-port`). The CLI reaches it at `control_url`, which **defaults to the `base_url` host with
the control port** (e.g. streams `:4437` → control `:4438`), *not* the `base_url` origin.

| Method · path | Purpose | Response |
|---|---|---|
| `GET /_server/logs?since=<seq>&boot=<id>&limit=<n>&level=<lvl>` | **log history** from the ring buffer | `200` JSON `{ boot, records: LogRecord[], next: seq, truncated?: bool }` |
| `GET /_server/logs?follow=1&since=<seq>&boot=<id>` | **log tail** (backlog from `since`, then live) | `200 text/event-stream` (SSE), one `LogRecord` per event |
| `GET /_server/health` | liveness/readiness | `200 {status:"ok"}` / `503` |
| `GET /_server/info` | server facts | `200 { version, boot, storage, dataDir, baseUrl, pid, uptimeMs }` |

```jsonc
// LogRecord — the unit of both history and tail. `seq` is a monotonic counter WITHIN a server
// process; `boot` identifies the process so a client detects a restart (seq resets) instead of
// silently gapping. Resume = (boot, since): a mismatched `boot` ⇒ start fresh; a `since` older than
// the ring buffer's oldest retained seq ⇒ oldest-available records + `truncated: true`.
{ "seq": 412, "boot": "b-7f3a", "ts": "2026-06-02T08:58:35.123Z", "level": "info",
  "msg": "wiki-server up", "baseUrl": "http://127.0.0.1:4437", "storage": "file" }
```

**Auth on the control listener.** That second listener has no built-in auth either, so for an authed
remote it must be **loopback-only behind the same reverse proxy** — the proxy routes `/_server/*` to
the control listener and everything else to the streams listener, both behind one bearer-token check —
or it enforces the token itself. Absent a proxy, `control_url` points directly at the control port,
which must then be on a trusted network. This is the only way a single `https://…` origin serves both
planes.

### 7.2 The `wiki logs` command

```bash
wiki server logs                      # recent history (one screen), newest last
wiki server logs -f                   # tail live (SSE); Ctrl-C to stop
wiki server logs --since 400 --level warn --json   # resume + filter + machine output
```

`logs` is **global-admin**: it hits `control_url`, so it works identically against a local or a
remote server — the answer to "streaming logs should apply globally." `--follow` consumes the SSE
stream and prints each `LogRecord` (pretty or `--json`), resuming from the last `seq` on reconnect.
If `control_url` is unreachable but the profile is locally-managed, the CLI falls back to tailing the
profile's `log_file` directly ([§8](#8-local-server-management)) and says so.

---

## 8. Local server management

`local-admin` commands operate a **co-located** `wiki-server` by spawning its **binary** (resolved
from `manage.bin`, default the workspace's `wiki-server`); the CLI never imports `wiki-server` code.

- **`server start`** — spawn `wiki-server` **detached**: open `log_file` as a file descriptor for the
  child's stdout/stderr (not an inherited pipe), set `detached: true`, and `unref()` so the CLI can
  exit while the server runs. Pass `--storage`/`--data-dir`/`--port` (the last derived from `base_url`;
  managed profiles must carry an explicit port, else default `4437`) and — once it exists —
  `--control-port` (callout below). Verify the child is alive and write `pid_file` immediately after
  spawn (surfacing a clear error if a bad `bin` already exited); refuse if `pid_file` names a live process.
- **`server stop`** — `SIGTERM` the pid (graceful drain, [wiki-server/DESIGN.md §8.1](../wiki-server/DESIGN.md)),
  then remove `pid_file`; `--force` escalates to `SIGKILL` after a timeout.
- **`server restart`** — stop then start.
- **`server status`** — `pid_file` liveness **+** a `GET /_server/health` probe → reports
  process-up and serving-ok independently (the probe needs the control listener, below).
- **`server backup` / `restore`** — filesystem snapshot/restore of `data_dir`
  ([wiki-server/DESIGN.md §7.3](../wiki-server/DESIGN.md)); local because it touches the volume.

> **Coordinated `wiki-server` flag.** `--control-port` (and the control listener it opens) **does not
> exist in `wiki-server` today** — its flags are `--host`/`--port`/`--storage`/`--data-dir`/`--long-poll-ms`/`--log-format`.
> It lands with the control-API addition ([§7](#7-the-wiki-server-control-api-consumed)). Until then
> `start` omits it, `status` falls back to `pid_file` liveness only, and `logs` tails `log_file`
> directly ([§7.2](#72-the-wiki-logs-command)).

**Scope (honest):** this is dev / single-box ergonomics. For production, run `wiki-server` under
systemd/launchd or a container ([wiki-server/DESIGN.md §8.2](../wiki-server/DESIGN.md)) and use the
**global** tier (`logs`, `health`, `info`, plus all data commands) from anywhere.

---

## 9. Remote auth

An authed remote `wiki-server` sits behind a reverse proxy that checks a bearer token
([wiki-server/DESIGN.md §9](../wiki-server/DESIGN.md)). The CLI sends the profile's `token` as
`Authorization: Bearer <token>` on **both** seams:

- **Control API** (logs/health/info) — a direct `fetch` with the header. Straightforward.
- **Streams** (the engine's traffic) — needs the header on the `@durable-streams/client` calls. The
  client **already supports** `headers` (and a `fetch` override) on every entry point, but the engine's
  `IStreamConfig` doesn't forward them today. So this requires a **small, coordinated engine addition**:
  an optional `IStreamConfig.headers` (static map or a `() => headers` for token refresh) that
  `EventLog` threads to **all** the client call-sites it uses — `DurableStream.create` (the handle,
  whose `append` inherits its headers), `stream(...)` (reads + live tails), and `DurableStream.head`
  (existence checks) — not just one, or reads/existence-checks `401`
  ([ADR-C4](../docs/wiki/decision-records/remote-auth-via-an-engine-istreamconfig-headers-hook.md)).

```ts
// wiki-cli builds the engine from the resolved profile:
createWiki({
  stream: {
    baseUrl: profile.base_url,
    namespace: profile.namespace,
    headers: profile.token ? { Authorization: `Bearer ${profile.token}` } : undefined,  // ← engine addition
  },
  pageTypes: loadPageTypes(profile.page_types),
  actor: resolveActor(),
});
```

Tokens are read from `token_env` (or `--token`/`WIKI_TOKEN`), **never stored in the config file**.

> **v1 scope (owner's call).** Until the `IStreamConfig.headers` hook lands, **authed remote profiles
> are out of reach** — v1 remote targets must be unauthenticated or network-ACL'd. The engine change is
> small but real ([ADR-C4](../docs/wiki/decision-records/remote-auth-via-an-engine-istreamconfig-headers-hook.md));
> confirm whether it's in v1 or deferred.

---

## 10. Output, errors & exit codes

- **`--output md|json|table`** (default `md` on a TTY, else `json`). `render` emits the engine's
  **deterministic Markdown** ([wiki/DESIGN.md §11](../wiki/DESIGN.md)) verbatim; `json` emits typed
  state / results for scripting and agents; `table` is a compact human view of lists.
- **Errors map the engine's typed `WikiError` hierarchy** ([wiki/DESIGN.md §14](../wiki/DESIGN.md))
  to stable exit codes and a structured stderr line (`{ "error": { code, message, … } }` under
  `--output json`). The richness is preserved so an agent self-corrects: e.g.
  `MutationNotAllowedError` prints the current status **and** the legal command set.

| Exit | Class |
|---|---|
| `0` | success |
| `2` | usage / bad flags |
| `3` | `ValidationError` (bad `--json` args) |
| `4` | FSM / invariant / archived (`MutationNotAllowedError`, `CycleError`, `InvariantViolationError`, `WorkspaceArchivedError`, …) |
| `5` | not found (`WorkspaceNotFoundError`, `PageNotFoundError`, …) |
| `6` | concurrency (`ConcurrencyError` after rebase exhaustion) |
| `7` | connectivity (server unreachable / timeout) |
| `8` | locality (a local-admin command on a remote profile, [§6](#6-admin-by-degrees)) |
| `9` | auth (`401`/`403` from the proxy) |
| `10` | unsupported page type (`UnknownPageTypeError` — the registry gap, [§4.3](#43-the-page-type-registry-problem)) |

Under `--output json`, each reader emits a stable shape: `render` → `{ pageId, markdown }` (the
deterministic Markdown as a string field, never re-parsed); `state` → the typed page state; `tree` →
the `ITreeNode`; `history` → an `IEventEnvelope[]`; list commands → an array of summaries.

---

## 11. Package structure

A consumer sibling in the monorepo. Runtime deps: **`wiki`**, **`commander`**, and a small TOML
parser. It spawns the `wiki-server` **binary** (no code dep) and calls its control API over HTTP.

```
.
├─ wiki/             # engine (library dependency)
├─ wiki-server/      # stream host + control API (spawned binary + HTTP API; NOT a code import)
└─ wiki-cli/         # ← THIS package
    ├─ package.json  # name "wiki-cli"; bin: { "wiki": "dist/cli.js" }; deps: wiki, commander, toml
    ├─ DESIGN.md
    └─ src/
        ├─ cli.ts            # commander entry: parse → resolve profile → dispatch
        ├─ config.ts         # load/merge profiles (flags → env → TOML → defaults), `wiki profile`
        ├─ engine.ts         # build IWiki from a profile (page-type registry, actor, auth headers)
        ├─ commands/         # one module per noun: profile · ws · page · tools · server
        ├─ server-control.ts # HTTP client for /_server/* (logs history + SSE tail, health, info)
        ├─ server-manage.ts  # local-admin: spawn/stop/status the wiki-server binary
        └─ output.ts         # md|json|table rendering + WikiError → exit-code mapping
```

- Add `wiki-cli` to the root `workspaces`; it extends `tsconfig.base.json`. Like `wiki-server`, it is
  **compiled and run as Node** (`bin`), so its relative imports use **`.js` extensions** — raw Node ESM
  needs explicit extensions; the `Bundler` resolution that lets `wiki/` import extensionless only
  applies to source-consumed packages.
- **Boundaries:** `commands/*` and `engine.ts` touch `wiki`'s **public** surface only;
  `server-manage.ts`/`server-control.ts` touch `wiki-server` only as *binary + HTTP*, never as code.

---

## 12. Testing strategy

Tests assert the CLI **wires and gates correctly**, not engine behavior (the engine has its own
suite, [wiki/DESIGN.md §17](../wiki/DESIGN.md)). They use `wiki/testing`'s in-memory server and a
real `wiki-server` binary for the management/control paths.

- **Profile resolution:** flags > env > TOML > defaults; `token_env` indirection; `control_url`
  defaulting from `base_url`.
- **Command dispatch / output:** `ws create`→`page create`→`mutate`→`render` against an in-memory
  server produces stable Markdown; `--output json` shapes; `tools` emits valid JSON Schema.
- **By-degrees gating:** a `local-admin` command on a remote (no-`manage`) profile exits `8` with the
  guidance message; a `global-admin` command works on both.
- **Control-API client:** against a stub (and a real `wiki-server`), `logs` returns history and
  `-f` consumes the SSE tail and resumes from `since`.
- **Local management:** `server start` spawns a real `wiki-server`, `status` sees it healthy,
  `stop` ends it and clears the `pid_file`.
- **Error mapping:** representative `WikiError`s → the documented exit codes.

---

## 13. Future work

- **Generated per-command subcommands** with typed flags from `describeMutations()`
  ([ADR-C5](../docs/wiki/decision-records/generic-mutations-in-v1-generated-subcommands-later.md)).
- **Pluggable page-type packages** loaded by a profile, beyond the bundled `feature` set
  ([§4.3](#43-the-page-type-registry-problem)).
- **Shell completion** (the command tree + live `availableMutations()` are completion-friendly).
- **Multi-server / fan-out** admin (`logs` across N servers), and a **TUI** workspace browser.
- **Richer auth** — SSO/OIDC token acquisition and refresh (the engine's dynamic-headers hook and
  the client's function-headers already allow it).

---

## 14. References

- Engine (embedded): [`wiki/DESIGN.md`](../wiki/DESIGN.md) — esp. §10 (API), §11 (render), §12 (LLM), §14 (errors), §15 (concurrency).
- Stream host (target): [`wiki-server/DESIGN.md`](../wiki-server/DESIGN.md) — esp. §7 (storage), §8 (deploy), §9 (security).
- `commander`: <https://github.com/tj/commander.js> · TOML: <https://toml.io>
- `@durable-streams/client` headers/fetch support: package `dist/index.d.ts` (`StreamOptions.headers`, `fetch`).

---

## Appendix A: Decision records

These architecture decisions are now first-class, FSM-governed pages in the wiki, rendered to
[`docs/wiki/decision-records/`](../docs/wiki/decision-records/) (the engine's own Markdown
projection — see the [index](../docs/wiki/decision-records/index.md)). They are no longer
maintained inline here; the legacy IDs map to their pages:

| Legacy ID | Decision |
|---|---|
| ADR-C1 | [Embed the engine; spawn the server; import neither's internals](../docs/wiki/decision-records/embed-the-engine-spawn-the-server-import-neither-s-internals.md) |
| ADR-C2 | [Admin "by degrees" via command locality](../docs/wiki/decision-records/admin-by-degrees-via-command-locality.md) |
| ADR-C3 | [Logs via the control API, not Durable Streams](../docs/wiki/decision-records/logs-via-the-control-api-not-durable-streams.md) |
| ADR-C4 | [Remote auth via an engine `IStreamConfig.headers` hook](../docs/wiki/decision-records/remote-auth-via-an-engine-istreamconfig-headers-hook.md) |
| ADR-C5 | [Generic mutations in v1, generated subcommands later](../docs/wiki/decision-records/generic-mutations-in-v1-generated-subcommands-later.md) |
