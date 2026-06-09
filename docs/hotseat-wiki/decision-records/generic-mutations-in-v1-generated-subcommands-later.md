# ADR-29: Generic mutations in v1, generated subcommands later

**Status:** accepted

## Metadata
- **Date:** 2026-06-02
- **Scope:** wiki-cli

## Context
Page mutations can be exposed generically (`mutate <cmd> --json`) or as generated
per-command subcommands with typed flags derived from each command's JSON Schema.

## Decision
v1 ships the generic wiki page <ws> <page> mutate <command> --json '<args>', plus
wiki page <ws> <page> commands (legal-now list) and wiki tools (the full JSON-Schema catalog).
Generated per-command subcommands are future sugar.

Why. The generic path is type-set-agnostic, immediately works for every registered page type, and
is the most agent-friendly (schema in, JSON out) — matching the engine's LLM-first stance. Generated flags are pure ergonomics and can be layered on
without changing the core.

## Consequences
Smaller v1 surface; humans type JSON for now (or use tools to see the shape);
the generated layer is additive when it arrives.

## Relations
_None._
