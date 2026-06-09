# Page-type authoring & registry

**Status:** current

## Kind
subsystem

## Summary
The declarative authoring API (`definePageType`, `t`, `arg`) and the `Registry` that consumes it. A page type declares sections + field-kinds, element types + FSMs, commands (declarative `set` / `transition` + a `produces` escape hatch), structural contracts, and render config — and declares NO reducer or renderer.

## Purpose
The schema seam: page types are data, validated mechanically at load, so the engine stays schema-agnostic. The Registry memoizes FSM guards, derives the generated structural-command set, and produces a snapshot-invalidating `fingerprint()`.

## Design notes
A page type is pure declaration, not code: definePageType takes a spec object and returns an opaque registration wrapper, performing only light shape checks (type, sections, commands and render must be present). What the author declares is the whole contract: a tree of named sections, each holding fields of a fixed kind vocabulary (scalar, prose, code, attachment-ref, ref, blocks, list, serial); element (list-item) types under elements, each optionally carrying its own status FSM; the page lifecycle FSM as a transition table over statusTransitions; named commands; structural contracts (required sections, a sectionSet cardinality and mode contract, requiredChildren); and a render config. Crucially the author declares NO reducer and NO renderer: both are engine-owned and schema-agnostic. The engine folds a closed op vocabulary into state and renders deterministically from the declared render config, so equal state always produces byte-identical Markdown regardless of which page type produced it.

Commands are declared, not implemented. A declarative command names a Zod arg schema (validated at command time), an optional target (which section, element, or field it addresses), and one of two effect forms. The common form is fully declarative: set maps command args to field values via the arg sugar (so an addConstraint command simply writes its text arg into a field) and transition fires a named FSM edge at page or element level; the engine turns these into ops itself. The escape hatch is produces, a pure decider that returns the same closed list of section ops the declarative forms compile to; it may read folded page state and an injected context but no clock or randomness, keeping every effect a deterministic function of state and args. Commands also carry pure preconditions (returning true or an unmet reason) and lifecycle wiring such as finalize and cascadeFinalize, which drives pinned children to their own terminal transition inside the same atomic commit so an unready child rejects the whole sign-off.

Authors never write a setter by hand for ordinary structure; the Registry derives the structural command surface from the section and field declarations. Each non-list field gets a setField command; a code field additionally gets a guarded applyTextEdits command (precomputed edits under a content-hash precondition) and a blocks field gets the block-addressed variant of it; a list field gets add, remove, and move element commands plus a setElementField command per element field. The serial kind is deliberately exempt: it is engine-minted once at createPage (next value scoped to same-type pages in the workspace) and gets no generated setter, so it has no write path and stays immutable for the page's life. These generated commands are memoized per page type at construction and exposed via generatedCommands so the command bus, read model, and page view all read one shared derivation.

```ts
// The Registry validates each declaration at construction and turns whole
// classes of silent, load-after deadlocks into load-time ValidationErrors.
class Registry {
  constructor(pageTypes: readonly IPageType[]) {
    for (const pt of pageTypes) {
      const def = pt.__def;
      this.validateDef(def);          // field-kinds known; list elements declared;
                                      // mutableIn statuses exist; sectionSet keys resolve
      this.pages.set(def.type, def);
      this.elements.set(def.type, /* tag -> ElementDecl */ elMap);
      this.generated.set(def.type, this.deriveGenerated(def)); // structural commands
    }
  }

  // Guards are built lazily and memoized - one makeGuard per page / element FSM.
  pageGuard(type: string): Guard<string, string> { /* cached makeGuard(statusTransitions) */ }
  elementGuard(pageType: string, elementType: string): Guard<string, string> | undefined { /* per (page:element) */ }

  // A stable identity over the loaded schema: type@version pairs, sorted + joined.
  // A version bump on any type changes the fingerprint, which invalidates older
  // snapshots and drives read-model rebuilds.
  fingerprint(): string {
    return [...this.pages.values()]
      .map((def) => `${def.type}@${def.version}`)
      .sort()
      .join(",");
  }
}
```

The fingerprint is the linchpin of caching. A workspace snapshot is a derived cache, never the source of truth: it records the workspace version it covers, a stream resume cursor, the serialized state, and the registry fingerprint that produced it. Serialize flattens the live Map-backed state to plain arrays and deserialize rebuilds the Maps preserving insertion order, so a round-trip is identity. On reopen the engine loads the latest snapshot only if its stored fingerprint matches the current registry's; on any mismatch (any loaded type's version changed) the snapshot is treated as absent and the workspace folds from event zero, guaranteeing state is always consistent with the schema that is actually loaded rather than a stale one. The same fingerprint signal is what tells external read models to rebuild after a schema change.

There is exactly one sanctioned place an author may participate in the fold, and it is deliberately bounded. A section or element decl may declare reduceMeta, a pure single-writer hook the engine invokes as it applies each op, handing it the current meta and the op and taking back the new meta. It is strictly meta-scoped: it can only shape the per-section or per-element meta bag, never canonical content (fields, items, status), and it never sees the setMeta op so it cannot fight a direct meta write. This lets a model maintain derived bookkeeping alongside an op (a running tally, a last-touched marker computed from injected context) without ever opening a general author-supplied reducer over content: the content reduction stays entirely engine-owned, total, and pure, which is what keeps render deterministic and the engine genuinely schema-agnostic.

## Components
_No components._

## Dependencies
- **depends-on** → [FSM guard](architecture:mpzoir7n-004n-5uignj) — Memoizes one `makeGuard` per page / element type.

## Code references
- class `Registry` in `wiki/src/core/registry.ts`
- function `definePageType` in `wiki/src/core/define.ts`
- interface `IPageTypeDef` in `wiki/src/api.ts`

## Data model
Owns maps of `IPageTypeDef` by type, element decls, memoized `Guard`s, and `GeneratedCommand` sets; declarations are `SectionDecl` / `FieldDecl` / `ElementDecl` / `DeclarativeCommand` / `RenderConfig`.

## Usage
`createWiki` builds one `Registry` from `config.pageTypes`; the bus, reducer, render read model, and `IPageView` all query it (`page`, `pageGuard`, `elementGuard`, `generatedCommands`, `requiredSectionsOf`, `fieldDeclOf`). Exported via the `wiki/registry` subpath for external read models.

## Invariants & constraints
- Declarations are validated at construction (`validateDef`): field-kinds known, `list` elements declared, `mutableIn` statuses exist, `sectionSet.cardinality` keys resolve — else `ValidationError`.
- Static reachability lints catch silent deadlocks: a `mutableIn` status unreachable from `initialStatus`, a `required` section frozen in every status (`mutableIn: []`), or an unreachable element-FSM state are rejected.
- `fingerprint()` is `type@version` sorted/joined — a schema bump invalidates older snapshots; an unregistered type throws `UnknownPageTypeError`.

## Synced commit
e357aa7
