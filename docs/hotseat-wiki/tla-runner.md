# Spec: TLA+ runner

**Status:** restating

## Overview
`tla-runner` is a new local process — a workspace-member sibling of `wiki-mirror` — that wraps the TLA+ toolchain (SANY for parsing and semantic checking, TLC for model checking and simulation) behind a small loopback HTTP + SSE API, so wiki clients can compile and check TLA+ specifications without knowing anything about Java or jar files. This spec defines the process's data model (content-addressed spec snapshots; runs with an explicit status FSM; structured diagnostics, check results, and counterexample traces) and its complete HTTP surface (submitting work, polling, live observation, cancellation, health). It is the foundation for the longer-term TLA+ learning feature — a Theia-based editor component that slots into page editors, wiki references from pages to TLA+ snapshots, and an LLM critique loop judging whether a Markdown spec and its TLA+ formalization say the same thing — all of which are explicit non-goals here and will be specified separately.

## Sections
### 1. Purpose, placement, and non-goals
The long-term feature is learning-by-formalizing: a wiki page (a spec-restatement especially) references one or more TLA+ specifications; a Theia-based editor component slotted into the page editor authors them; an LLM critique loop judges whether the prose spec and the TLA+ formalization describe the same system. Every one of those pieces needs the same foundation first: something that can actually _run_ the TLA+ tools. `tla-runner` is that foundation and nothing more.

**What it is.** A local, single-user process that accepts TLA+ sources over HTTP, runs the toolchain on them (parse / model-check / simulate), and reports structured results — diagnostics, state-space statistics, counterexample traces — plus the raw tool output. It is a new workspace-member package (`tla-runner`, tsdown/tsx, Node ≥ 20 — built and run exactly like `wiki-mirror`).

**Boundary: wiki-agnostic.** `tla-runner` imports none of `wiki` / `wiki-models` / `wiki-mcp` and knows nothing about pages, workspaces, or streams. Its clients are anything that can speak HTTP on the local machine: `wiki-ui` in the browser (via CORS), a future Theia backend, CLIs, and agents. How wiki pages _reference_ TLA+ snapshots is a later `wiki-models` concern, deliberately out of this spec.

**Trust model.** Loopback-only by default (`127.0.0.1`), no authentication — the same local-only trust stance as `wiki-mirror`. CORS is enabled for configured browser origins (default `http://localhost:3000`, where wiki-ui runs).

**Non-goals** (each named so nobody wonders whether it was forgotten):

- Editing, language services, LSP — the Theia component's job, later.
- LLM evaluation of spec ↔ TLA+ correspondence — a separate service, later (following the local claude-CLI pattern the restatement critique service uses).
- PlusCal translation and TLAPS proof checking — natural future run kinds; not in v1.
- The TLA+ community modules — v1 ships only what `tla2tools.jar` bundles.
- Remote or shared execution — one machine, one user.
- Wiki-side reference/link modeling from pages to snapshots.

### 2. Toolchain management and health
The runner wraps `tla2tools.jar` — the official jar containing SANY (the parser/semantic analyzer) and TLC (the model checker) — executed with a Java runtime. Managing those two artifacts is the runner's problem, never the client's.

**Jar acquisition.** The runner pins an exact tools version as a build-time constant (e.g. `TLA_TOOLS_VERSION = "1.8.0"`). On boot it looks for `<dataDir>/tools/tla2tools-<version>.jar`; if absent it downloads the jar from the official `tlaplus/tlaplus` GitHub release and verifies a pinned SHA-256 checksum before installing it. A machine that already has the jar boots offline. `TLA_RUNNER_TOOLS_JAR=<path>` overrides with an explicit jar (recorded in run provenance verbatim).

**Java discovery.** Java ≥ 11 is required and never bundled: the runner resolves it from `TLA_RUNNER_JAVA` → `JAVA_HOME` → `java` on `PATH`, and probes `java -version` at boot.

**Standard modules.** The jar bundles the standard library (`Naturals`, `Integers`, `Sequences`, `FiniteSets`, `Bags`, `TLC`, …) — snapshots only ever carry _user_ modules, and `EXTENDS Naturals` just works. The community modules are **not** bundled (a future toolchain addition).

