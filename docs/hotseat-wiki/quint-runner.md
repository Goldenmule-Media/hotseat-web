# Spec: Quint runner

**Status:** restating

## Sections
### Motivation
The long-term goal is learning by formalizing. A wiki page, especially a spec restatement, references one or more formal specifications. A Theia-based editor component in the page editor authors them. An LLM critique loop judges whether the prose spec and the formal specification describe the same system. The chosen formalism is Quint, a modern surface syntax for TLA+-style specification (the reasons for choosing it over raw TLA+ are in the Overview).

None of that can be built today, because nothing in this ecosystem can run the Quint tools.

- Running the Quint checker means installing the CLI by hand and driving it from a terminal, plus a Java runtime for its verification backends. A browser client, a CLI, an agent, or a future editor component has nothing to call.
- Results are scattered across console output and output files. There is no single service that turns a specification into structured diagnostics, verdicts, statistics, and counterexample traces that a UI or an LLM critic can consume.
- Nothing is recorded. A check that passed is a memory, not a citable fact. There is no permanent record of input, run, and result that a wiki page could cite as evidence.

Every planned piece is blocked on the same missing foundation: the editor component, the critique loop, and wiki-side references to specifications.

### Overview
`quint-runner` is a Node process that receives Quint sources over HTTP and runs them with the `quint` toolchain.

### Why Quint?
**Why Quint rather than raw TLA+.** Quint is TLA+ underneath. It translates to TLA+, and its verification backends are the TLA+ model checkers (Apalache, and TLC since Quint v0.31.0). The concepts a learner absorbs (state machines, actions, invariants, temporal properties) are the TLA+ concepts. What Quint adds is tooling built for programs rather than for humans reading a terminal: the parser and typechecker emit JSON with source locations, counterexample traces arrive in the documented ITF JSON format, simulation is seeded and reproducible, and a real language server exists for the later Theia stage. The runner therefore spends its effort on queueing, persistence, and provenance instead of on reverse-engineering another tool's console output. The trade-offs accepted with this choice: thinner learning materials than TLA+'s books and courses, bounded verification by default, and a younger project.

The design rests on two ideas.

1. **Immutable, content-addressed inputs.** The unit of input is a snapshot: a complete, self-contained set of Quint source files with a designated entry file, identified by a hash of its content. Editing a file produces a new snapshot. An old snapshot is never mutated.
2. **Immutable run records.** A run is one execution of the toolchain against one snapshot. It is journaled with its complete causal inputs: the snapshot, the exact CLI arguments, the seed, and the toolchain versions. A retry is a new run, not a reset of an old one. The pair `(snapshotId, runId)` is a permanent, self-describing pointer to evidence. That is what a wiki page will later cite, and what the LLM critique loop will consume as ground truth about what was checked and what happened.

There are three run kinds, each wrapping one Quint CLI verb.

- A `parse` run wraps `quint typecheck`: syntax, type, and effect checking. It needs no config and no Java.
- A `simulate` run wraps `quint run`: seeded random exploration that checks invariants over sampled executions. It needs no Java.
- A `verify` run wraps `quint verify`: model checking, through the Apalache symbolic backend (bounded depth, the default) or the TLC backend (exhaustive, for finite state spaces). Both backends run on a Java runtime.

There is also a synchronous `POST /parse` fast path for the low-latency editor loop. It runs the same typecheck, returns diagnostics directly, and persists nothing. A `parse` run is for when the record matters, because it leaves a citable "this snapshot typechecked" fact in the run history.

The runner is wiki-agnostic. It imports none of `wiki`, `wiki-models`, or `wiki-mcp` and knows nothing about pages, workspaces, or streams. Its clients are anything that can speak HTTP on the local machine: `wiki-ui` in the browser (via CORS), a future Theia backend, CLIs, and agents. How wiki pages reference Quint snapshots is a later `wiki-models` concern and is deliberately out of this spec.

The trust model is local-only. The server binds to loopback (`127.0.0.1`) by default and has no authentication, which is the same stance as `wiki-mirror`. CORS is enabled for configured browser origins, defaulting to `http://localhost:3000`, where wiki-ui runs.

The following are explicitly not goals of v1.

