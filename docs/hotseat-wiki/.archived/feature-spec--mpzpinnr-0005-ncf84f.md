# Spec

**Status:** sealed

## Overview
Design for wiki-ui model inspection: a header toggle on the page view that swaps the rendered content for a directed-graph view of the page type's status FSM, with the open page's current state highlighted and its outgoing transitions classified available vs. blocked-with-reason. The graph is a property of the page TYPE (from the engine's new `fsmOf`); the highlight is a property of the page INSTANCE (from a precondition-aware `describeMutations`). v1 covers the page-level status FSM only. The decisions below resolve each question raised on the brief.

## Design
_No design yet._

## Decisions
Render with React Flow (@xyflow/react) plus a dagre layout pass. React Flow gives the per-node/per-edge styling, hover, and dynamic class-switching the available/blocked overlay needs; dagre positions the states so we draw no SVG by hand. Mermaid's toMermaid() is not the render path. Graph library: Mermaid vs. an interactive layout+render library? The Guard already emits a Mermaid state diagram via toMermaid() (near-zero extraction work, but limited per-node/per-edge interactivity and dynamic highlighting), versus React Flow (@xyflow/react with a dagre/elk layout) or Cytoscape (full control over node/edge styling, hover, click, and live highlighting — at the cost of building the graph from states()/transitions and running layout). Leaning React Flow for the dynamic available-now highlighting, with Mermaid as a possible fast first cut.

The engine describes the FSM, via a new IWiki.fsmOf(type) call built from the registry (which holds every registered type, including runtime-loaded ones). The in-browser engine serves wiki-ui directly; the same call can later back a server or MCP endpoint for processes that didn't bundle the model. No FSM topology is hardcoded or rebuilt in the UI. FSM data source — client-side or server endpoint? wiki-ui statically imports the model bundles and runs an in-browser engine, so it could derive the FSM from the page type's Guard directly with no backend change. But models are meant to be runtime-loaded by the server, and a UI that only knows statically-imported types cannot inspect a model it didn't bundle. Do we (a) derive client-side from the imported Guard now, or (b) add a server-side FSM-metadata endpoint / MCP introspection tool so the UI can inspect any loaded model? This is the load-bearing architectural choice; everything else follows from it.

fsmOf returns a real typed object, not a string: FsmDescriptor with type, initial, states (initial first), and transitions, where each transition is from/event/to plus optional meta. Consumers render it with React Flow, drive other tooling from it, or serialize it themselves. The internal Guard (states/transitions) backs it; the descriptor is the public, stable shape. If the FSM is derived from the Guard (client- or server-side), what is the right public shape for exposing it? The Guard is internal to wiki today. Options: export a registry accessor (e.g. registry.pageGuard(type)), or add a serializable descriptor (e.g. fsmOf(type) -> { states, transitions: [{from, event, to, meta}], initial }) that both the UI and any endpoint can consume. Which package owns it, and should it be part of wiki's public surface or wiki/registry?

The per-instance overlay comes from describeMutations. Note this requires a refinement: today its available flag for a page transition is pure FSM legality. We extend it to also evaluate the command's pure preconditions against current state and surface the first unmet reason, so available means runnable-now and blocked transitions carry their why (e.g. all testing-plan cases must be passed). fsmOf draws the full graph; this overlay colors the outgoing edges from the current state. Source of "currently available": pure FSM or describeMutations? guard.available(status) yields the FSM-legal transitions, but describeMutations additionally factors in preconditions (e.g. ship is FSM-legal from review yet blocked until the checklist is complete and open questions are zero). Driving the highlight from describeMutations lets us render precondition-blocked transitions as "blocked — here's why" rather than misleadingly "available." Confirm describeMutations is the intended source for the instance overlay, with the Guard supplying the full type-level graph underneath.

v1 covers the page-level status FSM only. Element-level FSMs (question open to resolved, plan step todo to done, test case planned to passed/failed) are deferred. The FsmDescriptor shape is general enough to carry element FSMs later without rework. Scope: page-level status FSM only, or element-level FSMs too? Several element types carry their own FSMs (a question is open → resolved; a plan step is todo ↔ done; a test case is planned → passed/failed). Is element-FSM visualization in scope for v1, or do we ship the page-status FSM first and defer element FSMs to a follow-up?

A toggle button in the page-view header switches between the rendered content and the FSM graph. v1 is a view switch (not a side-by-side panel or separate route), keeping the type-level graph and the live per-instance highlight one click from the page being read. Where does the view live: a side panel on the existing page view, a dedicated tab/route per page, or a modal/overlay? This affects how we present the per-type-vs-per-instance distinction (the graph is the type's; the highlight is this instance's) and how the live status binding is surfaced.

## References
_None._

## Child pages
_None._
