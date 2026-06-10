# Spec

**Status:** sealed

## Overview
Move the wiki-ui engine and its PGlite search index out of each tab and into a single SharedWorker, so every tab shares one engine, one PGlite writer, and one Durable-Stream tail — removing the multi-tab IndexedDB write hazard by construction. Tabs become thin Comlink RPC clients over the worker's MessagePort; all pure rendering work (markdown, FSM layout, schema forms) stays tab-side over plain, structured-clone-safe return data.

## Design
_No design yet._

## Decisions
Use a SharedWorker — not a Web-Locks leader-tab or PGliteWorker-only. The OS hosts one engine that outlives any individual tab, with no leader election and no re-fold on handoff. SharedWorker, a Web-Locks leader-tab, or just share the DB via PGlite's `PGliteWorker`?

SharedWorker-only, no fallback. Accept the support gap (Chromium-on-Android, Safari < 16); feature-detect and show an unsupported-browser message rather than maintain a Web-Locks or per-tab-worker fallback. What about browsers without SharedWorker (Chromium-on-Android, Safari < 16)?

The engine's live tail runs unchanged inside a SharedWorker: the Durable-Streams client tails over fetch + response.body.getReader(), not the EventSource API (which is absent in SharedWorkerGlobalScope). Does the engine's live tail actually work inside a SharedWorker (no `EventSource` in worker scope)?

Marshal engine errors as a plain DTO { code, message, types?, issues? } via a Comlink transferHandler registered on both sides — structured clone of an Error drops subclass identity and own-props, which classify() depends on to tell connection from schema errors. How do the engine's typed errors survive the tab↔worker boundary?

PGlite relocates into the worker with the engine via the search:{ db } seam. The UI never queries the DB directly, and a live Kysely handle is non-serializable, so the DB must live in the engine's realm — the worker. Does moving the engine into the worker move PGlite cleanly, or does the UI also need direct DB access?

Next/webpack 5 emits PGlite's WASM/.data assets for the module SharedWorker entry with no explicit wasmModule/fsBundle injection — confirmed by the Phase-0 bundling gate. Does Next (webpack 5) emit PGlite's WASM/`.data` assets for a module SharedWorker entry, or must we pass `wasmModule`/`fsBundle` explicitly? (Highest bundling risk — derisk with a Phase-0 prototype before committing.)

transpilePackages: ['wiki','wiki-models'] reaches the separate worker compilation; the worker entry needs no separate transpile/Babel config. Does `transpilePackages: ["wiki","wiki-models"]` reach the separate worker compilation, or does the worker entry need its own transpile/Babel config?

## References
_None._

## Child pages
_None._
