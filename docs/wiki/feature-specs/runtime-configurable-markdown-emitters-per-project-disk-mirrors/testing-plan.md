# Testing plan

**Status:** ready

## Planned
- EmitterConfigStore.fold — last-writer-wins per emitterId: folding [EmitterConfigured{e1,wsA,/rootA}, EmitterConfigured{e1,wsA,/rootB}] yields a single live emitter e1 with root=/rootB (the later event wins; not two entries).
- EmitterConfigStore.fold — EmitterRemoved deletes: folding [EmitterConfigured{e1,...}, EmitterConfigured{e2,...}, EmitterRemoved{e1}] yields a live set containing only e2.
- EmitterConfigStore append/readAll round-trip — appendConfigured then appendRemoved on an in-memory DurableStream test host, then readAll() returns both events in append order, flattened from array-messages, against the ${namespace}/_emitter-config stream URL (separate from any workspace stream).
- ProjectionService.removeRenderSink — after addRenderSink(s) then removeRenderSink(s), a subsequent commit fans out to the remaining sinks but NOT to s (removal is by identity; removing a sink that was never added is a no-op).
- ProjectionService.reconcileSink — reconcileSink(s, source) brings only sink s to each workspace's stream head and leaves the other registered sinks untouched; reconcileSinks(source) still reconciles every sink (now expressed as a loop over reconcileSink).
- toMarkdownConfig — pure mapping: toMarkdownConfig({emitterId,workspaceId:wsA,root:/r,archive:'mirror'}) deep-equals {enabled:true, root:'/r', workspaces:['wsA'], layout:'tree', archive:'mirror'}; archive defaults are carried through verbatim.
- EmitterRegistry.start() boot-replay — with the config stream pre-seeded with one EmitterConfigured for workspace wsA, start() folds it, builds+init()s a MarkdownDiskProjector, addRenderSink + reconcileSink so the root back-fills from wsA's stream head immediately (files present on disk before any new commit).
- EmitterRegistry live add — after start(), append EmitterConfigured{e2,wsB,/rootB}; the live tail adds + back-fills a sink for e2 (no restart), and a subsequent commit to wsB is mirrored under /rootB.
- EmitterRegistry live replace — re-configuring an existing emitterId with a new root (EmitterConfigured{e1,wsA,/rootB} after {e1,wsA,/rootA}) removes the old sink and adds+back-fills a new one pointed at /rootB; only one sink for e1 remains registered.
- EmitterRegistry live remove — EmitterRemoved{e1} detaches e1's sink (removeRenderSink) and drops the map entry; a subsequent commit to that workspace is NOT mirrored, and files already written under the root are left on disk untouched (per brief constraint 5).
- configureEmitter MCP tool — rejects an unknown workspaceId: configureEmitter({emitterId,workspaceId:'ws:does-not-exist',root}) returns a tool error and appends NOTHING to the _emitter-config stream.
- configureEmitter → listEmitters round-trip — configureEmitter for a real workspace appends EmitterConfigured and, with no restart, listEmitters() returns the live set including that emitter (emitterId, workspaceId, root, archive).
- removeEmitter → listEmitters — after removeEmitter({emitterId}), listEmitters() no longer includes that emitter; calling removeEmitter for an unknown emitterId is a tolerated no-op (appends EmitterRemoved or returns cleanly without crashing the registry tail).
- Old static surface removed — WikiMcpConfig has no `markdown` field and config resolution recognizes none of --md/--md-root/--md-workspaces/--md-archive or WIKI_MCP_MD* (passing them does not enable any boot-time mirror); wiki-server boot with those flags/env starts cleanly with zero emitters until one is configured at runtime.

## Passed
_None._

## Failed
_None._

## References
_None._

## Child pages
_None._
