# Model & language registries

**Status:** current

## Kind
subsystem

## Summary
Two sibling, generation-counted registries that load plugins by module specifier via cache-busted dynamic `import()`: the `ModelRegistry` (ADR-M6) holds the live page-type set wrapping the engine's immutable `Registry`, and the `LanguageRegistry` (ADR-M7) maps a `code` `lang` tag to an `ILanguageAnalyzer`.

## Purpose
Make page-type schema swappable at runtime (the local edit → build → reload loop) without changing `wiki` / `wiki-server`, and load heavy / version-sensitive parsers in the host (never in the engine) so analysis stays a read-side projection.

## Components
_No components._

## Dependencies
- **depends-on** → [Page-type authoring & registry](architecture:mpzoithh-004r-hd8cmg) — The ModelRegistry wraps the engine's immutable `Registry` (ADR-M6).

## Code references
- class `ModelRegistry` in `wiki-mcp/src/models/registry.ts`
- function `loadModelBundle` in `wiki-mcp/src/models/loader.ts`
- class `LanguageRegistry` in `wiki-mcp/src/models/language-registry.ts`

## Data model
`ModelRegistry` owns a `Map<bundleId, {id, specifier, pageTypes}>`, a memoized engine `Registry`, a generation counter, and a cache-bust counter (emits `ModelRegistryEvent`). `LanguageRegistry` owns `lang→analyzer` / `lang→specifier` maps; the analyzer contract types (`AnalyzerSymbol`, `AnalyzerReference`, `RenameResult`) feed the `symbol_index` / `reference_index` tables.

## Usage
`ModelRegistry` is built in `createWikiMcp`, seeded with host page types as the in-memory `default` bundle, then `load` / `reload` / `unregister` are driven from `wiki-server`'s `/_server/models` control listener; its `onChange` rebinds the engine + projection and reprojects. `LanguageRegistry` is built by `createLanguageRegistry` and queried by `get(lang)` in the projection and rename tool.

## Invariants & constraints
- Hot-reload works only via the cache-busting `import(fileURL + '?v=<token>')` query — a plain `import()` of the same path returns Node's cached module; bare package specifiers can't cache-bust.
- On any model change the generation + fingerprint bump and `onChange` is awaited; a reload is a hard replace that rebuilds the engine (dropping hot handles) and reprojects every workspace; it never throws, so one unfoldable workspace can't abort the rest.
- The LanguageRegistry is a read-side sibling only — analyzers are pure / deterministic, never fold, and `rename` returns edits with no write authority; a `lang` with no analyzer yields a location-only stub symbol row.

## Synced commit
e357aa7
