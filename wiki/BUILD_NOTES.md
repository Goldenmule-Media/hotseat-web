# BUILD_NOTES — authoritative implementation guide

Read this **with** `DESIGN.md`. Where this file and DESIGN disagree, **this file wins**
(it reflects the *real* `@durable-streams` behavior, verified empirically, and resolves
ambiguities DESIGN left open). The contract spine is already on disk and compiles:
`src/api.ts`, `src/core/errors.ts`, `src/core/guard.ts`, `src/core/types.ts`. **Do not
edit the spine** unless a repair is unavoidable; everything else is built against it.

## 0. Toolchain & conventions (MUST follow exactly)

- TypeScript, **ESM**, `moduleResolution: "Bundler"` → **import WITHOUT file extensions**
  (`import { x } from "../api"`, not `"../api.ts"` / `"../api.js"`). Vitest runs `.ts` directly.
- `strict: true`. Avoid `any` except where the spine already uses it. No `Date.now()`,
  `Math.random()`, or `new Date()` in reducers, deciders (`produces`), or renderers — those
  arrive via injected `now()` / `newId()` (DESIGN §11).
- Interfaces are `I`-prefixed; events PascalCase past-tense (`QuestionAnswered`); commands
  camelCase imperative (`addConstraint`). A page's id prefix == its `type` (`feature-brief:<id>`).
- Tests live in `wiki/test/**/*.test.ts` (vitest). Run from `wiki/`: `npm run typecheck`,
  `npm run test`. **Do NOT run `npm install`** (already done) and do not run the full build
  while neighboring files may be missing — only the dedicated repair phase compiles the whole tree.
- The package is `wiki`. Within `src/`, import by relative path. Public surface is re-exported by
  `src/index.ts` (DESIGN §10.7).

## 1. Persistence: the REAL Durable Streams behavior (overrides DESIGN §3.2/§9.1)

Verified against `@durable-streams/client@0.2.6` + `@durable-streams/server@0.3.5`:

