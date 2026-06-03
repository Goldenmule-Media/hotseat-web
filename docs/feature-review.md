# Feature-development review — feedback log

> Status: **Living log** · started 2026-06-03 · Owner: @benjamin
>
> Feedback collected while **using the wiki to develop real features** (dogfooding). Each item is an
> observed gap or rough edge, plus a proposed direction — captured so it isn't lost, triaged and
> implemented as we go. Nothing here is implemented unless its **Status** says so. Append new items
> at the bottom; keep the structure (Observed / Diagnosis / Proposal / Enforcement / Open / Status).

---

## Item 1 — A resolved brief goes stale; consolidate into a clean spec

**Status:** proposed (not implemented). Surfaced while authoring the `wiki-ui` feature-brief
(`ws:mpyhhr26… / feature-brief:mpyhhttg-0003-kt3dan`).

### Observed
Once all of a brief's questions are answered, the **decisions live only in the resolved Q&A**, and the
brief's structured prose (`summary`, `constraints`) is never reconciled with them — so the brief
becomes internally inconsistent. Concretely, on the `wiki-ui` brief:
- `summary` still says the UI "streams updates to the client" from "the browser/server boundary," and
  constraint #6 still frames **"server vs client"** as an *open* decision —
- but the resolved questions decided **client-side engine, no server→browser transport, direct stream
  subscription, multi-workspace, standalone Next app.**

A reader of the top of the brief gets a stale, contradicted picture.

### Diagnosis
The instinct is "rewrite the brief top-down with the answers threaded in" — but **rewriting prose is
the one thing this system is built to resist** (no `setBody(markdown)`; you mutate typed fields). And
the engine has no way to know whether a rewritten summary actually reflects the answers. The key
constraint: **the system can enforce *structure*, never *semantic consistency*.** That distinction
drives the whole solution.

### Proposal — a clean, question-free design/spec subpage
Keep the **brief as the deliberation record** (the working doc; questions are its first-class mechanism
for open issues). Add a **`design`/`spec` page** that is the **decided source of truth**: a
question-free, document-style page authored *from* the decisions.

This is the natural home for the **`blocks` document model + inline `ref`** — currently built but
unused by any page type — so it's also the missing dogfood: flowing prose + the data-model code blocks
+ inline references to the decisions.

Roles must be explicit, or the staleness just moves: brief = "why/what + how we deliberated"; spec =
"the current design." The event log preserves history, so the brief needn't be the live truth — it's
the trail. Optionally stamp the brief with a `superseded-by → spec` ref.

### Enforcement — three structural gates (strongest last)
1. **Exists + filled** — the spec is a required child (like the plan); a precondition blocks
   `beginImplementation` until its sections are non-empty.
2. **Resolved-before-consolidate** — the spec can't be sealed while the brief has open questions.
3. **Reference-completeness (the one that actually fits this system)** — require the spec to contain an
   inline `ref` to *every* resolved question (and optionally every component/constraint). The engine
   checks this structurally: walk the spec's blocks, collect `ref` targets, diff against the brief's
   decision set, fail the gate if any decision isn't referenced. It can't verify the prose is *right*,
   but it guarantees **no decision was silently dropped** — the enforceable core of "threaded in," and
   exactly the static-analysis-over-structure this project is about. (It's why inline `ref` earns its
   keep.)

### Open questions
- **New sibling page vs fold into the plan.** A separate `design`/`spec` page (narrative + data models
  + decisions, no questions), or a required `blocks` section on the existing `implementation-plan`
  (which already holds the data-model code blocks and the "how")? Real overlap: "decided design" vs
  "plan of attack." *Lean: separate page; keep `implementation-plan` for ordered steps/work.*
- **Lifecycle.** Materialize the spec empty at `beginPlanning`, gate it full (with the
  reference-completeness check) at `beginImplementation`?
- **Brief role after consolidation.** Freeze/mark the brief superseded, or leave it editable as the
  living deliberation record?

---

## Item 2 — You can enter `building` with an empty checklist; the gate is at the wrong end

**Status:** proposed (not implemented). Surfaced when the `wiki-ui` brief reached `building` with a
**zero-task** implementation-checklist, and the agent framed "populate the checklist *or* start
building" as the next choice.

### Observed
The brief is in `building` but its `implementation-checklist` has no tasks. The FSM let
`beginImplementation` through without any checklist content, and nothing stops the agent from writing
code against an empty, untracked checklist.

### Diagnosis
The FSM gates **transitions on invariants, not the order of work within a status.**
- `beginImplementation` is gated on the **plan** (≥1 step + ≥1 data-model code block) and the
  **testing-plan** (≥1 case) — **not** on the checklist.
- The checklist is enforced only at **`ship`** (`checklistComplete` = ≥1 task *and* all done).

So you can sit in `building` with an empty checklist; the only protection is "can't ship incomplete."
By the original "plan-as-you-build" intent that's deliberate (the checklist page even *starts* in
`building`, to be filled + completed during the phase) — but it has two smells:
1. **Gate at the wrong end.** The checklist gives zero structure *during* the build, exactly when a
   tracked breakdown is most useful; it only bites at the finish line.
2. **`plan.steps` ≈ `checklist.tasks`.** The agent proposed "one task per plan step" — manual
   duplication. Plan steps are the breakdown; checklist tasks are the breakdown *with done-tracking*.

The "branch" that looked wrong is really two things: the genuine FSM branch out of `building`
(`submitForReview` / `reopenPlanning` / `recordCommit` / `abandon`), and a *workflow* choice the agent
offered (add tasks vs write code) that the FSM doesn't order at all.

### Proposal — **Recommended: auto-seed the checklist from the plan steps at `beginImplementation`**
Materialize one `task` per `step` when the brief enters `building` (the way required children are
auto-materialized atomically). Effect: you can never enter `building` with an empty checklist, the
duplication becomes automatic instead of manual, and the checklist is meaningful from step one. This
is a **cross-page effect** (the brief's command writes tasks onto the sibling checklist), so it's more
than a precondition — but the atomic cross-page `moveItem` precedent shows it's doable.

**Lighter alternative** (if cross-page seeding is too much for now): a `checklistHasTasks`
precondition on `beginImplementation` — trivial (reads the sibling checklist, like `planHasStep`),
forces manual population first, but keeps the duplication.

### Open questions
- **Reconcile the redundancy, not just the gate.** Should the checklist *derive from* the plan steps
  — one canonical breakdown, where the checklist is "the plan steps + done-status" — rather than two
  near-identical lists? That's the deeper fix; auto-seed is a halfway point.
- **Drift after seeding.** If tasks are seeded from steps at `beginImplementation`, what happens when
  plan steps change mid-build — one-time snapshot, or re-sync?
- **Mechanics.** Cross-page seeding needs a section op that can target another page (today a
  `SectionOp` addresses a section/field on the command's *own* page; `moveItem` is a dedicated
  structural command). Decide: extend the op vocabulary with a page target, or add a dedicated
  structural command.
