# Spec

**Status:** sealed

## Overview
The `decision-record` (ADR) page type makes every architecture decision a typed, FSM-governed wiki page — Context / Decision / Consequences, with a status lifecycle and an integrity-checked `supersededBy` link — shipped as a runtime-loaded `wiki-models/adr` bundle. The existing ~27 ADRs, today scattered across five DESIGN.md appendices with colliding labels, migrate into one global "ADRs" workspace. The engine and host stay schema-agnostic; deterministic render keeps a future `docs/adr/` snapshot churn-free.

## Design
## Page type

The decision-record type, labelled ADR, has five sections: a meta block (date, scope, deciders, and the preserved legacy id), context as prose, decision and consequences as blocks so a decision can carry code, and a relations section holding the supersededBy reference. The status FSM is proposed then accepted, with accepted branching to superseded or deprecated and proposed to rejected; the terminal states match how decisions actually end.

```typescript
statusTransitions: [
  t("proposed", "accept",    "accepted"),
  t("proposed", "reject",    "rejected"),
  t("accepted", "supersede", "superseded"), // gated: must name a live successor
  t("accepted", "deprecate", "deprecated"),
]
// sections: meta · context · decision · consequences · relations(supersededBy: ref)
```

## Supersession is an integrity-checked edge

Superseding is the one non-trivial transition. The supersede command sets a supersededBy reference and fires the supersede event in a single atomic commit, gated by a precondition that the reference is present and resolves to a live decision-record. Engine link integrity does the rest: a superseded decision can never point at nothing, and the reverse Supersedes view is derived from incoming references, so the decision graph stays sound with no manual bookkeeping.

## Migration & boundaries

A re-runnable script parses the five DESIGN.md appendices into records in a fresh ADRs workspace, preserving each legacy label, date, and scope and wiring supersedes from the prose. Nothing concrete about ADRs enters the engine or host; the type is one more wiki-models bundle. Generating the docs/adr Markdown snapshot is deferred to the Markdown-to-disk projection; this type's only obligation toward it is deterministic, stable-ordered render.

## Decisions
Type tag decision-record (id prefix decision-record:<id>), human label ADR; the original label is kept as the legacy id field. Type name and id prefix: `adr` (terse prefix `adr:<id>`, but jargon), `decision-record` (self-describing, longer prefix, consistent with `feature-brief`/`implementation-plan`), or `decision`? The id prefix is the type tag, so it shows up in every page id, tree row, and cross-page link.

Status FSM: proposed then accepted; accepted then superseded or deprecated; proposed then rejected. The last three are terminal. Status FSM: what states and transitions model a decision's life? A minimal `proposed → accepted` plus terminal revisions, or something richer? This graph is what the model-inspection view will draw and what gates legal mutations.

Sections follow Nygard — Context, Decision, Consequences — plus meta (date, scope, deciders, legacy id) and relations (supersededBy). Sections and fields: what is the page shape? Stick to Michael Nygard's classic Context / Decision / Consequences, or add more for metadata and relations?

Supersession is a supersededBy reference, set and transitioned atomically and gated on a live target; the engine's link integrity prevents dangling supersession. How is supersession represented and enforced? A free-text "superseded by ADR-x" note (rots, unverifiable), a typed graph `link` with a role (already in the engine, but lives outside the page's fields), or a `ref` field-kind (render-derived, integrity-checked)?

Migration is a re-runnable engine-as-library script over the DESIGN.md appendices; the appendices are removed only once the disk snapshot lands. Migration of the existing ~27 ADRs: hand-author each, or write a parser? And do the DESIGN.md appendices stay after migration?

One global ADRs workspace (a single aggregate) gives global identity and cross-package supersession; package is a scope field, not a separate stream. One ADR workspace, or one per package? A workspace is one stream and one consistency aggregate.

Generating docs/adr Markdown is out of scope here — it is the linked Markdown-projection feature; this type only guarantees deterministic, stable-ordered render. Where does the git-resident `docs/adr/*.md` snapshot come from — is generating it part of this feature, or a separate concern?

Validated against the engine source: setting a top-level ref field is already supported (setField carries a ref value; ingestion enforces existence via RefIntegrityError; architecture already ships a page-ref field), so no new op is needed. The feature folds in only a generic kindFor fix so the set sugar builds a page-ref from an id. Supersession is a two-op atomic batch — setSupersededBy then supersede — where the supersede precondition reads the committed ref and checks it is a live decision-record; two steps because a precondition runs before its own command's ops and receives no args. Validated against the engine source — is setting a top-level `ref` field supported and integrity-checked today, or is an engine change required? And what is the final `supersede` mechanism (refining Q4)?

## References
_None._

## Child pages
_None._