1. **A posted JSON array is NOT split into per-element messages.** One `append()` call stores
   exactly ONE message (the whole body). `stream(...).json()` returns one item per message.
   → **Each command's events are stored as ONE message = a JSON array `IEventEnvelope[]` (a "commit").**
   On read we **flatten** the array-messages into a flat event list. One message append is atomic,
   so a multi-event command is atomic by construction (DESIGN's atomicity goal, achieved differently).
2. **`Stream-Seq` gives strict-greater optimistic concurrency.** `handle.append(body, { seq })`
   succeeds iff `seq > lastSeq` (lexicographic); equal or lower → **HTTP 409 "Sequence conflict"**
   surfaced as a `FetchError` with `.status === 409`. The server stores `lastSeq` = the seq header
   of the last successful append (NOT message/array length).
   → **OCC:** set `seq = String(expectedVersion).padStart(20, "0")` where `expectedVersion` is the
   folded head (event count). First writer from head H wins; any other writer that folded the same
   head H sends the same seq and gets 409 → rebase-and-retry. Monotonic because each commit appends
   ≥1 event, so head strictly increases.
3. `DurableStream.create({url, contentType})` is idempotent here (no throw on existing). Still wrap
   defensively: catch a 409/"exists" conflict and treat as success. `DurableStream.head({url})`
   returns `{exists:boolean,...}`.
4. Resume: pass a saved `res.offset` as the next `offset`; returns only newer messages. Live tail:
   `stream({url, offset, live:true}).subscribeJson(batch => ...)` — `batch.items` are the
   array-messages (flatten each), `batch.offset` is the resume cursor.

### EventLog (`src/stores/event-log.ts`) — the ONLY importer of `@durable-streams/client`

Implements `IEventLog` (in `core/types.ts`). Imports `DurableStream, IdempotentProducer?, stream,
FetchError` from `@durable-streams/client`. Key methods:

- `urlFor(ws)` = `${baseUrl}/${namespace}/workspace/${encodeURIComponent(ws)}`. Cache `DurableStream`
  handles per ws (Map) so we don't re-create each call.
- `ensure(ws)`: `await DurableStream.create({url, contentType:"application/json", ttlSeconds})`;
  swallow an already-exists 409. Cache the handle.
- `exists(ws)`: `DurableStream.head({url}).then(r => r.exists)`.
- `append(ws, events, {expectedVersion})`: no-op if `events.length===0`. Body =
  `JSON.stringify(events)`; `seq = pad(expectedVersion)`; `await handle.append(body, { seq })`.
  Catch `FetchError`/error with `status===409` (or message includes "Sequence"/"conflict") → throw
  `new StaleAppendError()` (from `core/types`). Return `{ headVersion: expectedVersion + events.length,
  cursor: <res offset if available> }` (cursor may be undefined; bus tolerates).
- `read(ws, fromCursor?)`: `const res = await stream<IEventEnvelope[]>({url, offset: fromCursor ?? "-1",
  live:false}); const batches = await res.json(); return { events: batches.flat(), nextCursor: res.offset }`.
- `subscribe(ws, onBatch, {fromCursor?})`: `const res = await stream<IEventEnvelope[]>({url,
  offset: fromCursor ?? "-1", live:true}); const unsub = res.subscribeJson(b => onBatch((b.items as
  IEventEnvelope[][]).flat(), b.offset)); return () => { unsub(); res.cancel?.(); }`.
- Snapshot stream `…/workspace/{id}/snapshot`: `appendSnapshot` = ensure+append one JSON message
  (no seq needed); `readLatestSnapshot` = read all, return last item (or undefined). Different
  contentType is fine (application/json).
- Catalog stream `…/{namespace}/_catalog`: `appendCatalog` = ensure+append one message;
  `readCatalog` = read all, flatten if needter (each append is one CatalogEvent object → items are
  the objects). No OCC.
- `close()`: cancel live subscriptions, clear handle cache.

Pad helper: `const pad = (n:number) => String(n).padStart(20, "0")`.

## 2. Event model, envelope, routing

- `produces`/structure handlers return **lightweight `DomainEvent`s**: `{ type, pageId?, payload }`.
  The **command bus envelopes** each into `IEventEnvelope` assigning: `eventId = newId()`,
  `streamId = ws`, `version` (contiguous from `expectedVersion`), `schemaVersion` (the page type's
  current `version`, or `0` for structural/workspace events), `meta = { occurredAt: now(), actor,
  commandId }`, and `pageId` (for page commands, default to the target page if the event omits it).
- **Reducer** (`core/workspace.ts`): `foldWorkspace(events, registry, from?) => IWorkspaceState` and
  `applyWorkspace(state, event, registry) => state` (mutate-in-place or return new; be consistent —
  in-place on a cloned working state is fine since fold owns the state). `foldWorkspace` from zero:
  `events[0]` must be `WorkspaceCreated`. The reducer:
  - asserts `version` contiguity (throw on a gap) — but tolerate snapshot skips (caller filters).
  - **upcasts** a content event's payload before `apply` (compose the page type's `upcasters` from
    `event.schemaVersion` up to current `version`; DESIGN §8.5). A `schemaVersion` > registered
    `version`, or an unknown page/event type, → `UnknownPageTypeError`.
  - Handles **structural events itself**; routes **content events** to
    `registry.page(node.type).apply(node, upcastedEvent)`.

### Structural / workspace events (handled in `applyWorkspace`)
`WorkspaceCreated{name}` (init empty state, status active, children:{"@root":[]}, version counting) ·
`PageCreated{type,parentId,title,pinned?}` (build node from `registry.page(type)` initialStatus +
deep-cloned `initialFields` + empty arrays for each declared item type; append id to
`children[parentId ?? "@root"]`) · `PageReparented{pageId,oldParentId,newParentId,position?}` ·
`ChildrenReordered{parentId,orderedChildIds}` · `PageTitleSet{pageId,title}` ·
`PageArchived{pageId}` (set node.status="archived") · `LinkAdded{from,to,role}` ·
`LinkRemoved{from,to,role}` · `WorkspaceArchived{}` (state.status="archived").
For `PageCreated`, the event's `pageId` IS the new page's id (`${type}:${newId()}`).

### Content events → routed to the owning page type's `apply`
The page type's `apply(page, event)` owns ALL page mutation, **including page.status and item.status**.
e.g. feature-brief `apply`: `PlanningBegan` → `status:"planning"`; `QuestionAsked{id,text}` → push
`{id,text,status:"open"}` into `items.question`; `QuestionAnswered{id,answer}` → set that question's
`status:"resolved"` + `answer`. The FSM guard authorizes commands; `apply` reflects the effect. The
author keeps them consistent (tested).