- Editing, language services, and LSP. The Theia component will embed `quint-language-server` directly, later. The runner serves batch results only.
- LLM evaluation of whether a spec and its formalization correspond. That is a separate service, later, following the local claude-CLI pattern the restatement critique service uses.
- The `quint test` run kind and the `quint compile --target tlaplus` export. Both are natural future run kinds.
- Remote or shared execution. This is one machine and one user.
- Wiki-side reference and link modeling from pages to snapshots.

### Run Kinds
There are three run kinds. A `parse` run executes SANY, the parser and semantic analyzer, and needs no config. A `check` run executes TLC exhaustively. A `simulate` run executes TLC in simulation mode, which randomly samples behaviors, for models whose state space is too large to enumerate. There is also a synchronous `POST /parse` fast path for the low-latency editor loop. It returns diagnostics on save and persists nothing. A `parse` run is the same SANY execution for when the record matters, because it leaves a citable "this snapshot compiled" fact in the run history.

The runner is wiki-agnostic. It imports none of `wiki`, `wiki-models`, or `wiki-mcp` and knows nothing about pages, workspaces, or streams. Its clients are anything that can speak HTTP on the local machine: `wiki-ui` in the browser (via CORS), a future Theia backend, CLIs, and agents. How wiki pages reference TLA+ snapshots is a later `wiki-models` concern and is deliberately out of this spec.

The trust model is local-only. The server binds to loopback (`127.0.0.1`) by default and has no authentication, which is the same stance as `wiki-mirror`. CORS is enabled for configured browser origins, defaulting to `http://localhost:3000`, where wiki-ui runs.

The following are explicitly not goals of v1.

- Editing, language services, and LSP. That is the Theia component's job, later.
- LLM evaluation of whether a spec and its TLA+ formalization correspond. That is a separate service, later, following the local claude-CLI pattern the restatement critique service uses.
- PlusCal translation and TLAPS proof checking. Both are natural future run kinds.
- The TLA+ community modules. v1 ships only what `tla2tools.jar` bundles.
- Remote or shared execution. This is one machine and one user.
- Wiki-side reference and link modeling from pages to snapshots.

### Data model & types
This section lists the complete data the runner manages, plus the HTTP surface that carries it.

**Snapshots.** The unit of input is a snapshot: a complete, self-contained set of Quint source files with a designated entry file.

```ts
interface ISnapshot {
  main: string;                                  // path of the entry file, must name one of files[]
  files: { path: string; source: string }[];     // the full source set, main included
}
```

Paths are relative, use forward slashes, and may not contain `..` segments or a leading slash, so materializing a snapshot can never write outside its scratch directory. Cross-file imports in the sources use Quint's own relative-path form (`import Foo.* from "./foo"`), which is why paths, not module names, are the file identity.

A snapshot's identity is `snapshotId = "snap:" + sha256hex(canonical form)`. The canonical form is the file list sorted by path, LF-normalized, with `main` included. The server mints the id. Clients never compute the hash. A snapshot id embedded anywhere (a wiki page, a run record, a chat log) is a permanent and unambiguous reference to exact content.

**Runs.** A run is one execution of the toolchain against one snapshot.

```ts
type RunKind = "parse" | "simulate" | "verify";
type RunStatus = "queued" | "running" | "passed" | "failed" | "errored" | "cancelled";

interface IRun {
  runId: string;                       // "run:" + monotonic id, minted in queue order
  kind: RunKind;
  snapshotId: string;
  status: RunStatus;
  config?: IRunConfig;                 // simulate/verify only
  options: Required<IRunOptions>;      // as resolved, defaults filled in
  effectiveArgs: string[];             // the exact CLI argv the tool ran with
  toolchain: { runner: string; quint: string; apalache?: string; java?: string };
  createdAt: string; startedAt?: string; finishedAt?: string;   // ISO timestamps
  result?: IParseResult | ICheckResult;   // present iff passed or failed
  error?: {                               // present iff errored
    kind: "timeout" | "oom" | "tool-crash" | "toolchain-unavailable" | "interrupted" | "internal";
    message: string;
  };
}
```

**Run configuration.** Quint takes its model configuration as CLI flags rather than a config file, so the structured config maps directly onto flags.