**Health.** The process always boots and serves `/health`, even with a broken toolchain — a missing Java is reported, not a crash loop:

```ts
interface IHealth {
  status: "ok" | "degraded";
  runner: string;                                   // tla-runner's own version
  tlaTools: { version: string; jarPath: string } | null;
  java: { version: string; path: string } | null;
  reason?: string;                                  // present iff degraded
  queue: { running: number; queued: number };
}
```

While `degraded`, submitting work fails fast with HTTP 503 `toolchain-unavailable`; existing run records remain readable. The runner re-probes the toolchain on each `/health` request, so installing Java heals the process without a restart.

### 3. Snapshots — the immutable input
The unit of input is a **snapshot**: a complete, self-contained set of TLA+ modules with a designated root. Snapshots are immutable and content-addressed — editing a module produces a _new_ snapshot, never a mutation of an old one.

```ts
interface ISnapshot {
  rootModule: string;                               // must name one of modules[]
  modules: { name: string; source: string }[];      // the full module set, root included
}
```

**Validation** (rejected with HTTP 400 before any tool runs):

- `modules[].name` values are unique, and one of them equals `rootModule`.
- Each module's `name` equals the name in its `---- MODULE <name> ----` header — the invariant that lets the runner materialize `<name>.tla` files the toolchain will accept.
- Sources are UTF-8 text; CRLF is normalized to LF on ingest.

Anything deeper — unresolved `EXTENDS`, syntax errors — is SANY's verdict to deliver through a run, not upload validation.

**Identity.** `snapshotId = "snap:" + sha256hex(canonical form)`, where the canonical form is the module list sorted by name, LF-normalized, with `rootModule` included — so identical content always has the identical id, uploads are idempotent and race-free, and a snapshot id embedded anywhere (a wiki page, a run record, a chat log) is a permanent, unambiguous reference to exact content. The id is minted server-side; clients never compute the hash.

Snapshots enter the store two ways: an explicit `POST /snapshots`, or inline in a run submission (`POST /runs` with `snapshot` instead of `snapshotId`), which registers-or-dedups and then enqueues in one call. `GET /snapshots/{snapshotId}` returns the stored content — what the Theia component will later open, and what makes every run's input auditable forever.

### 4. Runs and the run FSM
A **run** is one execution of the toolchain against one snapshot. Run records are immutable history: a retry is a _new_ run, never a reset of an old one.

```ts
type RunKind = "parse" | "check" | "simulate";
type RunStatus = "queued" | "running" | "passed" | "failed" | "errored" | "cancelled";

interface IRun {
  runId: string;                       // "run:" + monotonic id; mint order = queue order
  kind: RunKind;
  snapshotId: string;
  status: RunStatus;
  config?: IRunConfig;                 // check/simulate only
  options: Required<IRunOptions>;      // as resolved, defaults filled in
  seed?: number;                       // check/simulate: ALWAYS recorded, minted if not supplied
  effectiveCfg?: string;               // the exact .cfg text TLC ran with
  toolchain: { runner: string; tlaTools: string; java: string };
  createdAt: string; startedAt?: string; finishedAt?: string;   // ISO timestamps
  result?: IParseResult | ICheckResult;   // present iff passed or failed
  error?: {                               // present iff errored
    kind: "timeout" | "oom" | "tool-crash" | "toolchain-unavailable" | "interrupted" | "internal";
    message: string;
  };
}
```

**Kinds.** `parse` runs SANY (syntax + level/semantic checking) and needs no config. `check` runs TLC exhaustively. `simulate` runs TLC in simulation mode — random behavior sampling, for models whose state space is too large to enumerate.

**The FSM.** Transitions, exhaustively:

| From | Event | To |
| --- | --- | --- |
| `queued` | a worker slot frees and picks this run | `running` |
| `queued` | client cancel | `cancelled` |
| `running` | tool completes with a positive verdict | `passed` |
| `running` | tool completes with a negative verdict | `failed` |
| `running` | the run infrastructure breaks | `errored` |
| `running` | client cancel (process tree killed) | `cancelled` |

