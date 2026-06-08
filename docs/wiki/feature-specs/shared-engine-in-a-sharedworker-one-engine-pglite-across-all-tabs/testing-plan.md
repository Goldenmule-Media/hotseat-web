# Testing plan

**Status:** ready

## Planned
- **Single-host invariant (the core goal).** Open three tabs of the same workspace. In DevTools confirm exactly ONE SharedWorker (chrome://inspect → Shared workers), ONE PGlite/IndexedDB (`idb://wiki-ui-search`) connection, and ONE live stream tail (one long-poll `fetch` to the workspace stream) — not three of each. Closing two tabs leaves the single host running for the third.
- **Cross-tab live update.** With two tabs open on the same workspace, issue a transition (or any commit) from tab A; tab B re-projects the tree and the open page's Markdown from the shared tail within ~1s, with no tab-B-initiated poll. A commit to a page open in BOTH tabs updates both.
- **Search-index integrity across tabs (the regression this feature fixes).** Open two tabs, let both fold/index, then run the same query in each — results and ranking match (no divergence). Reload all tabs: the persisted `idb://wiki-ui-search` index is intact and immediately searchable, with no corruption/migration error in the console. Contrast against `main` (per-tab PGlite) where concurrent writers can diverge.
- **Schema-error classification survives the boundary (the sharp edge).** Point wiki-ui at a server/workspace whose page type is NOT in the build's bundle (or otherwise force an `UNKNOWN_PAGE_TYPE`). The tab must classify it as `unknown-page-type` (NOT `connection`), render the “unknown type” notice, and populate `LoadError.unknownTypes`. Verifies the `WikiErrorDTO` + Comlink `transferHandler` preserve `code`/`types` that structured clone would otherwise drop.
- **Connection-error classification + recovery.** Stop the wiki-server while a workspace is open. The tab shows the `connection` state (“Disconnected”/reconnecting), NOT a schema error. Restart the server: the worker's single reachability probe re-seeds and re-establishes the tail, and all tabs catch up to head without a manual reload.
- **Late-joining tab gets current state cheaply.** With the worker already running and a workspace folded, open a fresh tab on that workspace. It receives the current tree immediately (handshake → `ensureWorkspace` → `tree`) and does NOT trigger a second full fold of the stream (verify only the existing single tail is active; no duplicate catch-up fetch storm).
- **`fsmOf` stays synchronous in render.** Switch a page to Model mode: the FSM graph and terminal-status checks paint on first render with no “loading FSM” flash and no per-render RPC — descriptors come from the handshake cache. `components/PageView.tsx` and `lib/terminal.ts` call a synchronous `fsmOf`.
- **Write path round-trips through the host.** From the transition inspector run a page command (`usePageMutator` → `host.mutate`). On success the committing tab AND every other open tab re-project status + available/blocked descriptors from the shared tail. On a rejected write (precondition/validation), the classified error message surfaces in the form and no view is corrupted. Archive/unarchive from the sidebar (`useStructuralMutator`) behaves the same.
- **Tab-close lifecycle, no fan-out leak.** Close one of several tabs: via the heartbeat, the worker reaps that port's subscriptions and stops fanning commits to it (verify the subscriber set shrinks / no “post to closed port” errors). Closing the LAST tab triggers `wiki.close()`/`teardown()`; a subsequently opened tab cold-starts the host (re-folds, re-opens PGlite) correctly.
- **Unsupported-browser path.** With `SharedWorker` (or module-worker support) absent — simulate by stubbing `globalThis.SharedWorker` to undefined — the feature-detect fails and the app renders the clear unsupported-browser message instead of crashing or showing a blank screen. No engine/PGlite is constructed.
- **SSR / pre-render safety.** `next build` and a server render complete with NO `SharedWorker`/`PGlite`/`window` reference errors; the engine never instantiates on the server; client components hydrate from the “connecting” handle state and then go live. The current null-on-SSR contract is preserved.
- **Existing unit suites unaffected.** `lib/schema-form.test.ts`, `lib/fsm-graph.test.ts`, and `lib/snippet.test.ts` pass unchanged — these are pure tab-side transforms over plain return data and must not regress from the relocation.
- **Phase-0 bundling gate.** `next dev` AND `next build` successfully bundle the `{type:"module"}` SharedWorker entry: PGlite's `.wasm`/`.data` assets are emitted and resolvable from the worker chunk, and `wiki`/`wiki-models` source is transpiled into it (no `ERR_MODULE_NOT_FOUND`, no missing-WASM at runtime). The worker boots and folds one workspace. This case is the empirical answer to the brief's two open questions.

## Passed
_None._

## Failed
_None._

## References
_None._

## Child pages
_None._