```ts
interface IRunConfig {                  // simulate and verify
  mainModule?: string;                  // --main, the module to check, tool default when absent
  init?: string;                        // --init, custom init action, tool default "init"
  step?: string;                        // --step, custom step action, tool default "step"
  invariants?: string[];                // --invariant, state predicates to check
  temporal?: string[];                  // --temporal, temporal properties, verify only
  backend?: "apalache" | "tlc";         // verify only, default "apalache"
}
```

```ts
interface IRunOptions {                 // all optional, resolved values echoed on the run
  seed?: number;                        // simulate: minted by the runner if not supplied
  maxSamples?: number;                  // simulate: executions to sample, default 10000
  maxSteps?: number;                    // steps per execution, default 20 (simulate), 10 (verify)
  timeoutSeconds?: number;              // wall-clock kill, default 600, server cap 3600
}
```

Whatever the input, the run records `effectiveArgs`, the exact argv the tool was invoked with. The structured config is never a black box.

**Results.** Results are structured for programmatic consumers such as trace viewers, editor squiggles, and LLM critics. The raw tool output is always retained alongside. Structure is a projection of the output, never a replacement for it.

Parse results apply to `kind: "parse"` and to any run that dies in typechecking. Ranges are normalized to 1-based inclusive positions.

```ts
interface IDiagnostic {
  severity: "error" | "warning";
  file: string;                        // the snapshot path the diagnostic points into
  range?: { start: { line: number; column: number };
            end:   { line: number; column: number } };
  code?: string;                       // the tool's error code, when it gives one
  message: string;
}
interface IParseResult { ok: boolean; diagnostics: IDiagnostic[]; }
```

Check results apply to `kind: "simulate"` and `kind: "verify"`.

```ts
interface ICheckResult {
  verdict: "ok" | "invariant-violation" | "temporal-violation" | "deadlock" | "runtime-error";
  okStrength?: "sampled" | "bounded" | "exhaustive";   // present iff verdict is "ok"
  violated?: string;             // the violated invariant or property, when the tool names one
  trace?: object;                // the counterexample as a verbatim ITF trace, when one exists
  stats: { samples?: number; steps?: number; states?: number };   // backend-dependent, best-effort
  warnings: string[];
}
```

A `runtime-error` means the evaluator failed to evaluate the spec, for example accessing a missing map key. That is a defect in the model, so it is a `failed` run. `okStrength` states how strong a clean result is: `sampled` (no violation in the sampled executions), `bounded` (none within `maxSteps`, the Apalache backend), or `exhaustive` (none anywhere, the TLC backend on a finite state space).

**Traces.** Counterexamples are stored and served verbatim in ITF, the Informal Trace Format, which is plain JSON:

```json
{
  "#meta": { "format": "ITF" },
  "vars": ["balance", "status"],
  "states": [
    { "#meta": { "index": 0 }, "balance": { "#bigint": "0" },  "status": "open" },
    { "#meta": { "index": 1 }, "balance": { "#bigint": "-5" }, "status": "open" }
  ]
}
```

Values use ITF's tagged forms: `{"#bigint": "n"}` for large integers, `{"#set": [...]}`, `{"#map": [[k, v], ...]}`, `{"#tup": [...]}`, and a loop index marks a liveness lasso. Because states are plain JSON, a trace viewer can diff consecutive states directly. The runner adds nothing to the trace and takes nothing away.

**Health.**

```ts
interface IHealth {
  status: "ok" | "degraded";
  runner: string;                                   // quint-runner's own version
  quint: { version: string };                       // the bundled CLI, pinned by the lockfile
  java: { version: string; path: string } | null;
  apalache: { version: string; cached: boolean } | null;
  verifyAvailable: boolean;                         // parse and simulate are always available
  reason?: string;                                  // present iff degraded
  queue: { running: number; queued: number };
}
```

