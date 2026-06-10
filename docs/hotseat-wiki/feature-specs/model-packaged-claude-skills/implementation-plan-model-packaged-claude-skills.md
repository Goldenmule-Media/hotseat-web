# Implementation plan — Model-packaged Claude skills

**Status:** draft

## Steps
- [x] Add type-only IBundleSkillDecl to wiki/src/api.ts (readonly name, description, plugin, marketplace, marketplaceSource; optional command) so it flows out through wiki/authoring's type re-export — no engine runtime behavior.
- [x] wiki-mcp loader: add extractSkills(mod, spec) beside extractPageTypes in wiki-mcp/src/models/loader.ts reading an OPTIONAL named `skills` export — validate string fields per entry, throw a descriptive contract error on malformed input (matching the pageTypes error style), default to []; extend LoadedBundle and loadModelBundle to carry skills.
- [x] wiki-mcp registry: add skills to the internal Bundle; add BundleSkillInfo (declaration + derived installCommands) and skills to public BundleInfo in wiki-mcp/src/models/registry.ts; derive installCommands in list() as ["/plugin marketplace add <marketplaceSource>", "/plugin install <plugin>@<marketplace>"]; thread loader skills through load(); register() gains an optional skills param defaulting to [] so the createWikiMcp "default" seed stays valid.
- [x] wiki-server control: widen ModelsControl.list() in wiki-server/src/control.ts to include skills and refresh the route doc table — handleModels serializes models.list() verbatim, so GET /_server/models picks the field up automatically.
- [x] Thread ModelRegistry to the MCP surface: optional models on McpServerDeps (wiki-mcp/src/mcp/server.ts) and WikiToolContext (wiki-mcp/src/mcp/tools.ts), include it in the per-call ctx, and pass models where createWikiMcp constructs WikiMcpServer (wiki-mcp/src/main.ts).
- [x] Add the listModelSkills read tool in wiki-mcp/src/mcp/tools.ts: optional { bundleId? } input, read-only, degrades to "model registry not available" without ctx.models; text output lists bundle → skill (command) with the exact installCommands; structured output is the BundleInfo-shaped skills payload; register it in the reads block of wikiTools().
- [x] Declare the feature bundle's skill: named `skills` export in wiki-models/src/feature/index.ts pointing at the existing hotseat plugin (name build-feature, plugin hotseat, marketplace hotseat, marketplaceSource Goldenmule-Media/hotseat-web, command /build-feature) — values from .claude-plugin/marketplace.json and plugins/hotseat; the default export is untouched so wiki-ui's static import is unaffected.
- [x] Tests per the testing plan: loader extraction + validation, registry derivation + hot-reload survival, listModelSkills behavior + degradation, control-surface pass-through, repo-consistency of declared plugin/marketplace names, and built-dist named-export survival.
- [x] Gates: npm run typecheck and npm run test from the repo root; verify the built path (npm run build -w wiki-models, then loadModelBundle over dist/feature.js).
- [x] Document: update the wiki-mcp architecture wiki page (bundle skills metadata + listModelSkills) and add a discovery note to plugins/hotseat/README.md; author all wiki content via MCP — docs/hotseat-wiki/** is the emitter mirror.

## Data models & interfaces
```typescript
// ── wiki/src/api.ts (type-only; reaches bundle authors via wiki/authoring)
/** A Claude skill a model bundle declares it ships with. Model-declared; hosts read it generically. */
export interface IBundleSkillDecl {
  /** Skill name inside its plugin, e.g. "build-feature". */
  readonly name: string;
  /** One-line description surfaced by discovery. */
  readonly description: string;
  /** The Claude plugin that ships the skill — a plugins[].name in the marketplace manifest. */
  readonly plugin: string;
  /** The marketplace id — the top-level name in .claude-plugin/marketplace.json. */
  readonly marketplace: string;
  /** Marketplace source for /plugin marketplace add — owner/repo or a checkout path. */
  readonly marketplaceSource: string;
  /** The slash command that invokes the skill, e.g. "/build-feature". */
  readonly command?: string;
}

// ── wiki-models/src/feature/index.ts — NEW named export beside the default page-type array
export const skills: readonly IBundleSkillDecl[] = [
  {
    name: "build-feature",
    description: "Agentic, FSM-gated feature builds driven by the hotseat structured wiki.",
    plugin: "hotseat",
    marketplace: "hotseat",
    marketplaceSource: "Goldenmule-Media/hotseat-web",
    command: "/build-feature",
  },
];

// ── wiki-mcp/src/models/loader.ts — LoadedBundle grows
export interface LoadedBundle {
  readonly pageTypes: PageTypeSet;
  /** Skills the bundle declares via a named `skills` export; [] when absent. */
  readonly skills: readonly IBundleSkillDecl[];
  readonly url: string;
}

// ── wiki-mcp/src/models/registry.ts — BundleInfo grows (additive; public via main.ts)
/** A declared skill plus the host-derived install commands. */
export interface BundleSkillInfo extends IBundleSkillDecl {
  /** Derived, in order: ["/plugin marketplace add <marketplaceSource>", "/plugin install <plugin>@<marketplace>"]. */
  readonly installCommands: readonly string[];
}
export interface BundleInfo {
  readonly id: string;
  readonly specifier: string;
  readonly types: string[];
  readonly skills: BundleSkillInfo[];
}
// ModelsControl.list() in wiki-server/src/control.ts widens in lockstep.
```

```json
{
  "comment": "Wire shape: GET /_server/models response AND the structured data of listModelSkills",
  "generation": 4,
  "bundles": [
    {
      "id": "feature",
      "specifier": "/abs/path/hotseat-web/wiki-models/src/feature/index.ts",
      "types": ["feature-brief", "implementation-plan", "testing-plan", "feature-spec"],
      "skills": [
        {
          "name": "build-feature",
          "description": "Agentic, FSM-gated feature builds driven by the hotseat structured wiki.",
          "plugin": "hotseat",
          "marketplace": "hotseat",
          "marketplaceSource": "Goldenmule-Media/hotseat-web",
          "command": "/build-feature",
          "installCommands": [
            "/plugin marketplace add Goldenmule-Media/hotseat-web",
            "/plugin install hotseat@hotseat"
          ]
        }
      ]
    },
    { "id": "toc", "specifier": "/abs/path/hotseat-web/wiki-models/src/toc/index.ts", "types": ["toc"], "skills": [] }
  ]
}
```

## Open questions
_None._

## Resolved questions
_None._

## References
_None._

## Child pages
_None._
