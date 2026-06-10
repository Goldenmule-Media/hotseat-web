# Implementation plan — General-purpose block-list page type

**Status:** ready

## Steps
- [x] Create wiki-models/src/document/document.ts: one definePageType call — type "document", version 1, initialStatus "active", statusTransitions: [] (toc precedent), one required section `body` with a single { kind: "blocks" } field, mutableIn ["active"], sectionSet { mode: "closed" }. Extensionless imports from wiki/authoring only.
- [x] Author the curated command set in document.ts, reusing the produce-SectionOps pattern from feature-spec.ts / adr.ts: addParagraph, addHeading, addCode (hash "" recomputed at ingestion), addPageRef (inline {kind:"ref",target:{kind:"page",id}}), addExternalLink (link mark on a text run), setParagraph (setBlock), moveBlock, removeBlock — all targeting {section:"body", field:"body"}, with optional index on the add commands.
- [x] Declare the render config: title "{title}", one section render { section: "body", field: "body", as: "blocks", placeholder: "_Empty document._" }. The body renders under the standard "## Body" section heading — the engine's renderPage always emits a section heading (falling back to the section name), so a heading-free document body would be an engine change, out of scope. The engine's generic renderBlocks does the rest — zero custom render code.
- [x] Create wiki-models/src/document/index.ts per the bundle entry contract (feature/index.ts pattern): named export Document, const documentPageTypes = [Document], default export = the array (ModelRegistry loader contract).
- [x] Register the subpath export in wiki-models/package.json: "./document": "./src/document/index.ts" — enables the wiki-models/document specifier for both wiki-server --models and wiki-ui's static import.
- [x] Add the tsdown entry in wiki-models/tsdown.config.ts: document: "src/document/index.ts" → emits self-contained dist/document.js; leave the deps.alwaysBundle regex /^wiki(\/|$)/ untouched.
- [x] Write wiki/test/document.test.ts — bundle tests live in wiki/test via the documented dev-only devDep on wiki-models (toc/adr/architecture precedent; wiki-models has no test dir and its tsconfig covers only src/). Use wiki/testing (createTestWiki): bundle contract + FSM shape (fsmOf/describeType), empty-render placeholder, ordered-authoring golden render, insert-at-index, moveBlock/setParagraph, removeBlock integrity, code-hash canonicalization + applyBodyBodyBlockEdits expectedHash guard (StaleEditError), addPageRef integrity (valid + rename-reflow + dangling aborts), addExternalLink link render, byte-identical determinism across two instances under injected ids.
- [x] Engine render fix (wiki/src/render/read-model.ts): honor model-declared SectionRender.placeholder for present-but-empty fields — renderFieldBody/renderListField return "" for empty scalar/prose/blocks/flat-list bodies so the caller's existing `sr.placeholder ?? placeholder()` fallback applies (previously only derived sections and missing fields honored it; grouped lists unchanged). Update the stale workaround note in wiki-models/src/architecture/architecture.ts and the two architecture.test.ts assertions that pinned the old dead-placeholder behavior.
- [x] Verify: npm run typecheck (root), npm run test -w wiki-models, npm run build -w wiki-models (confirm dist/document.js exists and is self-contained), npm run test (root — no regressions).
- [x] Runtime smoke test: boot wiki-server with --models wiki-models/document, and confirm --models-dir ../wiki-models/src auto-discovers the new src/document/ directory; GET localhost:4438/_server/models lists bundle id "document". (Source edits need a server restart — reload no-ops.)
- [x] Wire wiki-ui: in wiki-ui/lib/models.ts add the static import of wiki-models/document and spread documentPageTypes into pageTypes (typesRenderingOwnChildren is computed generically — no change); then run npm run typecheck && npm run build inside wiki-ui/.
- [x] Code-review hardening (commit 0177cda): setParagraph rejects non-paragraph targets (engine setBlock is kind-blind — a heading/code id would be silently converted); addCode language constrained to a single fence-safe token (rendered verbatim into the fence line); text args min(1) (an empty text run commits and renders "", making a 1-block document render as empty); addPageRef trims trailing lead-text whitespace; placeholder fallback single-homed inside renderFieldBody/renderListField (no ""-sentinel contract); grouped-list placeholder exception documented. Two regression tests added (setParagraph kind guard, malformed-arg rejection).

## Data models & interfaces
```typescript
// wiki-models/src/document/index.ts — bundle entry (pattern: wiki-models/src/feature/index.ts)
export { Document } from "./document";

import { Document } from "./document";

export const documentPageTypes = [Document] as const;

// Default export = the page-type array: the ModelRegistry loader contract
// (wiki-mcp's loader throws unless the module default-exports an array of page types).
export default documentPageTypes;
```

```typescript
// wiki-models/src/document/document.ts (as landed) — authored against wiki/authoring only.
// Engine-owned shapes composed here (all pre-existing in wiki/src/api.ts):
//   FieldKind "blocks"   IBlock: paragraph | heading | code | list | table | quote | divider
//   IInline: text{value,marks} | code-span | ref{target}   Mark: strong | emphasis | {kind:"link",href}
//   Block SectionOps: addBlock{block,index?} | removeBlock | moveBlock{toIndex} | setBlock
import type { BlockId, IBlock, IInline, PageId, RefTarget } from "wiki/authoring";
import { definePageType, z, zodSchema } from "wiki/authoring";

function paragraph(id: BlockId, text: string): IBlock {
  return { kind: "paragraph", id, inlines: [{ kind: "text", value: text, marks: [] }] };
}

export const Document = definePageType({
  type: "document",           // permanent: page ids become document:<id>
  label: "Document",
  version: 1,                 // no upcasters at v1
  initialStatus: "active",    // single state — toc precedent
  statusTransitions: [],      // no workflow gates; archivePage handles removal
  sections: {
    body: {
      name: "Body",
      required: true,
      mutableIn: ["active"],
      fields: { body: { kind: "blocks" } },  // ONE ordered IBlock[] = the whole document
    },
  },
  sectionSet: { mode: "closed" },
  commands: {
    // every command targets { section: "body", field: "body" }; adds take an optional index
    addParagraph:    {}, // produces addBlock(paragraph(ctx.newId(), text), index?)
    addHeading:      {}, // level 1–6 + text
    addCode:         {}, // { language, source } — hash "" recomputed at ingestion;
                         // later edits via generated applyBodyBodyBlockEdits under expectedHash
    addPageRef:      {}, // optional lead text + inline {kind:"ref",target:{kind:"page",id}};
                         // label render-derived (renames reflow); dangling id aborts the commit
    addExternalLink: {}, // text run with {kind:"link",href} mark → renders [text](href)
    setParagraph:    {}, // setBlock in place — same BlockId, position unchanged
    moveBlock:       {}, // moveBlock → toIndex
    removeBlock:     {}, // unknown id rejects the commit
  },
  render: {
    title: "{title}",
    // renders under the standard "## Body" section heading (engine always emits one)
    sections: [{ section: "body", field: "body", as: "blocks", placeholder: "_Empty document._" }],
  },
});
```

## Open questions
_None._

## Resolved questions
_None._

## References
_None._

## Child pages
_None._
