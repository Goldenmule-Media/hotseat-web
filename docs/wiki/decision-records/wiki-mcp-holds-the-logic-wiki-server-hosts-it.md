# ADR-17: wiki-mcp holds the logic; wiki-server hosts it

**Status:** accepted

## Metadata
- **Date:** 2026-06-02
- **Scope:** wiki-mcp

## Context
Where does the engine live, and how thin should `wiki-server` stay?

## Decision
wiki-mcp is the module that holds the wiki engine and all read-side logic (projection,
SQL read model, token management, MCP surface). wiki-server hosts streams and hosts wiki-mcp — a thin
wiring layer that delegates and does not implement engine logic itself. There are no deployment "modes": one
process hosts both.

Why. A single home for the engine + read model + MCP behavior (testable, replaceable) while wiki-server
stays small and comprehensible. The host knowing it has an engine is fine; owning the logic is not.

## Consequences
wiki-server now transitively depends on the engine — a deliberate, accepted relaxation of
its original "imports neither wiki nor anything" stance (wiki-server/DESIGN.md §1/§2),
which must be amended to record that it hosts wiki-mcp. wiki-mcp still imports only the engine (library)
+ the stream client — never wiki-server code.

## Relations
_None._
