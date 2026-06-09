# ADR-19: AST/analysis as read-side projections + a runtime LanguageRegistry

**Status:** accepted

## Metadata
- **Date:** 2026-06-03
- **Scope:** wiki-mcp

## Context
The section content model makes structure first-class and code first-class (a code field, and a code block with a blockId), so the host can offer deterministic, language-aware tooling: an outline, a symbol index, a cross-reference index, and eventually semantic refactors (rename, extract). That tooling needs parsers (tree-sitter / Roslyn / LSP) — heavy, version-sensitive, and language-specific. The engine is, by tenet, schema-agnostic, dependency-free, and deterministic: it must own neither a parser nor an AST.

## Decision
ASTs and all static analysis are read-side projections in this host, and parsers load at
runtime through a LanguageRegistry — never in wiki.
Concretely:

- The engine stores canonical text + a content hash only; the AST is derived by parsing that source
  inside a projection here, exactly as the SQL read model serializes folded state. The canonical text stays
  the write-model source of truth; a parser upgrade re-projects and never rewrites history.
- The derived projections — outline (no parser; straight from the folded section tree),
  symbol index (over code fields and code blocks, keyed including blockid), and
  cross-reference index (over ref fields and inline ref-spans, the walk recursing into
  block/inline trees so an inline reference can never dangle undetected) — are co-maintained by the same
  projection tailer, in the same per-commit transaction, advancing the same appliedToken.
- Per-language analyzers expose a narrow ILanguageAnalyzer (parse / symbols / references / rename)
  and load through a LanguageRegistry that
  mirrors the ModelRegistry:
  generation-counted, loaded by module specifier via cache-busted import(), controlled
  pipeline-side (/server/languages, a sibling of /server/models), never an MCP tool. The two
  registries are siblings: a ModelRegistry swap re-folds the write-model-derived read model; a
  LanguageRegistry swap re-projects only the analyzer-derived indexes.
- A semantic operation is still FSM-gated + event-sourced. The host computes the edits (parse + analyze),
  then applies them as one guarded applyTextEdits section operation with a content-hash precondition:
  the pure command rejects edits computed
  against source made stale by an OCC rebase. Even a refactor is one attributed event in history(). The
  analyzer returns edits; it has no write authority, and produces never parses.

Why. It keeps wiki dep-free and deterministic (no parser, no AST in the fold or log)
while putting language machinery exactly where
versioned, replaceable, language-specific code belongs. Reusing the projection tailer means the indexes
inherit token-gating, resume, and atomicity for free; reusing the model-registry hot-reload loader pattern means analyzers
hot-reload with the same proven mechanism. Routing every refactor through applyTextEdits means even
content-rewriting tools are audited, OCC-safe, and rebuildable — not a side channel around the event log.

## Consequences
A new package boundary inside the host: src/lang/ (registry + loader + analyzer
contract) and src/readmodel/derive.ts (the derived projections), both read-side. Analyzer plugins are loaded
arbitrary code (first-party trusted), and cache-busting leaks old analyzer modules until GC — acceptable
for a local/dev loop, the same caveat as the model-registry hot-reload mechanism. The guarantee for semantic ops is scoped (sound for
in-scope lexical references in supported languages within one workspace; dynamic/reflective/cross-workspace
sites are reported, not guessed). Phasing is staged:
read-only outline+symbols first (Phase 2), semantic
operations one language at a time (Phase 3). Until an analyzer for a lang loads, a code field/block is an
opaque canonical blob served verbatim, and the parser-free outline + structural cross-reference index still
work.

## Relations
_None._