**The load-bearing distinction.** A run is `failed` when the tool worked and delivered a negative verdict about _your input_ (parse errors, an invariant violation, deadlock, an evaluation error) — `result` is populated and structured. A run is `errored` when no verdict was delivered (timeout, OOM, tool crash, missing toolchain) — `error` says why, and the raw output is retained for forensics. A learner staring at `failed` should study their spec; at `errored`, the runner or their machine.

Terminal states (`passed` / `failed` / `errored` / `cancelled`) are terminal — no transition leaves them. On boot the runner reconciles its journal: any run found `queued` or `running` (i.e. the process died mid-flight) is marked `errored` with `kind: "interrupted"` — the record never lies about work that didn't finish.

### 5. Run configuration
`check` and `simulate` need what the TLA+ Toolbox calls a _model_: which behavior spec to check, values for the constants, and what to verify. TLC takes this as a `.cfg` file; the runner generates it from a structured config — structured-first is the wiki's ethos, and it is what future UI and LLM clients can author reliably.

```ts
type IRunConfig =
  | { cfg: {
        behavior: { spec: string } | { init: string; next: string };  // SPECIFICATION, or INIT/NEXT
        constants?: Record<string, string>;   // CONSTANT name = <TLA+ expression>
        invariants?: string[];                // INVARIANT — state predicates to check
        properties?: string[];                // PROPERTY — temporal properties to check
        constraints?: string[];               // CONSTRAINT — state-space bounding predicates
        checkDeadlock?: boolean;              // default true
      } }
  | { cfgSource: string };                    // raw .cfg passthrough, verbatim
```

`cfgSource` is the escape hatch: every TLA+ tutorial teaches raw `.cfg` syntax, and a learner following one must be able to paste it. The two forms are mutually exclusive; the structured form covers the everyday subset (behavior, constants, invariants, properties, constraints, deadlock) and grows features — symmetry sets, model values, `VIEW` — only as real use demands.

**Transparency rule.** Whatever the input form, the run records `effectiveCfg` — the exact `.cfg` text TLC ran with. A learner can always see precisely what was checked; the structured form is never a black box.

```ts
interface IRunOptions {                 // all optional; resolved values echoed on the run
  workers?: number | "auto";            // TLC worker threads; default 1 (deterministic exploration)
  seed?: number;                        // TLC -seed; default: minted by the runner, always recorded
  timeoutSeconds?: number;              // wall-clock kill; default 600, capped by the server (3600)
  maxHeapMb?: number;                   // the JVM's -Xmx; default 1024
  simulate?: {                          // kind:"simulate" only
    traceCount?: number;                //   behaviors to sample; default 100
    maxTraceLength?: number;            //   max steps per behavior; default 100
  };
}
```

Config is validated shallowly at submission (shape, mutual exclusion, option ranges); whether e.g. an invariant _name_ actually exists in the module is TLC's verdict, reported as a `failed` run — the runner never re-implements toolchain judgment.

### 6. Results — diagnostics, statistics, traces
Results are structured for programmatic consumers (trace viewers, editor squiggles, LLM critics), with the raw tool output always retained alongside (`GET /runs/{runId}/output`) — structure is a projection, never a replacement.

**Parse results** (`kind: "parse"`; also embedded in check runs that die in SANY):

```ts
interface IDiagnostic {
  severity: "error" | "warning";
  module: string;
  range?: { start: { line: number; column: number };    // 1-based, inclusive — SANY's own
            end:   { line: number; column: number } };  // convention; absent when SANY gives none
  message: string;
}
interface IParseResult { ok: boolean; diagnostics: IDiagnostic[]; }
```

**Check results** (`kind: "check" | "simulate"`):

```ts
interface ICheckResult {
  verdict: "ok" | "invariant-violation" | "property-violation"
         | "deadlock" | "assumption-violation" | "evaluation-error";
  statesGenerated: number;
  distinctStates: number;
  depth: number;                 // diameter reached (check) / longest sampled behavior (simulate)
  violated?: string;             // the violated invariant/property, when TLC names one
  trace?: ITrace;                // the counterexample, when TLC produces one
  warnings: string[];            // e.g. fingerprint-collision probability notes
}
```