## 3. Command bus (`core/command-bus.ts`) — the hot path (DESIGN §5, §15)

`CommandBus` operates on ONE workspace projection (state + full in-memory `events[]` + cursor) given
by the handle. Three entry points (`runStructural`, `runPage`, `runPageBatch`):

- `structural(state, {handlerName, args, commandId?, actor?})`: validate light, ensure workspace
  active (else `WorkspaceArchivedError`), call the structure handler → `{events, result}`, then
  **commit** (below).
- `page(state, {pageId, command, args, commandId?, actor?})`: find node (`PageNotFoundError`); get
  `def = registry.page(node.type)`; get `cmd = def.commands[command]` (else `MutationNotAllowedError`
  with allowed = guard.available(status)); `const parsed = cmd.args.parse(args)` (→ `ValidationError`);
  **guard:** `guard(def.statusTransitions).can(node.status, command)` must be true, else
  `MutationNotAllowedError(node.type, node.status, command, available)`. If
  `cmd.transition.level==="item"`: find the item `node.items[itemType].find(i=>i.id===parsed[idArg])`
  (`ItemNotFoundError`); check the item type's FSM `itemGuard.can(item.status, cmd.transition.event)`
  else `MutationNotAllowedError`. Build `ctx: ICommandContext` (newId, now, actor, commandId, related
  reader over `state`). `const {events, result} = cmd.produces(pageStateView(node), parsed, ctx)`.
  Then **commit**.
- `pageBatch(state, {pageId, commands[], …})` (powers `IWorkspaceHandle.mutateMany`): an ATOMIC
  ordered batch on one page. `decidePageBatch` clones the state (`structuredClone` — `decide` must
  stay pure for commit's rebase re-runs), then FOLDS each command over the clone: decide cₖ (via the
  same `decidePageCascading`) against the state left by c₀…cₖ₋₁, apply its events to the clone with a
  throwaway envelope (fixed `eventId "batch-fold"`, one `foldNow`) so cₖ₊₁ sees them, accumulate. The
  concatenated events are handed to the SAME **commit** as one array-message — so OCC rebase-retry
  (re-clones + re-folds wholesale on 409), idempotency, snapshot, fan-out, and the single token all
  come for free. A command's rejection throws `BatchCommandError(index, command, cause)` before any
  append (nothing commits). Events are stamped `meta.command = "mutateMany"` (the batch is the audit unit).

**commit(state, rawEvents, meta):**
1. `expectedVersion = state.version`.
2. envelope each rawEvent (assign version expectedVersion+i, eventId, schemaVersion, streamId, meta,
   default pageId). Empty → return result without appending.
3. **Idempotency:** if `commandId` and some event already in `state` history has that commandId →
   short-circuit (return result; do not append). (Track via a Set on the projection.)
4. `await eventLog.append(ws, envelopes, {expectedVersion})`.
   - On `StaleAppendError` → **rebase**: `const {events:tail,nextCursor} = await eventLog.read(ws,
     state.cursor); fold tail into state; update cursor`; then **re-run** the guard+produces against
     fresh state and retry from step 1. Bounded (e.g. 5 tries) → `ConcurrencyError(expected, state.version)`.
5. On success: fold the new envelopes into `state` (advance version + cursor), push to in-memory
   `events[]`, bump `eventsSinceSnapshot`, fan out each event to handle subscribers and `config.onEvent`.
   If `snapshotEvery>0 && eventsSinceSnapshot>=snapshotEvery` → write a snapshot (best-effort).
6. return `result`.

**Per-workspace serialization:** the handle wraps `structural`/`page` calls in a promise-chain mutex
so one process never races itself (DESIGN §15). Implement a tiny `Mutex`/serial queue.

## 4. Cross-page invariants via `ctx.related` (DESIGN §13.4)

`ICommandContext.related` (`IRelatedReader`) gives a `produces` read-only access to sibling/child
pages so gates are enforced atomically. Provide: `page(id) -> DeepReadonly<PageState> | undefined`,
`childrenOf(id|"@root") -> readonly PageId[]`, and `self` (the page being mutated). Build it from the
current `state` (children map + pages map). Used by:
- feature-brief `beginImplementation`: find children of `self`; require the child of type
  `implementation-plan` to have `items.step.length>=1` AND the `testing-plan` child
  `items.case.length>=1`; else `InvariantViolationError("…needs ≥1 plan step and ≥1 test case")`.
