# Implementation plan

**Status:** ready

## Steps
- [x] Engine — FSM descriptor. Add a serializable `FsmDescriptor` ({ type, initial, states[], transitions: [{from, event, to, meta?}] }) to wiki's public type surface (api.ts) and implement `IWiki.fsmOf(type)` on the Wiki class, building it from `registry.page(type).initialStatus` + `registry.pageGuard(type)` (states()/transitions). Throw UnknownPageTypeError for unknown types. Re-export the type from wiki/src/index.ts. Unit-test against feature-brief: initial=draft, full state set, every transition's from/event/to, and JSON-serializable (no functions/cycles).
- [x] Engine — precondition-aware availability. Today `IPageView.describeMutations().available` for a page-transition command is just `guard.can(status, event)`; the command's pure `preconditions` (each returning true | {unmet: reason}) run only at commit. Extend the page-transition branch in PageView.describeMutations to also evaluate `commandDef(type,name).preconditions` against current folded state (construct an IRelatedReader over the projection: page(id)->pageStateView, childrenOf, self), so `available` means 'legal AND runnable now', and add `unmet?: string` to IMutationDescriptor carrying the first failed precondition's reason. Unit-test: ship from `review` is available:false with unmet reason until checklist/cases/questions gates pass, then available:true.
- [x] wiki-ui — FSM graph view. Add `@xyflow/react` (React Flow) + `dagre` as wiki-ui dependencies. Write a pure, unit-tested `buildFsmGraph(fsm, currentStatus, overlay)` that maps the descriptor to React Flow nodes/edges, tagging each: the current-state node; outgoing edges as `available` or `blocked` (with reason from `unmet`); all other edges `inert`. Add a client-only `<FsmGraph>` component that runs a dagre layout over the nodes/edges, renders them with React Flow, styles the four classes distinctly, and shows transition meta / block reason on hover.
- [x] wiki-ui — wiring + header toggle. Add a button in the page-view header that toggles between the rendered content and the FSM graph. Feed <FsmGraph> from the in-browser engine: `engine.fsmOf(pageType)` for the type-level graph and `view.describeMutations()` filtered to page-transition commands for the per-instance overlay, refreshed live via the existing WorkspaceSession tail so the current-state marker and available set track status changes. Verify end-to-end: `npm run typecheck` clean across the workspace, `npm run test -w wiki` green, and an app smoke-check (toggle renders the graph, current state highlighted, a blocked transition shows its reason).

## Data models & interfaces
```typescript
// ── Engine: public, serializable FSM descriptor (wiki/src/api.ts) ──
// Returned by IWiki.fsmOf(type) for ANY registered page type (incl. runtime-loaded).
export interface FsmTransition {
  readonly from: string;          // source status
  readonly event: string;         // page-transition command name, e.g. "ship"
  readonly to: string;            // target status
  readonly meta?: { readonly description?: string };
}
export interface FsmDescriptor {
  readonly type: string;          // page-type tag, e.g. "feature-brief"
  readonly initial: string;       // def.initialStatus, e.g. "draft"
  readonly states: readonly string[];        // initial first, then the rest
  readonly transitions: readonly FsmTransition[];
}

interface IWiki {
  // ...existing createWorkspace/openWorkspace/listWorkspaces/close
  fsmOf(type: string): FsmDescriptor;         // NEW — pure, from registry
}

// ── Engine: per-instance overlay (extend IMutationDescriptor) ──
interface IMutationDescriptor {
  readonly name: string;
  readonly available: boolean;    // NOW: FSM-legal AND preconditions met
  readonly unmet?: string;        // NEW — first failed precondition's reason
  // ...argsSchema, resultSchema?, description?, target?
}

// ── wiki-ui: pure view-model transform (unit-tested, no React) ──
type EdgeClass = 'current' | 'available' | 'blocked' | 'inert';
interface FsmGraphModel {
  nodes: { id: string; label: string; isCurrent: boolean }[];
  edges: { id: string; source: string; target: string; label: string;
           cls: EdgeClass; reason?: string }[];
}
function buildFsmGraph(
  fsm: FsmDescriptor,
  currentStatus: string,
  overlay: ReadonlyArray<{ name: string; available: boolean; unmet?: string }>,
): FsmGraphModel;  // edges from currentStatus => available|blocked(+reason); else inert
```

## Open questions
_None._

## Resolved questions
_None._

## References
_None._

## Child pages
_None._