`evaluation-error` is TLC failing to _evaluate_ the spec (`Head` of an empty sequence, incomplete `CASE`, …) — a defect in the model, hence a `failed` verdict with the offending behavior as its trace, not an `errored` run. On `simulate`, `verdict: "ok"` means only "no violation in the sampled behaviors" — a weaker claim than exhaustive `check`, and clients presenting results must say so.

**Traces** — the counterexample behavior, the artifact learners will stare at most:

```ts
interface ITrace {
  states: ITraceState[];
  loopBackTo?: number;           // liveness lasso: the 1-based state index the behavior revisits
}
interface ITraceState {
  index: number;                 // 1-based, matching TLC's own numbering
  action?: string;               // the action taken to reach this state; absent for state 1
  variables: Record<string, string>;   // every variable, as pretty-printed TLA+ values
  changed: string[];             // variables differing from the predecessor; [] for state 1
}
```

Values are canonical pretty-printed TLA+ text (`<<1, "a">>`, `[n \in Nodes |-> 0]`) — faithful and universal; a structured value encoding is a possible later addition, not v1. `changed` is computed by the runner so a trace viewer can highlight the diff between states without parsing TLA+ values.

**Provenance of the structure.** The runner launches TLC in `-tool` mode, whose tagged message protocol identifies progress, verdicts, and trace states unambiguously; the verdict mapping keys off those message classes (exit codes only as fallback). Structured parsing failing on some output never hides a result: the run still terminates with the correct status, `warnings` notes the parse gap, and the raw output has the truth.

### 7. The HTTP API
JSON over HTTP on `127.0.0.1:4441` (the next port after the family: 4437 stream / 4438 control / 4439 mcp / 4440 mirror health). Mutating requests are `POST` with JSON bodies.

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Liveness + toolchain readiness (`IHealth`). Never requires the toolchain. |
| `POST /snapshots` | Register a snapshot. Body `ISnapshot` → `200 { snapshotId }`. Idempotent by content. |
| `GET /snapshots/{snapshotId}` | The stored `ISnapshot`. |
| `POST /runs` | Enqueue a run → `202 { runId, snapshotId }`. |
| `GET /runs/{runId}` | The full `IRun`, result embedded once terminal. |
| `GET /runs` | Newest-first summaries; filters `?kind=&status=&snapshotId=&limit=` (default limit 50). |
| `POST /runs/{runId}/cancel` | Request cancellation → `200` with the run's current status. Idempotent; cancelling a terminal run is a no-op. |
| `GET /runs/{runId}/events` | Live SSE observation (next section). |
| `GET /runs/{runId}/output` | Raw combined tool stdout+stderr, `text/plain`; grows live while running. |
| `POST /parse` | Synchronous SANY fast path for editors: body `{ snapshot }` or `{ snapshotId }` → `IParseResult` directly. Records **no** run. |

**Submitting a run:**

```ts
interface INewRun {
  kind: RunKind;
  snapshotId?: string;        // exactly one of snapshotId | snapshot
  snapshot?: ISnapshot;       // inline: register-or-dedup, then enqueue, in one call
  config?: IRunConfig;        // required for check/simulate; forbidden for parse
  options?: IRunOptions;
}
```

**Sync parse vs. a parse run.** Same SANY execution, different contracts: `/parse` is the low-latency editor loop (diagnostics on save — bounded by a short server-side timeout, nothing persisted), while a `parse` _run_ is for when the record matters — a citable "this snapshot compiled" fact in the run history.

**Errors.** Every non-2xx response carries `{ error: { code, message } }`:

| HTTP | `code` | When |
| --- | --- | --- |
| 400 | `invalid-request` | Malformed body, bad option values, config/kind mismatch |
| 400 | `module-header-mismatch` | A module's `name` ≠ its `MODULE` header |
| 404 | `unknown-snapshot` / `unknown-run` | No such id |
| 429 | `queue-full` | The pending queue is at its limit |
| 503 | `toolchain-unavailable` | Degraded health; `message` mirrors `IHealth.reason` |
| 504 | `parse-timeout` | Synchronous `/parse` exceeded its bound |

