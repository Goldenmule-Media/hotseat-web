# Testing plan

**Status:** ready

## Planned
_None._

## Passed
- Engine/fsmOf: `fsmOf("feature-brief")` returns initial "draft", the full state set (draft, planning, building, review, shipped, abandoned), every declared transition with correct from/event/to, and is JSON round-trippable (no functions/cycles). Unknown type throws UnknownPageTypeError. (vitest, wiki)
- Engine/precondition-aware availability: on a feature-brief in `review`, describeMutations() reports ship.available=false with ship.unmet naming a failed gate (e.g. cases/checklist/questions) while gates are unmet; after checklist complete + all cases passed + zero open questions, ship.available=true and unmet is absent. FSM-only-illegal commands (e.g. beginPlanning from review) stay available=false with no unmet. (vitest, wiki)
- wiki-ui/buildFsmGraph (pure): given a descriptor + currentStatus + overlay, the current-state node is marked isCurrent; outgoing edges from currentStatus are classed `available` or `blocked` (carrying the unmet reason) per the overlay; all non-outgoing edges are `inert`. Edge/node counts match the descriptor. (vitest, wiki-ui)
- Typecheck gate: `npm run typecheck` passes across the workspace (wiki, wiki-models, wiki-mcp, wiki-server, wiki-ui) with the new FsmDescriptor/fsmOf, the IMutationDescriptor.unmet field, and the wiki-ui graph view in place.
- App smoke-check (running wiki-ui against the local server): opening a page shows a header toggle; switching to the graph view renders the page type's FSM as a directed graph with the current state highlighted; for a brief in `review`, the `ship` edge renders as blocked and reveals its reason; toggling back restores the content view. Verified via a real browser session.

## Failed
_None._

## References
_None._

## Child pages
_None._
