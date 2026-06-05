# Deterministic render

**Status:** current

## Kind
subsystem

## Summary
The configurable Markdown render read model. `renderPage` / `renderWorkspace` walk a page's section tree in render-config order, dispatch each field on its field-kind to a per-kind default renderer, and emit byte-stable Markdown via the pure canonicalization helpers in `determinism.ts` (and block rendering in `blocks.ts`).

## Purpose
Render is a read model, not a per-type function: a page's Markdown is a pure function of its folded state plus the model's static `RenderConfig`, so equal state renders byte-identically — making determinism a property of one engine-owned walk.

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