- feature-brief `ship`: the `implementation-checklist` child has ALL `items.task` `status==="done"`
  (and ≥1 task), the `testing-plan` child has ALL `items.case` `status==="passed"` (and ≥1 case),
  and the brief itself has zero `open` questions; else `InvariantViolationError` naming what's missing.

## 5. Structure handlers + invariants (`core/structure.ts`, DESIGN §6.2)

Each returns `{ events: DomainEvent[]; result?: unknown }`, pure over `state` + `services`:
- `createPage({type,title,parentId},services,registry)`: registry must know `type` (else
  `InvariantViolationError`/`ValidationError`); parent (if not null) must exist (`ParentNotFoundError`);
  unique sibling title among `childrenOf(parent)` (`DuplicateTitleError`). Generate
  `pageId=`${type}:${newId()}``. Emit `PageCreated` for the page, THEN for each `requiredChildren`
  type a `PageCreated` (pinned:true, parentId=the new page) recursively (required children of required
  children too, if any). Result = the top page id. All in ONE commit (atomic).
- `reparent({pageId,newParentId,position?})`: page exists; newParent exists or null; **no cycle**
  (newParent !== pageId and not a descendant → `CycleError`); pinned pages cannot be reparented out of
  their owner (`InvariantViolationError`). Emit `PageReparented` + `ChildrenReordered` as needed.
- `reorder({parentId,orderedChildIds})`: set must be a permutation of current children → emit
  `ChildrenReordered`.
- `setPageTitle({pageId,title})`: unique among siblings → `PageTitleSet`.
- `archivePage({pageId})`: pinned → `InvariantViolationError`; emit `PageArchived`.
- `link/unlink({from,to,role})`: both endpoints exist (`LinkTargetNotFoundError`); emit
  `LinkAdded`/`LinkRemoved`.
- `moveItem({from,to,itemType,itemId})`: item exists on `from` (`ItemNotFoundError`); emit the item's
  remove+add events targeting the two pages — generic: `<Item>Removed`/`<Item>Added` won't be known
  generically, so emit two GENERIC structural events `ItemMoved` is NOT used; instead emit
  `{type:"ItemRemoved", pageId:from, payload:{itemType,item}}` and `{type:"ItemAdded", pageId:to,
  payload:{itemType,item}}` handled in `applyWorkspace` directly (move the IItemRecord between
  `node.items[itemType]`). Atomic (one commit).
- `archive()`: emit `WorkspaceArchived`.

All structural handlers also reject if `state.status==="archived"` (bus checks first) and if a target
page is archived (except reads).

## 6. Page/item type specs (`src/pages/feature/`, DESIGN §13)

`items.ts` defines item types via `defineItemType`:
- `question` initial `open`, transitions `[t("open","answerQuestion","resolved")]`.
- `task` initial `todo`, `[t("todo","checkTask","done"), t("done","uncheckTask","todo")]`.
- `case` initial `planned`, `[t("planned","markCasePassed","passed"), t("planned","markCaseFailed","failed"),
  t("failed","markCasePassed","passed")]`.
- `component`, `constraint`, `commit`, `step`: no FSM (`defineItemType({type})`).

Page types via `definePageType`. **Items live in `page.items[itemType]`, NOT in `fields`.** `fields`
holds only scalars.

### feature-brief (`feature-brief.ts`) — initial `draft`, requiredChildren
`["implementation-plan","implementation-checklist","testing-plan"]`, fields `{ summary?: string }`,
items `{component,constraint,question,commit}`.
FSM (use `t()`; self-transitions included):
```
draft self:    setSummary, addComponent, removeComponent, addConstraint, removeConstraint, askQuestion, answerQuestion
draft->planning: beginPlanning ;  draft->abandoned: abandon
planning self: addConstraint, removeConstraint, askQuestion, answerQuestion
planning->building: beginImplementation ; planning->abandoned: abandon
building self: addConstraint, askQuestion, answerQuestion, recordCommit
building->planning: reopenPlanning ; building->review: submitForReview ; building->abandoned: abandon
review self:   recordCommit
review->building: requestChanges ; review->shipped: ship ; review->abandoned: abandon
```
Commands → events (payload): setSummary{text}→`SummarySet{text}`; addComponent{name}→
`ComponentAdded{id,name}` (newId), result `{componentId:id}`; removeComponent{componentId}→
`ComponentRemoved{id}`; addConstraint{text}→`ConstraintAdded{id,text}` result `{constraintId}`;
removeConstraint{constraintId}→`ConstraintRemoved{id}`; askQuestion{text}→`QuestionAsked{id,text}`
result `{questionId}`; answerQuestion{questionId,answer} (item-level, idArg `questionId`,
event `answerQuestion`)→`QuestionAnswered{id,answer}` result `{questionId}`; recordCommit{sha,message,url?}→
`CommitRecorded{id,sha,message,url?}` result `{commitId}`; beginPlanning{}→`PlanningBegan{}`;
beginImplementation{} (cross-page gate)→`ImplementationBegan{}`; reopenPlanning{}→`PlanningReopened{}`;
submitForReview{}→`SubmittedForReview{}`; requestChanges{}→`ChangesRequested{}`; ship{} (cross-page gate)→
`Shipped{}`; abandon{}→`Abandoned{}`. `apply` sets page.status on the status events and mutates
items on the content events. answerQuestion sets the matching question's status `resolved` + `answer`.