**The HTTP surface.** The runner serves JSON over HTTP on `127.0.0.1:4441`, the next port after the family (4437 stream, 4438 control, 4439 mcp, 4440 mirror health). Mutating requests are `POST` with JSON bodies.

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Liveness plus toolchain readiness, as an `IHealth`. It never requires the toolchain. |
| `POST /snapshots` | Register a snapshot. The body is an `ISnapshot` and the response is `200 { snapshotId }`. Idempotent by content. |
| `GET /snapshots/{snapshotId}` | The stored `ISnapshot`. |
| `POST /runs` | Enqueue a run. The response is `202 { runId, snapshotId }`. |
| `GET /runs/{runId}` | The full `IRun`, with the result embedded once terminal. |
| `GET /runs` | Newest-first summaries, filtered by `?kind=&status=&snapshotId=&limit=` (default limit 50). |
| `POST /runs/{runId}/cancel` | Request cancellation. The response is `200` with the run's current status. Idempotent, and cancelling a terminal run is a no-op. |
| `GET /runs/{runId}/events` | Live SSE observation. The event shapes are described below. |
| `GET /runs/{runId}/output` | The raw combined tool stdout and stderr as `text/plain`. It grows live while the run executes. |
| `POST /parse` | The synchronous typecheck fast path for editors. The body is `{ snapshot }` or `{ snapshotId }` and the response is an `IParseResult` directly. It records no run. |

A run is submitted as:

```ts
interface INewRun {
  kind: RunKind;
  snapshotId?: string;        // exactly one of snapshotId | snapshot
  snapshot?: ISnapshot;       // inline: register-or-dedup, then enqueue, in one call
  config?: IRunConfig;        // simulate/verify only, forbidden for parse
  options?: IRunOptions;
}
```

Every non-2xx response carries `{ error: { code, message } }`.

| HTTP | `code` | When |
| --- | --- | --- |
| 400 | `invalid-request` | A malformed body, bad option values, or a config and kind mismatch |
| 400 | `invalid-path` | A file path is absolute, escapes the snapshot root, or duplicates another |
| 404 | `unknown-snapshot` / `unknown-run` | No such id |
| 429 | `queue-full` | The pending queue is at its limit |
| 503 | `toolchain-unavailable` | A `verify` run was submitted while Java is missing. Parse and simulate never return this |
| 504 | `parse-timeout` | The synchronous `/parse` exceeded its bound |

**Live events.** `GET /runs/{runId}/events` is Server-Sent Events, the browser-native protocol wiki-ui already uses for stream tailing. The stream carries three event types.

- `state` reports the run's FSM in motion. One frame is sent immediately on connect with the current state, so a late subscriber immediately has the truth, then one frame per transition. The data is `{ status, position?, run? }`. While the run is `queued`, `position` is its 0-based queue position. The terminal frame embeds the full `IRun`, result included, after which the server closes the stream.
- `progress` carries counters while the run executes: `{ elapsedSeconds, samples?, states? }`. The counters are parsed from tool output where the backend provides them and are absent otherwise.
- `output` carries raw tool output lines in batches of the form `{ lines: string[] }`, flushed at 250 ms or 64 lines, whichever comes first. These are the same bytes `GET /runs/{runId}/output` serves. They are streamed here so a UI can show live output without polling.

**On disk.** Everything lives under `<dataDir>`, which defaults to `~/.wiki/quint-runner/`.

```text
tools/                               the Apalache distribution cache the quint CLI fills
snapshots/<sha256>.json              content-addressed snapshot store
runs/<runId>/run.json                the IRun record (rewritten on each transition)
runs/<runId>/output.log              raw tool output (the artifact endpoints read these)
runs/<runId>/trace.itf.json          the counterexample trace, when one exists
runs/<runId>/events.jsonl            the SSE journal backing Last-Event-ID resume
```

### Algorithm
This is the runner's normative behavior, end to end. The types are defined in Data model & types.

The table below lists every transition in the run FSM.

| From | Event | To |
| --- | --- | --- |
| `queued` | a worker slot frees and picks this run | `running` |
| `queued` | client cancel | `cancelled` |
| `running` | tool completes with a positive verdict | `passed` |
| `running` | tool completes with a negative verdict | `failed` |
| `running` | the run infrastructure breaks | `errored` |
| `running` | client cancel (process tree killed) | `cancelled` |

**A. Snapshot ingest**, on `POST /snapshots` or inline in `POST /runs`.

1. Validate the upload, rejecting with HTTP 400 before any tool runs. Paths must be unique after normalization, relative, forward-slash, without `..` segments and without a leading slash. `main` must name one of the files. Sources must be UTF-8 text.
2. Normalize CRLF line endings to LF.
3. Canonicalize: sort the file list by path and include `main`.
4. Compute `snapshotId := "snap:" + sha256hex(canonical form)`, store the snapshot content-addressed, and return the id. Identical content yields the identical id, so uploads are idempotent and race-free.
5. Leave anything deeper, such as unresolved imports or syntax errors, for the tool to judge through a run. That is a verdict about the input, not upload validation.

