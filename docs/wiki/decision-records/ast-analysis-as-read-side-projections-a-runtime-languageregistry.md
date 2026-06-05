# ADR: AST/analysis as read-side projections + a runtime LanguageRegistry

**Status:** accepted

## Metadata
- **Date:** 2026-06-03
- **Scope:** wiki-mcp
- **Legacy ID:** wiki-mcp/ADR-M7

## Context
The section content model makes structure first-class
([structured-content §1/§2](../docs/structured-content.md)) and `code` first-class (a `code` field, and a
`code` *block* with a `blockId`, [structured-content §3.1](../docs/structured-content.md)), so the host can
offer deterministic, language-aware tooling: an outline, a symbol index, a cross-reference index, and
eventually semantic refactors (rename, extract). That tooling needs **parsers** (tree-sitter / Roslyn / LSP)
— heavy, version-sensitive, and language-specific. The engine ([`wiki`](../wiki/DESIGN.md)) is, by tenet,
**schema-agnostic, dependency-free, and deterministic** (`CLAUDE.md`, [structured-content §13](../docs/structured-content.md)):
it must own neither a parser nor an AST.

## Decision
ASTs and all static analysis are read-side projections in this host, and parsers load at
runtime through a LanguageRegistry — never in wiki (structured-content §4/§11).
Concretely:

- The engine stores canonical text + a content hash only; the AST is derived by parsing that source
  inside a projection here, exactly as the SQL read model serializes folded state. The canonical text stays
  the write-model source of truth; a parser upgrade re-projects and never rewrites history.
- The §6 derived projections — outline (no parser; straight from the folded section tree),
  symbol index (over code fields and code blocks, keyed including blockid), and
  cross-reference index (over ref fields and inline ref-spans, the walk recursing into
  block/inline trees so an inline reference can never dangle undetected) — are co-maintained by the same
  projection tailer (§5.1), in the same per-commit transaction, advancing the same appliedToken.
- Per-language analyzers expose a narrow ILanguageAnalyzer (parse / symbols / references / rename,
  structured-content §11) and load through a LanguageRegistry that
  mirrors the ModelRegistry (ADR-M6):
  generation-counted, loaded by module specifier via cache-busted import(), controlled
  pipeline-side (/server/languages, a sibling of /server/models), never an MCP tool. The two
  registries are siblings: a ModelRegistry swap re-folds the write-model-derived read model; a
  LanguageRegistry swap re-projects only the analyzer-derived indexes (§7).
- A semantic operation is still FSM-gated + event-sourced. The host computes the edits (parse + analyze),
  then applies them as one guarded applyTextEdits section operation with a content-hash precondition
  (structured-content §5/§9.4): the pure command rejects edits computed
  against source made stale by an OCC rebase. Even a refactor is one attributed event in history(). The
  analyzer returns edits; it has no write authority, and produces never parses.

Why. It keeps wiki dep-free and deterministic (no parser, no AST in the fold or log —
structured-content §10/§13) while putting language machinery exactly where
versioned, replaceable, language-specific code belongs. Reusing the projection tailer means the indexes
inherit token-gating, resume, and atomicity for free; reusing ADR-M6's loader pattern means analyzers
hot-reload with the same proven mechanism. Routing every refactor through applyTextEdits means even
content-rewriting tools are audited, OCC-safe, and rebuildable — not a side channel around the event log.

## Consequences
A new package boundary inside the host: src/lang/ (registry + loader + analyzer
contract) and src/readmodel/derive.ts (the §6 projections), both read-side. Analyzer plugins are loaded
arbitrary code (first-party trusted), and cache-busting leaks old analyzer modules until GC — acceptable
for a local/dev loop, same caveat as ADR-M6. The guarantee for semantic ops is scoped (sound for
in-scope lexical references in supported languages within one workspace; dynamic/reflective/cross-workspace
sites are reported, not guessed — structured-content §5). Phasing follows
structured-content §12: read-only outline+symbols first (Phase 2), semantic
operations one language at a time (Phase 3). Until an analyzer for a lang loads, a code field/block is an
opaque canonical blob served verbatim, and the parser-free outline + structural cross-reference index still
work.

## Relations
_None._