### implementation-plan (`implementation-plan.ts`) — initial `draft`, fields `{}`, items `{step,question}`
FSM: `draft self: addStep, removeStep, reorderSteps, askQuestion, answerQuestion`; `draft->ready: markReady`.
addStep{text}→`StepAdded{id,text}` result `{stepId}`; removeStep{stepId}→`StepRemoved{id}`;
reorderSteps{orderedStepIds}→`StepsReordered{orderedStepIds}` (apply reorders `items.step`);
askQuestion/answerQuestion as above; markReady{}→`PlanMarkedReady{}` (status→ready).

### implementation-checklist (`implementation-checklist.ts`) — initial `building`, fields `{}`, items `{task}`
FSM: `building self: addTask, checkTask, uncheckTask, removeTask`; `building->complete: markComplete`.
addTask{text}→`TaskAdded{id,text}` result `{taskId}` (task initial `todo`); checkTask{taskId}
(item-level)→`TaskChecked{id}`; uncheckTask{taskId} (item-level)→`TaskUnchecked{id}`;
removeTask{taskId}→`TaskRemoved{id}`; markComplete{}→`ChecklistCompleted{}`.

### testing-plan (`testing-plan.ts`) — initial `draft`, fields `{}`, items `{case}`
FSM: `draft self: addCase, markCasePassed, markCaseFailed`; `draft->ready: markReady`.
addCase{text}→`CaseAdded{id,text}` result `{caseId}` (case initial `planned`); markCasePassed{caseId}
(item-level)→`CasePassed{id}`; markCaseFailed{caseId} (item-level)→`CaseFailed{id}`;
markReady{}→`TestPlanMarkedReady{}`.

`src/pages/feature/index.ts` exports `FeatureBrief, ImplementationPlan, ImplementationChecklist,
TestingPlan` and a convenience `featurePageTypes` array.

## 7. Renderers (`render/markdown.ts` + each page type's `render`, DESIGN §11)

Deterministic: insertion order, fixed headings, `\n` endings, single trailing newline, no wall clock.
`render/determinism.ts` provides helpers: `joinBlocks(blocks: string[])` (single blank line between,
one trailing `\n`), `bullet`, `numbered`, `heading`, `statusBadge`, `placeholder("_None._")`,
`stableBy(arr, keyFn)`. `markdown.ts`: `renderPage(state, registry, ctx)` dispatches to the type's
`render` (fallback: a default structured renderer walking fields + item lists with status badges +
Open/Resolved question split). `renderWorkspace(state, registry)` renders the tree as nested headings
(or a TOC) in `children` order. The feature-brief render matches DESIGN §13.5 closely (headings:
Summary, Components affected, Design constraints, Open questions, Resolved questions, References (from
`ctx.linksOf`), Child pages, Commits).

## 8. Misc modules

- `schema/zod-adapter.ts`: `zodSchema<T>(schema: z.ZodType<T>): ISchema<T>` → `{ parse(input){ const r =
  schema.safeParse(input); if(!r.success) throw new ValidationError(msg, issues from r.error.issues);
  return r.data }, toJsonSchema(){ return zodToJsonSchema(schema) as JsonSchema } }`. Import `z` from
  "zod" and `zodToJsonSchema` from "zod-to-json-schema". Also export `z` re-export for page authors.
