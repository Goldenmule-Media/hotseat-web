# ADR-24: Declarative page types: the engine owns the reducer, render, and events; models declare structure + render config + contracts

**Status:** accepted

## Metadata
- **Date:** 2026-06-03
- **Scope:** wiki-models

## Context
A page type previously carried a hand-written `apply` reducer, a `render` function, and a set
of bespoke per-type event types (`SummarySet`, `QuestionAnswered`, …): the model was a *program* the
engine routed events into ([wiki/DESIGN.md §7.3](../wiki/DESIGN.md), and the pre-revision `feature` bundle:
`feature-brief.ts` `applyBrief`/`renderBrief`, the `items.ts` FSMs). That coupled every page type to the
fold mechanism and the renderer, made content shapes ad-hoc per type, and put author-written logic on the
write path. The structured-content redesign ([docs/structured-content.md](../docs/structured-content.md))
makes a page's content a tree of typed **Sections** mutated through a **closed, engine-owned
section-operation vocabulary**, folded by **one built-in reducer**, and rendered by a **configurable
Markdown render read model** — none of which a model should re-implement.

## Decision
A wiki-models page type is declarative. definePageType declares: a tree of typed
sections (keys, names, field-kinds, required, mutableIn write-gate); element (list-item) types
with their status FSMs; the section-set contract (open/closed, prohibited, cardinality) plus
requiredSections and per-field required/schema; transition preconditions (the declarative form of
the beginImplementation/ship gates); declarative commands (target + args→field mapping + FSM event
+ preconditions); and a static, logic-free render config. A model writes no apply reducer, no
render function, and no per-type event types — the engine supplies the one built-in reducer, the
closed section-operation vocabulary, command attribution via event metadata, and the render read model.
produces remains an escape hatch that returns section operations (never bespoke events) for computed
effects; the only model fold-extension is a bounded, pure, meta-scoped reduceMeta(meta, op) => meta
that may write only a section's typed meta bag (docs/structured-content.md §9.4–§9.5).
The feature bundle is re-authored greenfield on this model — sections with field-kinds, items as list
elements with FSMs, the cross-page gates as declarative preconditions, the bespoke renderers as render
config — with no fields/items migration (docs/structured-content.md §12).

Why. It completes the schema-agnostic boundary: the engine owns the grammar of structure and how it
renders and zero meaning (docs/structured-content.md §1). Removing
author-written reducers/renderers/events makes every page's content uniform and introspectable —
deterministic tooling (outline, indexing, render, the SQL read model) operates on one structure instead of
N bespoke shapes; history stays semantic via command attribution; and determinism is enforced engine-side
(the model has no write-path code in which to call a clock or RNG). It also shrinks what hot-reload must
trust: a declaration is mechanically validated at load (keys resolve, field-kinds known, predicates
callable) rather than executed as a reducer.

## Consequences
wiki-models ships declaration, not logic: the vN/ layout now versions
content-schema shapes (section/field/element/meta), not per-type event payloads (§5), and a pure
render-config change needs no version bump. Golden render tests are rewritten against the render read model
(§8.3). The render-config vocabulary must cover today's bespoke layouts — e.g. the feature-brief
open/resolved split — without becoming "config that is secretly code"; that vocabulary, the arg()
args-mapping DSL, and the generated-command naming scheme are open and tracked upstream
(docs/structured-content.md §8, §9.7, §9.8). The engine-side metaschema
(definePageType declarative fields, the section reducer, the render read model, the well-formedness
check) is owned by wiki; this ADR records only the authoring contract wiki-models writes to.

## Relations
_None._