**B. Run submission** (`POST /runs`).

1. If the body carries an inline `snapshot`, run A first to register or dedup it. Otherwise resolve `snapshotId`, returning 404 `unknown-snapshot` if it does not exist.
2. Validate shallowly: the shape, config present only for simulate and verify, `temporal` and `backend` only for verify, and option ranges. Whether an invariant name actually exists in the module is the tool's verdict and is reported as a `failed` run. The runner never re-implements toolchain judgment.
3. If the kind is `verify` and Java is missing, return 503 `toolchain-unavailable`. Parse and simulate need no Java and are never gated on it. If the pending queue is at its cap, return 429 `queue-full`.
4. Resolve the options, filling in defaults. For simulate, mint `seed` when the client did not supply one. The seed is always recorded.
5. Mint `runId` (monotonic, so mint order equals queue order), journal the run as `queued`, and return 202.

**C. Execution.** At most `maxConcurrentRuns` tool processes execute at once, from one FIFO queue.

1. Dequeue the run and transition it from `queued` to `running`.
2. Materialize a private scratch directory. Write each file at its relative path.
3. Build the argv from the kind, config, and options. A `parse` run invokes `quint typecheck <main>`. A `simulate` run invokes `quint run <main>` with `--seed`, `--max-samples`, `--max-steps`, `--out-itf`, and the config flags. A `verify` run invokes `quint verify <main>` with `--backend`, `--max-steps`, and the config flags. Record the argv as `effectiveArgs`.
4. Spawn the quint CLI in its own process group. For verify, the JVM the CLI launches is a child inside that group.
5. While the tool runs, journal raw output lines, which serve the `output` SSE events and `output.log`, and parse progress counters into `progress` events where the backend provides them.
6. When the tool exits, map the verdict as described in D. Discard the scratch directory and keep the retained artifacts: `run.json`, `output.log`, `trace.itf.json`, and `events.jsonl`.

**D. Verdict mapping.** The mapping keys off the tool's exit status together with its structured outputs: the typecheck diagnostics and the ITF trace file.

1. If the tool completed cleanly, the run is `passed`. For simulate the result carries `okStrength: "sampled"`. For verify it carries `"bounded"` on the Apalache backend and `"exhaustive"` on the TLC backend.
2. If the tool delivered a negative verdict about the input, the run is `failed` with the structured result: diagnostics for parse and type errors, or an `ICheckResult` naming the violated property, with the ITF trace when the tool wrote one. A runtime evaluation error is a defect in the model and lands here, not in `errored`.
3. If no verdict was delivered (timeout, OOM, tool crash, missing toolchain, interrupted, internal), the run is `errored` and `error.kind` says why.
4. If structured parsing failed on some output, the run still terminates with the correct status and `warnings` notes the gap. The raw output has the truth.

**E. Cancellation and timeout.** Both share one kill path.

1. Send SIGTERM to the process group, then SIGKILL after a 5-second grace period. Never signal just the direct child, because a verify run is a process tree with a JVM under the CLI.
2. A timeout marks the run `errored` with kind `timeout`. A client cancel marks it `cancelled`. Both preserve all output produced so far.
3. Cancelling a `queued` run dequeues it to `cancelled`. Cancelling a terminal run is a no-op that returns the current status.

**F. Boot.**

1. Probe Java (see Data dependencies). Boot and serve `/health` regardless of the outcome.
2. When Java is present and the Apalache distribution is not cached, pre-fetch it in the background so the first verify run does not pay the download.
3. Reconcile the journal. Any run found `queued` or `running` means the process died while that run was in progress, so mark it `errored` with kind `interrupted`. The record must never claim that unfinished work finished.
4. Apply retention. Keep the newest 500 runs, garbage-collect older ones, and collect snapshots once no retained run references them.

