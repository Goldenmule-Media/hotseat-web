# ADR-16: The MCP server manages tokens for automatic read-your-writes

**Status:** accepted

## Metadata
- **Date:** 2026-06-02
- **Scope:** wiki-mcp

## Context
_No context yet._

## Decision
The MCP server keeps a per-session high-water token per workspace: write tools record the
token the engine returns; read tools/resources pass it as consistentWith automatically. Agents get
session read-your-writes + monotonic reads without handling tokens; the token is also returned in write
results for clients that want to thread it.

Why. It places the token bookkeeping at exactly the layer that has session context, keeping the engine
contract minimal and the agent experience "just works." Distinct sessions stay independent; the model stays
eventually consistent underneath.

## Consequences
waitFor timeouts become retryable MCP errors (or a stale: true result); sessions are
the unit of consistency.

## Relations
_None._