- `core/define.ts`: `definePageType(def) => ({__def:def})`, `defineItemType(def) => ({__def:def})`.
  Validate basic shape (type present). Re-export `t` from guard for authors.
- `core/registry.ts`: `Registry` built from `IWikiConfig.pageTypes`. `page(type)` → def (or throws
  `UnknownPageTypeError`), `has(type)`, `item(pageType,itemType)`/`itemType(tag)` resolution (gather
  item types from page defs), `fingerprint()` (stable string of `type@version` pairs for snapshots),
  `pageGuard(type)` / `itemGuard(itemType)` (memoized `makeGuard`). Collect item types declared across
  page defs.
- `core/snapshot.ts`: `serializeState(state)`/`deserializeState(ser)` (Maps↔arrays), `writeSnapshot(
  eventLog, ws, state, cursor, fingerprint)`, `loadSnapshot(eventLog, ws, fingerprint)` (returns
  `{state,cursor,version}` or undefined if missing/fingerprint-mismatch), `foldFromSnapshot(...)` for
  the round-trip test. (Default `openWorkspace` may fold from zero for correctness of `history()`;
  snapshot machinery still implemented + unit-tested.)
- `core/wiki.ts`: `createWiki(config): IWiki`. Builds Registry, Services (clock default
  `()=>new Date().toISOString()`, ids default a monotonic ULID-ish generator — OK to use Date/random
  HERE in the default factory, NOT in reducers/renderers; tests inject deterministic ones). Implements
  `IWiki` (create/open/list/close) and the concrete `IWorkspaceHandle` + `IPageView` (over a
  `ProjectionEntry` + `CommandBus`). `createWorkspace`: ensure stream, commit `WorkspaceCreated`,
  append catalog `WorkspaceRegistered`. `openWorkspace`: if `!exists` → `WorkspaceNotFoundError`; read
  full stream, `foldWorkspace` (→ `UnknownPageTypeError` if needed), keep full `events[]`, start a live
  tail to fold external events + fan out to subscribers. `listWorkspaces`: fold the catalog.
  `handle.subscribe` adds to the projection subscriber set. `page(id)` returns an `IPageView` bound to
  the projection. `toMarkdown(pageId?)` delegates to render module.
- `src/index.ts`: re-export the PUBLIC surface per DESIGN §10.7 — `createWiki`; all `I*` interfaces +
  data types + branded ids from `api`; `definePageType, defineItemType` from `define`; `t, makeGuard,
  renderMermaid` from `guard`; all error classes from `errors`; `zodSchema`/`z` from the zod adapter.
- `src/testing.ts`: `startTestServer()` → starts `DurableStreamTestServer({port:0})`, returns
  `{ url, stop }`. `createTestWiki(pageTypes, opts?)` → starts a server + `createWiki` bound to it with
  deterministic injected `clock` (counter → ISO) + `ids` (counter) by default, returns `{ wiki, server,
  stop }`. Import `DurableStreamTestServer` from `@durable-streams/server`.

## 9. Tests (`wiki/test/`, DESIGN §17) — must all pass

- `guard.test.ts`: can/next/available; property: no command legal from a status without a transition.
- `reducer.test.ts`: fold a hand-built event list → expected state; version-gap throws; upcaster runs.
- `structure.test.ts`: reparent cycle rejection, parent-exists, duplicate sibling title, link integrity,
  moveItem atomicity (both events or neither).
- `render.test.ts`: feature-brief render is byte-stable and matches the §13.5 shape; equal state →
  identical output.
- `worked-example.test.ts`: the full §13.3 script via a test wiki (in-memory server): create
  feature-brief → its 3 children appear atomically → fill brief → beginImplementation BLOCKED until
  plan has a step & testing-plan a case → cross-page moveItem of a question → ship BLOCKED until
  checklist done + cases passed + no open questions → final tree + markdown as expected.
- `concurrency.test.ts`: two handles/bus on the same ws; different-page commands both land via rebase;
  same-page conflict (answer same question twice) → second fails `MutationNotAllowedError` after rebase.
- `snapshot.test.ts`: fold-from-zero state deep-equals fold-from-snapshot+tail.
- `llm-shape.test.ts`: `describeMutations()` emits valid JSON Schema objects; `availableMutations()` ⊆
  full command set and matches the §13.6 table per status.

Use `createTestWiki` from `src/testing.ts`. Keep one server per suite (beforeAll/afterAll).
Do not weaken assertions to pass — fix real bugs.
