# ADR: Live ModelRegistry with cache-busted hot-reload

**Status:** accepted

## Metadata
- **Date:** 2026-06-02
- **Scope:** wiki-mcp
- **Legacy ID:** wiki-mcp/ADR-M6

## Context
Page-type schema must be **swappable at runtime** so a model can be edited, rebuilt, and
reloaded into a running server (the local *edit → build → reload* loop, driven from a build pipeline — never
by an agent). Today `createWikiMcp` takes a fixed `pageTypes` set and builds an **immutable** `Registry`
once; the projection captures `registry`/`fingerprint` at construction and `EmbeddedEngine` binds the set
per hot handle. Page types are authored in **`wiki-models`** and loaded **by reference**, and the engine is
already version-aware (upcast-to-latest, [wiki-models ADR-W1](../wiki-models/DESIGN.md)).

## Decision
Replace the construct-once Registry with a mutable, generation-counted ModelRegistry
that wraps the engine's immutable Registry. Bundles are loaded by dynamic import() of a module
specifier. Operations: register(id, pageTypes) (seed the host's page types as an in-memory default
bundle — no specifier, so it can't be reloaded), load(id, specifier), reload(id) (a hard replace),
and unregister(id). On any change the generation + fingerprint bump, and:

- reload re-imports the rebuilt bundle under a cache-busting URL — import(fileURL + '?v=' + buildHash).
  Plain import() of the same path returns Node's cached module, so the query string is the whole trick
  that makes a code change actually take effect;
- the engine Registry is rebuilt from the new def set, EmbeddedEngine.rebind rebuilds the engine from
  the new page-type set — dropping every hot handle and closing the old engine — so new writes bind the
  new code, and the projection reprojects the read model: ProjectionService.reproject resets every
  projected workspace's offset (deletes its projectionoffsets row) and clears any halt, then re-folds
  all from the stream with the new registry (§5.3, ADR-M3).
  It never throws, so a workspace the new set still can't fold simply re-halts without aborting the rest.

Control is the wiki-server control listener — GET/POST/DELETE /server/models[/<id>]
(wiki-server/DESIGN.md §8.5) — pipeline-driven, not an MCP tool. wiki-server
proxies the call into wiki-mcp's ModelRegistry and stays schema-agnostic (the request names a specifier;
wiki-mcp does the import).

Why. The live part belongs at the layer that owns the engine + projection (wiki-mcp), so wiki and
wiki-server need no change and stay schema-agnostic. Reusing the fingerprint-rebuild path means reload
correctness rides ADR-M3's fold (upcasting, unknown-type halt) for free. Cache-busting is the minimal
mechanism that defeats the ESM module cache without a worker/vm.

## Consequences
Cache-busting leaks the old module instances until GC — acceptable for a local/dev
reload loop; a long-running production hot-swap is a non-goal. A reload that drops a live type or lowers a
version halts affected workspaces loudly (wiki-models §4). The bundle must
exist as built ESM on disk at runtime — it cannot be pre-bundled into the tsdown server image, so models
ship alongside the server, not inside it. Loading a bundle is arbitrary code execution (first-party
trusted). Per-namespace model selection + persistence stay reserved (wiki/DESIGN.md §8).
Implementation note: the reset-all reproject IS wired — on a registry change the projection deletes every
workspace's projectionoffsets row, clears halts, and re-folds all from the stream with the new registry
(ProjectionService.reproject). What remains a future optimization is the finer per-workspace
compare-stored-vs-current fingerprint diff that would re-fold only the workspaces whose projectionoffsets.fingerprint
(§5.3) actually changed; that column is still stamped on every apply.

## Relations
_None._
