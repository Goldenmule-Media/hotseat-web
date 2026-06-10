# Implementation plan

**Status:** ready

## Steps
- [ ] Scaffold `wiki-models/src/adr/adr.ts`: `definePageType({ type: "decision-record", label: "ADR", version: 1, initialStatus: "proposed", … })`, with extensionless `wiki/authoring` imports (match the wiki-models source convention).
- [ ] Engine (generic, schema-agnostic — prerequisite for `setSupersededBy`): add a `ref` case to `kindFor` in `wiki/src/core/command-bus.ts` so the declarative `set:` sugar builds a page-ref from a string id (and passes a structured ref through). Completes `ref` support in `set:` for ALL models; everything else (`setField` carrying a ref, ingestion ref-integrity) already exists. Cover with a `wiki` unit test.
- [ ] Declare sections + fields: `context` (prose), `decision` (blocks), `consequences` (blocks), a `meta` section (`date`/`scope`/`legacyId` scalars + `deciders` list), and a `relations` section with the `supersededBy` ref. `sectionSet: { mode: "closed" }`.
- [ ] Declare the status FSM: `t("proposed","accept","accepted")`, `t("proposed","reject","rejected")`, `t("accepted","supersede","superseded")`, `t("accepted","deprecate","deprecated")`.
- [ ] Declare content commands: `setContext`; `addDecisionBlock`/`addDecisionCode` and `addConsequence` (block ops mirroring feature-spec's `addParagraph`/`addDesignCode`); `setDate`/`setScope`/`setLegacyId`; `addDecider`.
- [ ] Declare lifecycle commands `accept`/`reject`/`deprecate`, plus the two-op supersession (block 2): `setSupersededBy(id)` — a `set: arg()` on the `relations.supersededBy` ref (ingestion checks the target exists at set time) — and `supersede()` — the `accepted→superseded` page transition, gated by a `namesSuccessor` Precondition that reads the now-committed ref and checks it is a live `decision-record`. Callers batch the two for one atomic commit.
- [ ] Render config: a `Status / Date / Scope / Deciders` header line, then Context → Decision → Consequences, then a derived `Relations` block showing `Supersedes` (incoming refs) and `Superseded by` (the outgoing ref). Title `ADR: {title}`.
- [ ] `wiki-models/src/adr/index.ts`: export `{ DecisionRecord }`, `adrPageTypes = [DecisionRecord] as const`, and `export default adrPageTypes` — the array contract the ModelRegistry loader expects (mirrors the `feature`/`architecture` bundles).
- [ ] `wiki-models/scripts/migrate-adrs.ts`: parse the five DESIGN.md ADR appendices → create one `decision-record` per ADR in a fresh "ADRs" workspace via the engine library; set legacy label/date/scope; wire `supersededBy` from the prose; make re-runs idempotent (reset the workspace).
- [ ] Update `wiki-models/DESIGN.md` with an `adr`-bundle section, and author the meta-ADR ("design decisions live in the wiki") as the first migrated record.
- [ ] Verify: `npm run typecheck`; load `--models wiki-models/adr`; create a record and walk `proposed→accepted→superseded` (proving the `supersededBy` gate rejects when the ref is unset AND when it dangles); confirm byte-identical re-render; run the migration against a scratch workspace.

## Data models & interfaces
```typescript
// wiki-models/src/adr/adr.ts — the decision-record (ADR) page type.
import { arg, definePageType, t, z, zodSchema } from "wiki/authoring";

export const DecisionRecord = definePageType({
  type: "decision-record",
  label: "ADR",
  version: 1,
  initialStatus: "proposed",
  statusTransitions: [
    t("proposed", "accept", "accepted"),
    t("proposed", "reject", "rejected"),
    t("accepted", "supersede", "superseded"),   // gated on naming a live successor (see block 2)
    t("accepted", "deprecate", "deprecated"),
  ],
  sections: {
    meta: {
      name: "Metadata", required: true, mutableIn: ["proposed", "accepted"],
      fields: {
        date:     { kind: "scalar", required: true }, // ISO date string — STORED, never new Date()
        scope:    { kind: "scalar" },                 // e.g. "wiki-mcp" — for filtering/grouping
        legacyId: { kind: "scalar" },                 // e.g. "wiki-mcp/ADR-M7" — traceability only
        deciders: { kind: "list", element: "decider" },
      },
    },
    context:      { name: "Context",      required: true, mutableIn: ["proposed", "accepted"], fields: { body: { kind: "prose",  required: true } } },
    decision:     { name: "Decision",     required: true, mutableIn: ["proposed", "accepted"], fields: { body: { kind: "blocks" } } },
    consequences: { name: "Consequences", required: true, mutableIn: ["proposed", "accepted"], fields: { body: { kind: "blocks" } } },
    relations:    { name: "Relations",    required: true, mutableIn: ["accepted"],             fields: { supersededBy: { kind: "ref" } } },
  },
  elements: { decider: { fields: { name: { kind: "scalar", required: true } } } },
  sectionSet: { mode: "closed" },
  commands: { /* see block 2 */ },
  render: {
    title: "ADR: {title}",
    sections: [
      { section: "context",      heading: "Context",      field: "body", as: "block" },
      { section: "decision",     heading: "Decision",     field: "body", as: "blocks", placeholder: "_No decision recorded._" },
      { section: "consequences", heading: "Consequences", field: "body", as: "blocks", placeholder: "_None._" },
      // a derived "Relations" block renders Supersedes (incoming refs) / Superseded by (the outgoing ref)
    ],
  },
});
```

```typescript
// Block 2 — superseding, VALIDATED against the engine. No new op, no special-casing:
//   - setField already carries a whole IField incl {kind:"ref",target}  (api.ts)
//   - the reducer stores it (operations.ts); INGESTION enforces existence:
//     ingestion.ts throws RefIntegrityError when a ref target doesn't resolve
//     (a page-ref resolves iff state.pages.has(id)). The `architecture` bundle
//     already ships a page-ref field (targetKinds:["page"]), so this path is proven.
//
// Superseding is two ops in ONE atomic batch: set the ref (existence-checked by ingestion
// at set time), then transition (type-checked by a precondition that reads the now-committed
// ref). Both gated by relations.mutableIn = ["accepted"]. Two steps — not one set+transition
// command — because a precondition runs BEFORE its command's own ops and receives no args,
// so the "is a decision-record" check needs the ref already committed.

const namesSuccessor: Precondition = (page, related) => {
  const f = page.sections.find((s) => s.key === "relations")?.fields["supersededBy"];
  const target = f?.kind === "ref" ? f.target : undefined;
  if (target === undefined || target.kind !== "page")
    return { unmet: "set supersededBy (the ADR that replaces this one) before superseding" };
  const succ = related.page(target.id);
  if (succ === undefined)               return { unmet: "supersededBy must point at an existing decision-record" };
  if (succ.type !== "decision-record")  return { unmet: "supersededBy must point at a decision-record" };
  return true;
};

// commands:
setSupersededBy: {                                  // sets the ref; ingestion checks existence
  args: zodSchema(z.object({ supersededBy: z.string() })),
  target: { section: "relations", field: "supersededBy" },
  set: { supersededBy: arg("supersededBy") },        // string id -> {kind:"ref",target:{kind:"page",id}} (uses block 3)
},
supersede: {                                        // accepted -> superseded, once a live successor is named
  args: zodSchema(z.object({})),
  transition: { level: "page", event: "supersede" },
  preconditions: [namesSuccessor],
},
// accept / reject / deprecate stay plain page transitions (empty args).
// Caller: mutatePageBatch([{setSupersededBy,{supersededBy:id}}, {supersede,{}}]) -> one atomic commit.
```

```typescript
// Block 3 — the ONE generic, schema-agnostic engine change this feature folds in.
// wiki/src/core/command-bus.ts :: kindFor() turns a `set: arg()` value into an IField by the
// field's declared kind. Today it handles scalar/prose/code and DEFAULTS everything else to
// prose — so `set: { supersededBy: arg("id") }` on a ref field would store PROSE. Add a `ref`
// case so refs are first-class in the `set:` sugar for ALL models (no ADR knowledge in engine):
case "ref": {
  // an already-structured ref value passes through; a bare string = a page-ref id.
  if (raw !== null && typeof raw === "object" && "kind" in (raw as object)) {
    return raw as IField;                  // {kind:"ref",target:{...}} — any RefTarget kind
  }
  return { kind: "ref", target: { kind: "page", id: String(raw) as PageId } };
}
// scalar/prose/code cases and the prose default are unchanged. Cross-page element/section/
// symbol refs still pass a structured value; only the common page-ref gets string sugar.
```

## Open questions
_None._

## Resolved questions
_None._

## References
_None._

## Child pages
_None._
