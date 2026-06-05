# feature-spec

**Status:** current

## Kind
component

## Summary
The question-free, DECIDED source of truth authored *from* the brief's resolved questions — flowing prose + data-model code blocks + inline `ref`s back to the decisions they settle. A required child of `feature-brief`, materialized empty at creation.

## Purpose
Separates the clean current design (the spec) from the deliberation trail (the brief's Q&A), and structurally guarantees no resolved decision was silently dropped.

## Components
_No components._

## Dependencies
- **depends-on** → [feature-brief](architecture:mpzoj1j9-0055-wifv4u) — Authored FROM the brief's resolved questions; the `seal` gate requires every resolved decision to be referenced inline.

## Code references
- constant `FeatureSpec` in `wiki-models/src/feature/feature-spec.ts`

## Data model
Three sections — one `prose` (`overview.body`) and two `blocks` bodies (`design.body`, `decisions.body`); no element types, no `derived` / `computed`. `addDecision` emits a `paragraph` block whose inline `ref` (kind `element`, `labelField: "text"`) points at a brief question; `addDesignCode` emits `code` blocks with hash recomputed at ingestion.

## Usage
**Lifecycle:** `drafting → sealed` (with `sealed → drafting` reopen); declares `finalize: "seal"` (the terminal event the brief's cascade fires). Sections: `overview` (prose), `design` (blocks), `decisions` (blocks). Representative commands: `setOverview`, `addParagraph` / `addHeading` / `addDesignCode`, the load-bearing `addDecision` (threads an inline element-`ref` to a decided brief question), and `seal` / `reopen`.

## Invariants & constraints
- `seal` is gated by the `everyDecisionReferenced` precondition: the engine collects the spec's inline element-refs targeting the parent brief's questions and requires every RESOLVED brief question to be referenced (else seal is rejected with the unreferenced count).
- The seal gate is structural, not prose-correctness — it only proves every decision is threaded in.
- `sectionSet` closed; all three sections `required` and `mutableIn: ["drafting"]` (frozen once sealed); `addDecision` falls back to a plain paragraph (no dangling ref) if the brief / questions section is absent.

## Synced commit
e357aa7
