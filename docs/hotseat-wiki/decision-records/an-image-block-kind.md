# An `image` block kind

**Status:** proposed

## Metadata
- **Number:** ADR-35
- **Date:** 2026-08-19
- **Scope:** wiki

## Context
The closed block vocabulary had no image. A Markdown image degraded to a literal exclamation mark followed by a link, which round-tripped well enough that the mirrored files happened to show a picture on GitHub, but the model did not know an image was there and no client could treat it as one. ADR-6 set the bar for fixing that: a new kind requires a decision record proving closed render, stable-id addressability, and no opaque leaf. Reading notes and general documents both wanted images, and the attachment store made uploaded bytes referenceable, so the gap became worth closing.

## Decision
Add `image` to the closed IBlock vocabulary: `{ kind: "image", id: BlockId, ref: string, alt: string, title?: string }`.

It clears ADR-6's three tests. The render is closed and total, exactly `![alt](ref)` with an optional quoted title. It carries a BlockId like every other block, so it is addressable and editable in place. It has no opaque leaf, because ref, alt and title are attributes rather than embedded markup.

The ref is either `attachment:<sha256>`, naming bytes in this wiki's own attachment store, or an ordinary absolute URL. The renderer emits it VERBATIM. Resolving it to a fetchable URL belongs to each consumer, because wiki-ui resolves to an object URL and wiki-mirror resolves to a relative path on disk. Injecting a base URL into the renderer would make the Markdown host-dependent and break the rule that equal state renders byte-identically everywhere.

Parsing is BLOCK POSITION ONLY: a line that is exactly one image becomes an image block. An image in the middle of a paragraph keeps the historic degradation, which is still a parseInline fixed point, so nothing that parses today changes shape. Inline images remain a separate decision if they are ever wanted.

Normal form rejects a ref, alt or title that would render Markdown which no longer parses back to the same block: an empty ref, a newline anywhere, parentheses in the ref, brackets in the alt, or a quote in the title. The round-trip fixed point is the property the whole blocks model rests on, so it is guarded rather than assumed.

## Consequences
The IBlock union gains a seventh kind, and the four engine sites that switch on block kind gain a case: the block-Markdown parser, the renderer, and ingestion's normalize and normal-form checks. The read-model projections in wiki-mcp need no change, because they walk with if/else chains rather than exhaustive switches.

A pre-existing paragraph whose entire content is an exclamation mark followed by a link now re-parses as an image block on a render-then-reparse round trip. Stored events are unaffected, since folds read events rather than Markdown, so no page changes shape in place.

An attachment ref is NOT integrity-checked. Ingestion is synchronous and pure, and an existence check would need I/O, so a ref has the same standing as an external URL: it may dangle, and a consumer that cannot resolve it leaves it verbatim.

The document bundle gains addImage and setImage alongside its other one-command-per-block-kind pairs, and its long-standing note that images await a decision record is removed.

## Relations
_None._
