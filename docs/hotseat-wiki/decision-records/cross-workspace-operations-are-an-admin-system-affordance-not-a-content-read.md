# ADR-30: Cross-workspace operations are an admin/system affordance, not a content read

**Status:** accepted

## Metadata
- **Date:** 2026-06-08
- **Scope:** wiki-mcp
- **Deciders:** Benjamin Jordan

## Context
A workspace is the aggregate and the unit of atomic consistency — one Durable Stream (see "Workspace as the aggregate (one stream)"). A tool that fans out across every workspace couples unrelated aggregates, dissolves that consistency boundary, and taxes routine work: reaching model code generically means opening a per-workspace engine handle (one fold) per workspace scanned. The attention read (surfacing element instances a model flags via awaitsHuman) was first built cross-workspace, inherited from the legacy openQuestions scan — but an agent working a feature operates within a single workspace, so the fan-out bought nothing and cost a per-workspace fold.

## Decision
Default rule: content and agent operations are workspace-scoped. Such a tool takes an explicit workspaceId argument and never fans out across the namespace.

Cross-workspace fan-out is reserved for namespace discovery/catalog only — listWorkspaces — where enumerating every workspace is the whole purpose. Everything else, including full-text content search, is workspace-scoped. Anything that wants to go cross-workspace must justify itself as admin or system, not slip in as a convenience.

Applied here: attention and search both require a workspaceId, and nextActions is subtree-scoped. The only cross-workspace read left is listWorkspaces, the namespace catalog.

## Consequences
Routine reads stay cheap and stay inside one aggregate's consistency boundary — no per-workspace fold or handle churn, and no accidental cross-aggregate coupling.

The workspace boundary stays meaningful as the unit of atomic consistency; read-your-writes and consistency tokens remain per-workspace.

No content read fans out: full-text search is per-workspace alongside attention and nextActions, leaving listWorkspaces as the sole cross-workspace (catalog) read.

## Relations
_None._