### Invariants & limits
- **Snapshot immutability.** A snapshot is never mutated. Editing a file produces a new snapshot.
- **Content addressing.** `snapshotId` is `"snap:" + sha256hex` of the canonical form, which is the file list sorted by path, LF-normalized, with `main` included. Identical content always has the identical id. Only the server mints ids.
- **Path safety.** Every stored path is relative, forward-slash, without `..` segments and without a leading slash, so materializing a snapshot can never write outside its scratch directory.
- **Run immutability.** Run records are immutable history. A retry is a new run, never a reset of an old one.
- **Terminal is terminal.** No transition leaves `passed`, `failed`, `errored`, or `cancelled`.
- **Failed versus errored.** A run is `failed` exactly when the tool delivered a negative verdict about the input, and then `result` is populated. A run is `errored` exactly when no verdict was delivered, and then `error` says why. The two are never conflated.
- **Provenance completeness.** Every run permanently records `effectiveArgs`, the resolved options, the seed (for simulate), and the toolchain versions.
- **Transparency.** `effectiveArgs` is the exact argv the tool ran with. The structured config is never a black box.
- **Claim strength is explicit.** A clean result always carries `okStrength`. Only the TLC backend yields `exhaustive`. The Apalache backend yields `bounded` and simulate yields `sampled`. Clients must present the difference.
- **Simulate reproducibility.** A simulate run with the same snapshot, seed, options, and toolchain reproduces the same verdict and the same trace. Verify records its complete inputs but the spec does not promise identical counterexamples across verify runs, because the solver may explore differently.
- **Raw output retained.** The raw tool output is always kept alongside the structured result. Structure is a projection, never a replacement.
- **Traces are verbatim.** A counterexample is stored and served exactly as the tool emitted it, in ITF. The runner adds nothing and takes nothing away.
- **Always boots.** The process always boots and serves `/health`, even with a broken toolchain. A missing Java degrades only `verify`. Parse and simulate never require Java.
- **Pinned toolchain.** The quint CLI is a regular npm dependency pinned by the package lockfile, so a given build carries exactly one CLI version. The Apalache version is whatever that CLI manages, and it is recorded per run.
- **Bounds.** The pending queue holds at most 32 runs. `timeoutSeconds` defaults to 600 and the server caps it at 3600. `maxSamples` defaults to 10000. `maxSteps` defaults to 20 for simulate and 10 for verify. `maxConcurrentRuns` defaults to 1. `GET /runs` defaults to a limit of 50.
- **Retention.** The newest 500 runs are kept. Older runs are garbage-collected at boot, and snapshots are collected once no retained run references them. A recent result is never silently lost.
- **Mutual exclusions.** A submission carries exactly one of `snapshotId` or `snapshot`. Config is forbidden for parse. `temporal` and `backend` are verify-only.
- **Kill the tree.** Cancellation and timeout kill the whole process group, never just the direct child.
- **Observation-only stream.** No client-to-server control flows over `/events`. Event ids are per-run, monotonic, and journaled.
- **Sync parse records nothing.** `POST /parse` persists no run.
- **Local-only trust.** The server binds to loopback (`127.0.0.1`) by default with no authentication. CORS is enabled only for configured browser origins.

### Failure & concurrency semantics
A missing verdict is not a negative verdict. A run is `failed` when the tool worked and delivered a negative verdict about the input, and in that case `result` is populated and structured. A run is `errored` when no verdict was delivered, and in that case `error.kind` is one of `timeout`, `oom`, `tool-crash`, `toolchain-unavailable`, `interrupted`, or `internal`, and the raw output is retained for forensics. A learner looking at a `failed` run should study their spec. A learner looking at an `errored` run should look at the runner or their machine.

A missing Java degrades only verification. Parse and simulate keep working, because the CLI and its evaluator need no JVM. `/health` reports `degraded` with a `reason` and `verifyAvailable: false`, and submitting a `verify` run fails fast with 503 `toolchain-unavailable`. Existing run records remain readable. Java is re-probed on each `/health` request, so installing it heals the process without a restart, and the Apalache pre-fetch then runs.

The Apalache distribution may not be cached when the first verify run executes. The quint CLI fetches it on demand. If that fetch fails, for example offline, the run is `errored` with kind `toolchain-unavailable` and the raw output says why. A later verify run retries the fetch. A machine with a warm cache verifies offline.

If the process dies, the journal is reconciled on the next boot. Any run found `queued` or `running` is marked `errored` with kind `interrupted`, so the record never claims that unfinished work finished. A `queued` or `running` status is therefore provisional until a terminal state is reached. Terminal states are permanent.

