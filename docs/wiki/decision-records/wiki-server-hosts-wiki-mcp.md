# ADR-22: wiki-server hosts wiki-mcp

**Status:** accepted

## Metadata
- **Date:** 2026-06-02
- **Scope:** wiki-server

## Context
A stateless consumer re-folds history per call (a non-starter); the long-lived **`wiki-mcp`**
module (engine kept hydrated + SQL read model + MCP server, [wiki-mcp/DESIGN.md](../wiki-mcp/DESIGN.md))
replaces it. Where does it run?

## Decision
wiki-server hosts wiki-mcp in the same process — one deployable runs the durable
stream host and wiki-mcp. There are no modes. wiki-server stays a thin wiring layer: it
boots the stream host, then starts wiki-mcp (handing it the localhost baseUrl/namespace + the
read-model DB config); the projection tailer reads localhost streams. All engine/read-model/MCP logic
lives in wiki-mcp, never in wiki-server.

## Consequences
This softens G1/G2: wiki-server now
transitively depends on the engine (via wiki-mcp), so it is no longer "imports nothing but
@durable-streams/server," and the backend (engine + read model + MCP) no longer versions
independently of the host — they ship together (§8.4). Preserved discipline:
wiki-server imports wiki-mcp (not wiki directly) and implements no engine logic of its own;
and the stream-host/storage layer remains a swappable, content-agnostic substrate (server-side-only
swap to the production tier, ADR-S2 /
§8.3). The host knowing it has an engine is fine; owning the logic is not.

## Relations
- **Supersedes** → [Host streams; do not wrap the engine](decision-record:mq110u5y-006o-qf3uxh)
