# Testing plan — Model-packaged Claude skills

**Status:** draft

## Planned
_None._

## Passed
- loadModelBundle: a fixture exporting default pageTypes plus a named skills export returns both; a bundle WITHOUT a skills export returns skills: [] (the existing real bundles keep loading unchanged) — wiki-mcp/test/models.test.ts
- Malformed skills export (non-array; entry missing name/plugin/marketplace/marketplaceSource; non-string fields) throws a descriptive contract error naming the specifier — wiki-mcp/test/models.test.ts
- ModelRegistry.list() derives installCommands exactly ["/plugin marketplace add Goldenmule-Media/hotseat-web", "/plugin install hotseat@hotseat"] for the feature declaration; register("default", pageTypes) — the createWikiMcp seed path — yields skills: [] — wiki-mcp/test/models.test.ts
- listModelSkills: with ctx.models wired it returns every loaded bundle's skills with installCommands; { bundleId } filters to one; an unknown bundleId yields an explicit not-found; without ctx.models it degrades to a "model registry not available" message; tools/list advertises it read-only — wiki-mcp/test/mcp-tools.test.ts
- GET /_server/models: every bundle carries a skills array ([] for skill-less bundles); after loading a skills-declaring fixture the response includes its skills + installCommands verbatim (pass-through of models.list()) — wiki-server/test/models-control.test.ts
- Repo-consistency: the feature bundle's declared plugin name exists in the root .claude-plugin/marketplace.json plugins[] and the declared marketplace matches its top-level name — keeps the triple-named hotseat from drifting silently
- Built path: after npm run build -w wiki-models, loading dist/feature.js through loadModelBundle still yields the skills declaration (the named export survives tsdown bundling)
- Reload threads skills: after load → reload(id) the listing still carries the declaration (the reload path re-extracts via the loader), and a replaced registration reflects new metadata; true on-disk re-evaluation is covered by the existing distinct-?v= assertion (vitest caches dynamic imports regardless of query — models.test.ts NOTE) — wiki-mcp/test/models.test.ts

## Failed
_None._

## References
_None._

## Child pages
_None._
