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

Cross-workspace fan-out is reserved for admin/system affordances — namespace discovery/catalog (listWorkspaces) and global search (search), where enumerating every workspace is the purpose. Anything else that wants to go cross-workspace must justify itself as admin or system, not slip in as a convenience.

Applied here: attention now requires a workspaceId (single workspace), and nextActions is already subtree-scoped — so the per-workspace handle fan-out is gone for routine self-direction reads.

## Consequences
Routine reads stay cheap and stay inside one aggregate's consistency boundary — no per-workspace fold or handle churn, and no accidental cross-aggregate coupling.

The workspace boundary stays meaningful as the unit of atomic consistency; read-your-writes and consistency tokens remain per-workspace.

Audit item: search is cross-workspace today, classified here as a system/discovery affordance. If content search should default to a single workspace, that is a separate, deliberate change under this rule.

## Relations
_None._
