# Feature: Model-packaged Claude skills

**Status:** shipped

## Summary
Let model bundles in wiki-models declare the Claude skills they ship with, and let wiki-mcp surface that declaration plus the exact install commands a caller runs. Today a bundle's index.ts exports only a page-type array (the loader contract), BundleInfo is {id, specifier, types}, GET /_server/models mirrors that, and the one existing skill — build-feature in plugins/hotseat, installable via `/plugin marketplace add Goldenmule-Media/hotseat-web` then `/plugin install hotseat@hotseat` — is only implicitly paired with the feature bundle. This feature adds an OPTIONAL named `skills` export to the bundle contract (model-declared, host-read-generically), extends the wiki-mcp loader and ModelRegistry to carry it, derives installCommands by pure templating from the declaration, widens GET /_server/models in lockstep, and adds one read-only MCP tool `listModelSkills`. The feature bundle declares a pointer at the existing hotseat plugin; no skill files move in v1.

## Components affected
- wiki — type vocabulary only: IBundleSkillDecl in wiki/src/api.ts, surfaced type-only via wiki/authoring (no engine runtime behavior)
- wiki-models — named `skills` export in wiki-models/src/feature/index.ts (model-declared metadata; toc/architecture/adr declare none)
- wiki-mcp loader — extractSkills beside extractPageTypes in wiki-mcp/src/models/loader.ts; LoadedBundle.skills
- wiki-mcp registry — Bundle.skills + BundleInfo.skills with derived installCommands (BundleSkillInfo) in wiki-mcp/src/models/registry.ts
- wiki-mcp MCP surface — ModelRegistry threaded through McpServerDeps/WikiToolContext; new listModelSkills read tool in wiki-mcp/src/mcp/tools.ts; wired in createWikiMcp
- wiki-server control — ModelsControl.list() widened in wiki-server/src/control.ts; GET /_server/models carries skills by pass-through
- Docs — wiki-mcp architecture wiki page + plugins/hotseat README discovery note

## Design constraints
1. Schema-agnostic boundary: skill metadata is declared in wiki-models and read generically by wiki-mcp; nothing bundle- or skill-specific is hardcoded in wiki-mcp/wiki-server.
2. Decision: the shared IBundleSkillDecl type lives type-only in wiki/src/api.ts, reaching bundle authors via wiki/authoring's type re-export — the only shared home legal under "wiki-models depends only on wiki/authoring"; the engine never acts on it at runtime.
3. Loader contract stays backward compatible: bundles without a `skills` export load with skills = []; the default/pageTypes export contract is untouched; discovered-bundle boot keeps skip-with-warning and explicit --models keeps hard-fail.
4. BundleInfo is a public export of wiki-mcp — the change must be purely additive, and ModelRegistry must remain structurally assignable to wiki-server's ModelsControl (widened in lockstep).
5. Skills never touch the engine Registry, fingerprint, or fold behavior — they are host metadata, not page types; installCommands derivation is pure string templating from the declaration (no clock/env/process introspection).
6. models is OPTIONAL on McpServerDeps and WikiToolContext (searchIndex/emitters precedent) so existing partial-ctx tests keep compiling; listModelSkills degrades gracefully when absent.
7. Decision: listModelSkills emits the declared marketplaceSource verbatim — the server cannot know a client's checkout path; no local-path variant in v1.
8. Decision: tool-only v1 — no MCP resource mirror; a models resource is a cheap follow-up if resources/list discovery proves useful.
9. Import styles per package (.js relative imports in wiki-mcp/wiki-server, extensionless in wiki/wiki-models); tsdown alwaysBundle stays the /^wiki(\/|$)/ regex and the new named export must survive the dist build.

## Open questions
_None._

## Resolved questions
1. **Should skill FILES eventually move into bundle directories (e.g. wiki-models/src/feature/skills/ plus per-bundle plugin manifests and marketplace entries), or stay in plugins/hotseat with bundles declaring pointers? v1 implements the pointer approach — moving would break the documented /plugin install hotseat@hotseat flow, orphan the .claude/skills/build-feature sync copy, and decouple the plugin's .mcp.json wiring from the skill. Product-direction call, does not block v1.** — _Decision (human, at ship): keep the pointer approach. Skill files stay in plugins/hotseat (the repo root is its own marketplace) and bundles declare pointers via the `skills` export; the hotseat plugin shipped v0.2.0 on this model. Moving skill files into bundle directories is deferred — revisit only if more bundles ship skills and the per-bundle plugin/marketplace overhead earns its keep._

## References
_None._

## Child pages
- [Implementation plan — Model-packaged Claude skills](implementation-plan:mq858obw-007s-1jyv5l)
- [Testing plan — Model-packaged Claude skills](testing-plan:mq858obw-007t-um5okl)
- [Spec — Model-packaged Claude skills](feature-spec:mq858obw-007u-czpbbd)

## Commits
- `c4cd014e314794d2363c74ac717473a513518ff7` feat(model-skills): bundles declare packaged Claude skills; hosts surface install commands
- `a3cf0108a753eaf773943916d130b307103e480f` fix(model-skills): reject an empty skill command in the loader contract
