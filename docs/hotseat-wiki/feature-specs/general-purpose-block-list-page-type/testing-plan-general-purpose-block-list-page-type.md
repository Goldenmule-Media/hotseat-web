# Testing plan — General-purpose block-list page type

**Status:** ready

## Planned
_None._

## Passed
- Bundle contract: importing wiki-models/src/document/index.ts yields a default export that is an array of exactly one page type with type "document" (the ModelRegistry loader contract).
- Creation + empty render: createPage of type document auto-materializes the required body section empty; the rendered Markdown is the title plus the placeholder, and rendering twice from the same state is byte-identical.
- Ordered authoring golden render: addHeading(1) → addParagraph → addCode → addParagraph produces blocks in exactly that order and the rendered Markdown golden-matches, with the code block fenced with its declared language.
- Insert at index: addParagraph with index 0 prepends; the render reflects the new order.
- moveBlock + setParagraph: moveBlock reorders an existing block to toIndex; setParagraph replaces a paragraph in place keeping the same block id; both reflected exactly in the next render.
- removeBlock on an unknown block id is rejected by the engine, leaving state and render unchanged.
- Code hash + guarded edit: addCode with hash "" is canonicalized to a real content hash at ingestion; the generated applyTextEdits succeeds with the correct expectedHash and rejects a stale one.
- addPageRef integrity: with a valid target page id the commit succeeds and the render shows the link; with a dangling page id the whole commit aborts with a ref-integrity error.
- addExternalLink renders a Markdown link from the link mark on the text run.
- Single-state FSM surface: describeMutations on a document page exposes the curated content commands in active and NO page-level transitions; nextActions/attention surface nothing for the page.
- Determinism under injected ids: two runs of the identical command sequence with the same injected newId()/now() produce byte-identical Markdown.
- wiki-ui integration: after the static import, pageTypes includes document and typesRenderingOwnChildren does not; npm run typecheck and npm run build pass inside wiki-ui/.
- Runtime discovery (manual): wiki-server boots with --models wiki-models/document; root --models-dir discovery also finds bundle id document; GET localhost:4438/_server/models lists it.

## Failed
_None._

## References
_None._

## Child pages
_None._
