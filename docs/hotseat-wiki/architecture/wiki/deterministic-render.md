# Deterministic render

**Status:** current

## Kind
subsystem

## Summary
The configurable Markdown render read model. `renderPage` / `renderWorkspace` walk a page's section tree in render-config order, dispatch each field on its field-kind to a per-kind default renderer, and emit byte-stable Markdown via the pure canonicalization helpers in `determinism.ts` (and block rendering in `blocks.ts`).

## Purpose
Render is a read model, not a per-type function: a page's Markdown is a pure function of its folded state plus the model's static `RenderConfig`, so equal state renders byte-identically — making determinism a property of one engine-owned walk.

## Design notes
Render carries no per-type render function: a page type contributes only a static RenderConfig (an ordered list of SectionRender entries) and the engine owns a single walk that turns folded state plus that config into Markdown. renderPage looks the page node up in IWorkspaceState, fetches def.render from the registry, and emits an H1 display title followed by a status badge, then iterates config.sections in declared order. For each entry it locates the matching folded section by key, picks the named field (or the first field key when none is named), and dispatches on the field's kind to a per-kind body renderer. Because the only inputs are the folded state and a logic-free config, render is a pure read model: there is no place for a type author to inject imperative formatting, so determinism is a property of the one engine-owned function rather than something each page type must re-earn.

Ordering is always explicit or insertion-based, never object-key order. Sections render in the order config.sections lists them; list elements, blocks, and inlines render in their stored array order; references and child lists render in the order the workspace state holds. Where a sort is genuinely needed the stableBy helper is the only sanctioned path: it decorates each item with its original index, compares keys by fixed code-unit ordering with no locale, and breaks ties on the original index, so the sort is total and reproducible on every machine. The one spot that reads from a record by key is title-template and element-label resolution, and there the field is always named explicitly in the template or the ref target, so even that is a pure projection that never depends on the enumeration order of an object's keys.

Byte-stability rests on a strict formatting contract enforced at the joining seam rather than per-renderer. Each section is emitted as a single block: the section helper puts the H2 heading and its body on adjacent lines with no blank line between them, so the canonical blank line only ever lands between sections, never between a heading and its content. joinBlocks then right-trims every block, drops the ones that are empty or whitespace-only, separates the survivors with exactly one blank line, and terminates the whole document with exactly one trailing newline; an all-empty input yields the empty string with no spurious newline. The result is that two equal folded states always produce the same bytes, so a diff of two renders is a diff of two states and nothing else. Empty or optional sections collapse to a default placeholder line so an absent value produces a stable, local diff instead of a structural shift.

Render is identity, not reformatting: it projects already-normalized content out, it does not parse or pretty-print it. The block and inline walk assumes its input is in normal form (validated at ingestion) and simply emits it: paragraphs join their inlines, code blocks fence the source verbatim with their language tag, tables escape only the pipe character in cells, and quotes prefix each line. Inline marks are applied from the inside out in a canonical order (emphasis, then strong, then link) because the marks themselves were canonically sorted when stored, so the same set of marks always nests the same way. A ref never stores display text; it stores a target and renders the target's render-derived label through a label resolver, so renaming a page or reordering a list updates every reference automatically and identically. No wall clock, randomness, or external lookup is reachable from any of this: any value that would need to be computed is materialized into a field by a command beforehand, leaving render with nothing to decide.

```ts
// The determinism helper set: every output-shaping decision routes through these
// pure, total transforms, so byte-stability lives in one place.

// Join blocks into a document: drop empties, one blank line between, one trailing newline.
export function joinBlocks(blocks: string[]): string {
  const kept = blocks.map((b) => b.replace(/\s+$/, "")).filter((b) => b.length > 0);
  return kept.length === 0 ? "" : kept.join("\n\n") + "\n";
}

// Fixed ATX heading; level clamped 1..6; surrounding whitespace collapsed.
export function heading(level: number, text: string): string {
  const clamped = Math.min(6, Math.max(1, Math.trunc(level)));
  return "#".repeat(clamped) + " " + text.trim();
}

// Heading + body as ONE block (no blank line between them), so joinBlocks only
// ever inserts the blank line BETWEEN sections.
export function section(headingLine: string, body: string): string {
  return `${headingLine}\n${body.length > 0 ? body : placeholder()}`;
}

// Canonical status line, e.g. statusBadge("building") -> "**Status:** building".
export function statusBadge(status: string): string {
  return `**Status:** ${status}`;
}

// The ONLY sanctioned sort: stable, locale-free code-unit order, ties broken on
// original (insertion) index. Never sorts by object-key enumeration order.
export function stableBy<T>(arr: readonly T[], keyFn: (item: T) => string): T[] {
  return arr
    .map((item, index) => ({ item, index, key: keyFn(item) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.index - b.index))
    .map((e) => e.item);
}
```

## Components
_No components._

## Dependencies
- **depends-on** → [Page-type authoring & registry](architecture:mpzoithh-004r-hd8cmg) — Reads `def.render` / `computed` / `derived` and resolves labels.
- **depends-on** → [Section-operation reducer & fold](architecture:mpzoiq0g-004l-dunnzt) — Renders the folded `IWorkspaceState`.

## Code references
- function `renderPage` in `wiki/src/render/read-model.ts`
- function `joinBlocks` in `wiki/src/render/determinism.ts`
- function `renderBlocks` in `wiki/src/render/blocks.ts`

## Data model
Reads `IWorkspaceState` (titles / links / children denormalized) and the page's `ISection` / `IField` / `IItem` / `IBlock` tree; `RenderConfig` / `SectionRender` declare section order, headings, per-kind display, list grouping, and checklist / derived rows.

## Usage
`WorkspaceHandle.toMarkdown` / `IPageView.toMarkdown` call `renderPage` / `renderWorkspace(state, pageId, registry)` after honoring read consistency; it reads `def.render` (and `def.computed` / `def.derived`) from the Registry.

## Invariants & constraints
- No wall-clock/randomness at render; any computed value is materialized into a field by a command, never computed in `render` (the render config is logic-free).
- Stable ordering (sections by config/`order`, blocks/inlines by array order) and canonical formatting (fixed heading levels, `\n` endings, single trailing newline, no trailing whitespace).
- Render is identity, never a formatter: `code` fences verbatim, `blocks` render from already-normalized form; a `ref` renders its target's render-derived label so reorders / renames update automatically.

## Synced commit
e357aa7