### 8. Live observation — the events stream
`GET /runs/{runId}/events` is Server-Sent Events — the browser-native protocol wiki-ui already lives on for stream tailing. The stream carries three event types:

- `state` — the run's FSM in motion. One frame is sent immediately on connect (the current state, so a late subscriber is instantly correct), then one per transition. Data: `{ status, position?, run? }` — `position` is the 0-based queue position while `queued`; the terminal frame embeds the full `IRun` (result included), after which the server closes the stream. Subscribing to an already-terminal run yields exactly that one frame.
- `progress` — TLC's periodic statistics while `running`: `{ statesGenerated, distinctStates, queueSize, depth, elapsedSeconds }`. Parsed from `-tool`-mode progress messages; absent for `parse` runs.
- `output` — raw tool output lines, batched: `{ lines: string[] }`, flushed at ≤ 250 ms or 64 lines. The same bytes `GET /runs/{runId}/output` serves — streamed here so a UI shows TLC thinking without polling.

**Resume.** Every event carries an `id:` — a per-run monotonic sequence, journaled with the run — and the endpoint honors `Last-Event-ID`, replaying anything missed since. A dropped connection (laptop lid, dev-server restart) resumes losslessly; reconnecting after termination replays the tail and closes.

The stream is observation only: no client → server control flows over it (cancellation is `POST /runs/{runId}/cancel`), and any number of concurrent subscribers per run is fine.

### 9. Execution, persistence, and reproducibility
**Execution.** One FIFO queue; at most `maxConcurrentRuns` tool processes execute at once (default 1 — TLC saturates cores by itself via `workers`, and a learning machine wants one hungry JVM, not several). The pending queue caps at 32 (`queue-full` beyond it). Each run executes in a private scratch directory: modules materialized as `<Name>.tla`, the effective `.cfg` written beside them, TLC's metadata directory pointed inside, everything discarded after the run except the retained artifacts. The tool is invoked as `java -Xmx<maxHeapMb>m -cp tla2tools.jar` + `tlc2.TLC -tool ...` (or `tla2sany.SANY` for parse) in its own **process group**.

**Cancellation and timeouts kill the tree.** Cancel and timeout share one path: SIGTERM to the process group, SIGKILL after a 5-second grace — never just the direct child (the kill-tree lesson the claude-CLI critique service already learned). Timeout marks the run `errored`/`timeout`; cancel marks it `cancelled`; both preserve all output produced so far.

**Persistence.** Everything lives under `<dataDir>` (default `~/.wiki/tla-runner/`):

```text
tools/tla2tools-<version>.jar        the pinned, checksum-verified toolchain
snapshots/<sha256>.json              content-addressed snapshot store
runs/<runId>/run.json                the IRun record (rewritten on each transition)
runs/<runId>/output.log              raw tool output (the artifact endpoints read these)
runs/<runId>/events.jsonl            the SSE journal backing Last-Event-ID resume
```

Run history survives restarts; the boot reconciliation (interrupted runs → `errored`) plus retention — newest 500 runs kept, older ones garbage-collected at boot, snapshots collected once no retained run references them — keeps the directory bounded without ever silently losing a _recent_ result.

**Process configuration** follows the house convention, `flags → env (TLA_RUNNER_*) → defaults`: `port` (4441), `host` (127.0.0.1), `dataDir`, `maxConcurrentRuns`, `timeoutSeconds` cap, `corsOrigins` (default `http://localhost:3000`), `toolsJar`, `java`.

**Reproducibility.** Every check/simulate run permanently records its complete causal inputs: `snapshotId`, `effectiveCfg`, `seed` (always — minted when the client didn't supply one), `workers`, and toolchain versions. With `workers: 1`, identical inputs and seed on the same toolchain reproduce the identical verdict _and_ the identical trace; with `workers > 1`, the verdict is stable but the particular counterexample may differ (exploration order races) — which is why 1 is the default. The pair `(snapshotId, runId)` is thus a permanent, self-describing evidence pointer — exactly what a wiki page will later cite, and what the LLM critique loop will consume as ground truth about what was checked and what happened.

## Review
_Not reviewed._

## Open notes
_None._
