# ADR-8: Render as a configurable read model

**Status:** accepted

## Metadata
- **Date:** 2026-06-03
- **Scope:** wiki

## Context
*(also covers the move to declarative `definePageType` authoring — sections/field-kinds/elements +
contracts + render config — and declarative commands with `produces` as the escape hatch.)*

Render was a per-type `render(page, ctx) => markdown` function (§11 pre-redesign) — the
last big piece of imperative model code, and the one that *defined* each document's shape (the
default renderer even inferred display via `textOf = rec.text ?? rec.name ?? rec.id`). It conflicted
with "structure is first-class and introspectable": you couldn't derive a page's layout without
running its code.

## Decision
Render is a read model (structured-content §8): the
engine ships a configurable Markdown render read model — a sibling of the SQL read model and the
AST/symbol projections — that walks the section tree and dispatches on field-kind, driven by a
page type's static, declarative, logic-free render config (section order, headings/labels,
per-kind display, groupings, element templates). The per-type render function is retired.
Authoring as a whole becomes declarative: definePageType declares sections + field-kinds +
element types (+ their FSMs) + structural contracts + render config, and commands are declarative
by default (target + args→field set + transition + preconditions), with produces as the
escape hatch returning section operations. Determinism is preserved as a property of the read
model: pure over folded state + static config (no wall-clock/RNG; ids from injected newId; explicit
ordering; any computed value is materialized into a field by a command, never computed at render
time).

## Consequences
§10.5 (IPageTypeDef loses apply/render, gains sections/elements/
render: IRenderConfig), §11 (render-as-read-model), and §16 (render/read-model.ts; a wiki/render
subpath) change. The render-config vocabulary must cover today's bespoke layouts (e.g. the
open/resolved question split) without becoming "config that is secretly code" — an open item to
specify (structured-content §8). Golden render tests are rewritten against the config.

## Relations
_None._
