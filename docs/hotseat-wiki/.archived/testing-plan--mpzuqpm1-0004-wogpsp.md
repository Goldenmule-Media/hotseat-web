# Testing plan

**Status:** ready

## Planned
_None._

## Passed
- schemaToFields (pure): an empty object schema (z.object({})) → [] so the form is confirm-only; a {sha:string, message:string, url?:string} schema → three text fields with url optional and the rest required; number/integer/boolean/enum(z.enum)/array(z.array) map to the matching FieldKind; an unrecognized property shape → kind "json"; a top-level $ref is resolved into $defs/definitions. (vitest, wiki-ui)
- coerceValues (pure): number/integer inputs become Numbers; a checkbox becomes a boolean; an empty optional field is dropped from args (not sent as ""); a missing required field is reported in errors; array/json text is JSON.parsed and a malformed value is reported as a per-field error rather than thrown. The returned args object contains only coerced, present values. (vitest, wiki-ui)
- usePageMutator (against an in-memory test wiki): a successful run() calls IWorkspaceHandle.mutate with the clicked command name and the coerced args, returns true, and leaves pending false / error null; a command the engine rejects (ValidationError or PreconditionUnmetError) returns false, surfaces the engine's message as a readable error string, and never leaves pending stuck true. (vitest, wiki-ui)
- Edge interactivity (component/logic): clicking an available edge opens the form for the matching command (resolved by descriptor.name === edge.event); a transition whose argsSchema has no fields renders a confirm-and-run body (no inputs) and runs on click; a blocked edge opens the same form read-only with the run button disabled and the unmet reason shown; an inert edge (one not leaving the current state) does nothing. (vitest, wiki-ui)
- Live refresh (end-to-end, real browser): with wiki-ui running against the local server, switching a page to the model view and clicking an available transition (e.g. beginPlanning on a draft feature-brief) runs it, closes the form, and the graph repaints at the new current state through the existing live tail — the current-state marker moves and the available/blocked edge set re-colors with no manual reload. (deferred to a real browser session)
- Typecheck gate: npm run typecheck passes across the workspace (wiki, wiki-models, wiki-mcp, wiki-server, wiki-ui) with the new lib/schema-form.ts, the usePageMutator write path, the TransitionForm + Modal components, and the FsmGraph prop widened from TransitionAvailability[] to IMutationDescriptor[] with workspaceId/pageId threaded from PageView.

## Failed
_None._

## References
_None._

## Child pages
_None._