Cancellation and timeout share one kill path: SIGTERM to the process group, then SIGKILL after a 5-second grace period. The runner never signals just the direct child, because a verify run is a process tree with a JVM under the CLI. A timeout marks the run `errored` with kind `timeout`. A cancel marks it `cancelled`. Both preserve all output produced so far. Cancel is idempotent, and cancelling a terminal run is a no-op.

Backpressure is explicit. The pending queue caps at 32 runs, and submission beyond that fails with 429 `queue-full` rather than accepting unbounded work. The synchronous `/parse` endpoint is bounded by a short server-side timeout and fails with 504 `parse-timeout`.

Concurrency is deliberately narrow. There is one FIFO queue, and at most `maxConcurrentRuns` tool processes execute at once. The default is 1, because the checker backends are resource-hungry JVM processes and one at a time keeps a development machine usable. Snapshot registration is idempotent by content, so concurrent identical uploads converge on the same id. Any number of concurrent SSE subscribers per run is fine.

A dropped observer loses nothing. Every SSE event carries an id from a per-run monotonic sequence that is journaled with the run, and the events endpoint honors `Last-Event-ID` by replaying anything missed. Subscribing to an already-terminal run yields exactly one `state` frame, the terminal one with the full `IRun` embedded. Reconnecting after termination replays the tail and closes.

A gap in structured parsing never hides a result. If the runner fails to parse some tool output, the run still terminates with the correct status, `warnings` notes the gap, and the raw output has the truth.

A weaker claim stays labeled. A clean result is only as strong as its `okStrength` says: `sampled` means no violation in the sampled executions, `bounded` means none within the step bound, and only `exhaustive` (the TLC backend) means none anywhere. Clients presenting results must say which one they have.

### Data dependencies
Every input the runner reads is listed here, with how it reaches the place that reads it and what happens in the window before it arrives.

- **The quint CLI.** A regular npm dependency of the `quint-runner` package, pinned to an exact version by the lockfile and installed at build time like any other dependency. There is no arrival window: if the package installed, the CLI is present. Its version is reported by `/health` and recorded on every run.
- **Java 17 or newer**, required only for `verify` and never bundled. The runner resolves it from `QUINT_RUNNER_JAVA`, then `JAVA_HOME`, then `java` on `PATH`, and probes `java -version` at boot. It re-probes on each `/health` request. Before Java arrives, verify submissions fail with 503 while parse and simulate work normally. Installing Java heals the process without a restart.
- **The Apalache distribution.** Fetched and managed by the quint CLI itself on first use, cached under `<dataDir>/tools/`, and pre-fetched at boot when Java is present and the cache is empty. Before it arrives, the first verify run pays the download, and if the fetch fails the run is `errored` with kind `toolchain-unavailable` (see Failure & concurrency semantics). A machine with a warm cache verifies offline. The version in use is recorded on every verify run.
- **Snapshots**, which arrive over HTTP in two ways: an explicit `POST /snapshots`, or inline in a run submission, where `POST /runs` carries `snapshot` instead of `snapshotId` and the runner registers or dedups it and then enqueues in one call. Before a snapshot exists, a run naming its id gets 404 `unknown-snapshot`. `GET /snapshots/{snapshotId}` returns the stored content. That is what the Theia component will later open, and it is what makes every run's input auditable forever.
- **Run config and options**, which arrive with the submission and are validated shallowly for shape, kind rules, and option ranges. Whether an invariant name actually exists in the module is the tool's verdict, reported as a `failed` run. The runner never re-implements toolchain judgment.
- **Process configuration**, resolved as flags, then env (`QUINT_RUNNER_*`), then defaults: `port` (4441), `host` (127.0.0.1), `dataDir` (`~/.wiki/quint-runner/`), `maxConcurrentRuns`, the `timeoutSeconds` cap, `corsOrigins` (default `http://localhost:3000`), and `java`.
- **Prior state on disk.** The run journal and snapshot store under `<dataDir>` are read once at boot for reconciliation and retention (see Algorithm). A wiped `dataDir` is simply an empty runner. Nothing else depends on it.

