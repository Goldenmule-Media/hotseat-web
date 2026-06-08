# FSM guard

**Status:** current

## Kind
subsystem

## Summary
The engine's FSM mechanism — a tiny, zero-dependency pure guard over a declarative transition table (`t(from, event, to)`). `makeGuard` returns `can` / `next` / `available` / `states` / `toMermaid`, answering transition legality and the resulting status for both page-level and element (list-item) FSMs.

## Purpose
Enforces lifecycle legality ("a mutation is legal iff the FSM declares the transition") without hard-coding any lifecycle and without a stateful FSM dependency — the event log, not any `_current` field, is the source of truth for status.

## Design notes
_None._

## Components
_No components._

## Dependencies
_No dependencies._

## Code references
- function `makeGuard` in `wiki/src/core/guard.ts`
- constant `t` in `wiki/src/core/guard.ts`
- interface `ITransition` in `wiki/src/api.ts`

## Data model
Operates over a `readonly ITransition<S, C>[]` (fromState / event / toState + optional `meta.description`); holds no mutable state of its own.

## Usage
The `Registry` memoizes one guard per page type and per element type; the command bus calls `guard.can(…)` to gate transitions, the reducer calls `next(…)` to apply them, and `IPageView.availableMutations` / `describeMutations` derive the offered tool set from `available(…)`.

## Invariants & constraints
- Pure lookups over the table — a command is legal from a status iff a matching transition exists; self-transitions are allowed (content edits that don't change status).
- A computed element (status derived from a rendered flag) may never be hand-driven — the bus rejects any element transition on it.
- The MISSING transition is the safety property — e.g. no transition out of `resolved` makes "answer a question twice" unrepresentable.

## Synced commit
e357aa7
