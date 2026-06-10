# Spec — General-purpose block-list page type

**Status:** sealed

## Overview
A general-purpose `document` page type: one ordered list of blocks (paragraphs, headings, code, page refs, external links) with a single always-editable `active` status and no workflow gates. A pure schema-layer addition — the engine's closed block vocabulary, block section-ops, and generic blocks renderer do the heavy lifting; the type curates the authoring surface.

## Design
The entire page is one required Body section holding a single blocks field. The FSM is a single active state with zero transitions (the toc precedent): a document is always editable, structural archive handles removal, and with no agency edges or awaitsHuman elements the type never surfaces in nextActions or attention.

Eight curated commands target the one content address: addParagraph, addHeading, addCode, addPageRef, addExternalLink, setParagraph (paragraph-only, kind-guarded — the engine setBlock op is kind-blind), moveBlock, removeBlock. Add commands take an optional index. Code blocks commit with an empty hash that ingestion canonicalizes; subsequent edits go through the generated applyBodyBodyBlockEdits command under expectedHash. Curated schemas bar empty text runs and fence-corrupting language tags.

```typescript
// wiki-models/src/document/document.ts — the shape (authored against wiki/authoring only)
export const Document = definePageType({
  type: "document",           // permanent: page ids become document:<id>
  label: "Document",
  version: 1,
  initialStatus: "active",    // single state — toc precedent
  statusTransitions: [],      // no workflow gates; archivePage handles removal
  sections: {
    body: { name: "Body", required: true, mutableIn: ["active"], fields: { body: { kind: "blocks" } } },
  },
  sectionSet: { mode: "closed" },
  commands: { addParagraph, addHeading, addCode, addPageRef, addExternalLink, setParagraph, moveBlock, removeBlock },
  render: {
    title: "{title}",
    sections: [{ section: "body", field: "body", as: "blocks", placeholder: "_Empty document._" }],
  },
});
```

Render is the engine's generic blocks path under the standard Body section heading, with the model-declared empty-document placeholder — honored by the render fix shipped alongside (model-declared placeholders now apply to present-but-empty fields engine-wide; grouped lists keep a per-group engine default). Registration is the standard three-touch contract: a document subpath export in wiki-models package.json, a tsdown entry emitting self-contained dist/document.js, and a static import in wiki-ui lib/models.ts.

## Decisions
Images: v1 ships without a first-class image block; external images are representable as link-marked text via addExternalLink. An image block kind remains a possible engine follow-up under its own decision record. Images: the intent names image blocks, but the engine's closed IBlock vocabulary (ADR-6) has no image kind, and attachment-ref is section-field-level and used by zero deployed bundles. v1 proceeds WITHOUT first-class images (external images representable as link-marked text via addExternalLink). OK — or should an `image` IBlock kind be added to the engine under its own ADR as a follow-up?

Naming: the type string, bundle id, and page-id prefix are all document. Naming: the type string is a one-way door (page ids become document:<id>). Proceeding with `document` (over `note` / `block-list`). Confirm or rename before real content accumulates.

References: standalone reference blocks only in v1 (addPageRef with optional lead text, addExternalLink); intra-paragraph inline ref editing deferred. Reference granularity: v1 ships standalone reference blocks (addPageRef / addExternalLink produce whole paragraphs). Inserting/editing refs INSIDE an existing paragraph's inline runs is out of scope (no existing bundle does intra-paragraph inline editing). Sufficient for v1?

Prose: plain text only through the curated surface; the block normal form rejects Markdown metacharacters in text runs by design. Curated inline-run authoring is the recommended schema-layer follow-up. Plain-prose authoring gap (from code review): the engine's block normal form rejects Markdown metacharacters in text runs (underscore, asterisk, backtick — 'reify as a code-span, mark, or ref'), and the document type curates no command that authors code-spans or emphasis/strong marks. So a paragraph like 'set the foo_bar option' is currently unauthorable through the curated surface of a general-purpose document. Options: (a) accept for v1 (plain prose only); (b) add curated inline-run authoring (e.g. addParagraph accepting a runs[] arg of text/code-span/marked segments); (c) an engine-level rich-text ingestion decision (its own ADR). Recommendation: (b) as a follow-up — it stays schema-layer and matches the closed-vocabulary philosophy.

## References
_None._

## Child pages
_None._
