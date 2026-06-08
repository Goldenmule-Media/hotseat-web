# ADR-11: Greenfield: no backward compatibility

**Status:** accepted

## Metadata
- **Date:** 2026-06-03
- **Scope:** wiki

## Context
The current wave of decisions changes the engine's content model, event model, authoring API, and render
pipeline at once. Carrying a fields/items to sections migration, dual-format upcasters, and
per-type-event compatibility shims would dominate the work and ossify the old model in the engine.

## Decision
Adopt the new model greenfield — no backward compatibility. There is no
fields/items data migration and no per-type-event compatibility path; the feature bundle is
authored directly on sections with declarative commands + render config, and
golden render tests are rewritten. Schema evolution within the new model still uses the existing
schemaVersion + upcasters seam (now reshaping section-operation payloads / section/field schemas) —
that mechanism is retained; only cross-model back-compat is dropped.

## Consequences
Existing streams written under the old model are not readable by the new engine
(acceptable: pre-release). The delivery sequence is Phase 1 substrate
(sections, field-kinds incl. blocks, contracts, render read model; feature rewritten), then Phase 2
read-only host projections (outline, symbol index behind the LanguageRegistry), then Phase 3 semantic
operations (renameSymbol, guarantee-scoped).

## Relations
_None._
