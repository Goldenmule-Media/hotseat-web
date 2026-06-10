# Feature: General-purpose block-list page type

**Status:** shipped

## Summary
Add a fifth page-type bundle to wiki-models: a general-purpose `document` type whose entire content is one ordered blocks field (paragraphs, headings, code, lists, tables, quotes, dividers, plus inline page-refs and external links for references), with a single `active` status and zero FSM transitions. This is purely a schema-layer addition: the engine already owns everything needed — the `blocks` field-kind, the closed IBlock vocabulary, the addBlock/removeBlock/moveBlock/setBlock section-ops, and the generic `as: "blocks"` renderer — and the `toc` type is the single-state FSM precedent. Integration is the established three-touch contract: a `./document` subpath export in wiki-models/package.json, a tsdown entry emitting self-contained dist/document.js for runtime loading (`--models wiki-models/document` / `--models-dir` discovery), and a static import in wiki-ui/lib/models.ts. wiki, wiki-mcp, and wiki-server are untouched. v1 ships without a first-class image block (the closed IBlock vocabulary has none — see open questions); external images and references are representable as link-marked text.

## Components affected
- wiki-models/src/document/document.ts — definePageType: single required `body` section with one blocks field, single-state FSM (initialStatus "active", no transitions), curated block commands, render config
- wiki-models/src/document/index.ts — bundle entry: named export + documentPageTypes array + default export (ModelRegistry loader contract)
- wiki-models/package.json — "./document" subpath export alongside ./feature, ./toc, ./architecture, ./adr
- wiki-models/tsdown.config.ts — `document` entry emitting self-contained dist/document.js
- wiki-ui/lib/models.ts — static import of wiki-models/document spread into pageTypes (browser cannot dynamic-import; rebuild required)
- wiki/test/document.test.ts — bundle-contract, golden-render, command, and determinism tests via wiki/testing (bundle tests live in wiki/test per the toc/adr/architecture precedent and the documented dev-only devDep)
- wiki/src/render/read-model.ts — narrow render fix shipped alongside: SectionRender.placeholder is now honored for present-but-empty fields (previously dead — only derived sections and missing fields used it); empty field bodies return "" and the existing caller fallback applies the model-declared placeholder

## Design constraints
1. Determinism hard rule: no Date.now()/Math.random()/new Date() in produces/apply/render; block ids minted via ctx.newId(); equal state must render byte-identical Markdown.
2. Closed IBlock vocabulary (ADR-6): paragraph | heading | code | list | table | quote | divider only — no opaque raw-markdown blocks; adding an image kind would be an engine change requiring its own ADR.
3. Import style: extensionless relative imports inside wiki-models (consumed as TS source, moduleResolution Bundler).
4. Bundle loader contract: the module must default-export an array of page types or wiki-mcp's loader throws.
5. tsdown deps.alwaysBundle must stay the regex /^wiki(\/|$)/ so wiki/authoring is inlined into dist/document.js — a bare string causes ERR_MODULE_NOT_FOUND at runtime.
6. Single-state design: initialStatus "active", statusTransitions: [], body section mutableIn ["active"]; removal is structural archivePage (toc precedent); no agency edges, no awaitsHuman elements.
7. The type string `document` is permanent — page ids become document:<id>; version 1 with no upcasters.
8. Code blocks are authored with hash "" and the engine recomputes the content hash at ingestion; subsequent edits go through the generated applyTextEdits command under expectedHash.
9. Iterating on the bundle source requires a wiki-server restart — POST /_server/models/{id}/reload silently no-ops on source edits.
10. Schema-agnostic boundary: the page type lives entirely in wiki-models, authored only against wiki/authoring; never imports wiki-mcp/wiki-server; the engine learned NO document-specific concept. One deliberate generic engine fix shipped alongside (model-declared placeholders honored for empty fields) — it benefits every bundle, not just this one.

## Open questions
_None._

## Resolved questions
1. **Images: the intent names image blocks, but the engine's closed IBlock vocabulary (ADR-6) has no image kind, and attachment-ref is section-field-level and used by zero deployed bundles. v1 proceeds WITHOUT first-class images (external images representable as link-marked text via addExternalLink). OK — or should an `image` IBlock kind be added to the engine under its own ADR as a follow-up?** — _v1 shipped WITHOUT a first-class image block. External images are representable as link-marked text (addExternalLink). Extending the closed IBlock vocabulary with an `image` kind remains a possible follow-up under its own decision record (ADR-6 governs additions)._
2. **Naming: the type string is a one-way door (page ids become document:<id>). Proceeding with `document` (over `note` / `block-list`). Confirm or rename before real content accumulates.** — _`document` confirmed: bundle id, type string, and page-id prefix (document:<id>) all shipped as `document`._
3. **Reference granularity: v1 ships standalone reference blocks (addPageRef / addExternalLink produce whole paragraphs). Inserting/editing refs INSIDE an existing paragraph's inline runs is out of scope (no existing bundle does intra-paragraph inline editing). Sufficient for v1?** — _Standalone reference blocks shipped for v1: addPageRef (optional lead text + integrity-checked inline page ref) and addExternalLink (link-marked text run). Intra-paragraph inline ref insertion/editing is deferred._
4. **Plain-prose authoring gap (from code review): the engine's block normal form rejects Markdown metacharacters in text runs (underscore, asterisk, backtick — 'reify as a code-span, mark, or ref'), and the document type curates no command that authors code-spans or emphasis/strong marks. So a paragraph like 'set the foo_bar option' is currently unauthorable through the curated surface of a general-purpose document. Options: (a) accept for v1 (plain prose only); (b) add curated inline-run authoring (e.g. addParagraph accepting a runs[] arg of text/code-span/marked segments); (c) an engine-level rich-text ingestion decision (its own ADR). Recommendation: (b) as a follow-up — it stays schema-layer and matches the closed-vocabulary philosophy.** — _Accepted for v1: plain prose only through the curated surface (the engine's block normal form rejects Markdown metacharacters in text runs by design). Curated inline-run authoring — e.g. addParagraph accepting a runs[] of text / code-span / marked segments — is the recommended schema-layer follow-up; an engine-level rich-text ingestion change would need its own ADR._

## References
_None._

## Child pages
- [Implementation plan — General-purpose block-list page type](implementation-plan:mq853dwy-007k-xwyarw)
- [Testing plan — General-purpose block-list page type](testing-plan:mq853dwy-007l-p9iq5q)
- [Spec — General-purpose block-list page type](feature-spec:mq853dwy-007m-gaoa46)

## Commits
- `f5bfe7d` fix(render): honor model-declared SectionRender.placeholder for empty fields
- `a64af23` feat(wiki-models): general-purpose block-list `document` page type
- `0177cda` fix(document): harden curated commands + single-home the placeholder fallback
