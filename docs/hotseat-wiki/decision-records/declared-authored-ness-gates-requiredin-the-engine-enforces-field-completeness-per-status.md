# ADR-31: Declared authored-ness gates (`requiredIn`): the engine enforces field completeness per status

**Status:** accepted

## Metadata
- **Date:** 2026-06-11
- **Scope:** wiki
- **Deciders:** Ben

## Context
The first type needing "required on creation" semantics (bug-report) had to hand-roll a completeness precondition: hard-coded field names, manual non-emptiness checks, and a hand-built unmet message — duplicating the section declarations it sat next to. The engine's required flag on a FieldDecl only guarantees the field is PRESENT in the materialized set (required sections materialize their fields EMPTY at create), never that it carries content, and nothing connected field declarations to FSM gates. Every future type with create-required fields would either copy the pattern (drifting as fields are added or renamed) or ship without a gate and accumulate permanently-empty draft pages. A code review flagged the gap as load-bearing.

## Decision
Add requiredIn (a status list) to FieldDecl — the dual of a section's mutableIn. mutableIn gates writes BY status; requiredIn declares the statuses in which a field's content must HOLD. The engine enforces it at one choke point — validatePage on the write-side dry-run post-state, which now reflects the post-fold STATUS — so a transition INTO a listed status rejects while any such field is unauthored, and a write that would BLANK one while in a listed status rejects too, uniformly across declarative commands, generated structural commands, batches, and cascadeFinalize. Authored-ness is defined per kind: scalar, prose, and code non-empty; blocks and list non-empty; ref set; serial and attachment-ref always. describeMutations surfaces the gate predictively on page-transition edges (available false, plus an unmet reason naming the missing section.field paths), so nextActions keeps steering the self-direction loop with no model code. Load-time lints reject requiredIn naming an unknown or unreachable status, the INITIAL status (pages are born empty — an unsatisfiable gate), or an element field (no page status to gate on).

## Consequences
Models declare WHICH fields matter per status and never hand-roll completeness preconditions; the field list lives on the field decls themselves, so it cannot drift from the schema. bug-report's reportComplete precondition was deleted in the same change — and the declared gate is STRONGER: the hand-rolled version checked only the open transition, while requiredIn also rejects blanking a gated field after opening. Validation runs only on the write-side dry-run, so committed history is never re-judged. The gate composes with (and runs before) model preconditions in describeMutations; the required flag keeps its narrower presence-only meaning.

## Relations
_None._