### Migration & existing data
Nothing exists yet. `quint-runner` is a brand-new package with its own private `<dataDir>`, defaulting to `~/.wiki/quint-runner/`. There is no existing data to migrate. The spec itself began life as a TLA+ runner and was reworked to Quint before any code or data existed, so there is no TLA+-era data to carry over either. There is also no wiki-side schema to evolve, because wiki pages do not yet reference snapshots. That is a later `wiki-models` concern, deliberately out of this spec (see Overview).

The record formats are still designed to survive change.

- Snapshots are content-addressed, so the store survives runner upgrades untouched. An id never changes meaning.
- Every run embeds its toolchain versions, so upgrading the pinned quint CLI rewrites no history. Old runs keep an accurate record of what produced them.
- `kind` is an enum and snapshot files are format-agnostic paths, so a future run kind (`quint test`, a raw TLA+ kind, the `--target tlaplus` export) extends the model without reshaping it.
- Boot reconciliation and retention (see Algorithm) already absorb a `dataDir` left behind by a dead process. Interrupted runs are marked `errored`, old runs age out, and orphaned snapshots are collected. Nothing is silently repaired, and no recent result is silently lost.

### Staged plan
1. **Process, health, toolchain.** This stage ships the `quint-runner` package skeleton (tsdown/tsx, the pinned quint CLI dependency, config resolved as flags, then env, then defaults), `GET /health`, Java discovery, and the boot-time Apalache pre-fetch. It does not yet run any tool or accept any work. Exit test: on a machine with Java, boot pre-fetches the Apalache distribution and `/health` reports `ok` with quint and Java versions. Without Java, the process still boots, reports `verifyAvailable: false` with a reason, and heals on a later `/health` probe after Java is installed, without a restart.
2. **Snapshots and synchronous parse.** This stage ships the content-addressed snapshot store (`POST` and `GET /snapshots`, with path validation and canonical hashing) and `POST /parse` wrapping `quint typecheck`. It does not yet have runs, a queue, or any persisted results. Exit test: identical uploads return the identical `snapshotId`. `/parse` returns structured diagnostics with source ranges for a known-bad module and `ok: true` for a known-good one. A snapshot with a `..` path segment is rejected with 400 before any tool runs.
3. **Simulate runs: queue, persistence, traces.** This stage ships the run FSM, the FIFO queue with its caps, the `parse` and `simulate` run kinds, `effectiveArgs` recording, ITF trace capture, `run.json` and `output.log` persistence, boot reconciliation, retention, `GET /runs`, `GET /runs/{runId}`, `GET /runs/{runId}/output`, and cancel with the process-group kill. None of it needs Java. It does not yet verify or stream events, so observation is polling `GET /runs/{runId}`. Exit test: a simulate run of a spec with a seeded invariant violation lands `failed` with the violated name and an ITF trace, and rerunning with the same seed reproduces the identical trace. A `kill -9` mid-run followed by a reboot yields `errored` with kind `interrupted`. Cancel kills the whole process tree and preserves the output produced so far.
4. **Verify and live observation.** This stage ships the `verify` kind on both backends (Apalache bounded, TLC exhaustive, with `okStrength` labeling) and the `GET /runs/{runId}/events` SSE stream (`state`, `progress`, and `output` events, journaled ids, `Last-Event-ID` resume). It ships nothing from the non-goals list (see Overview): LSP, LLM critique, `quint test`, the TLA+ export, and remote execution all stay out. Exit test: an Apalache verify of a known-violating spec lands `failed` with an ITF trace, and a clean TLC-backend verify reports `okStrength: "exhaustive"` where the Apalache backend reports `"bounded"`. A subscriber sees the connect frame, the queue position, progress counters, and a terminal frame embedding the full `IRun`. Dropping the connection mid-run and reconnecting with `Last-Event-ID` replays the gap losslessly. Subscribing to an already-terminal run yields exactly one frame.
5. **A real spec.** This stage formalizes one real workspace design in Quint (the spec-restatement section FSM with concurrent restatement and revision is the natural first target) and checks it through the runner end to end. It ships no new runner features. Exit test: the formalization typechecks, simulate finds no invariant violation over the default samples, and a deliberate mutation of one invariant produces a `failed` verify run whose ITF trace the author can read and explain.

## Review
_Not reviewed._

## Open notes
_None._
