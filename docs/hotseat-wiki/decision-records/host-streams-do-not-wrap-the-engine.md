# ADR-20: Host streams; do not wrap the engine

**Status:** superseded

## Metadata
- **Date:** 2026-06-01
- **Scope:** wiki-server

## Context
The original plan had a `wiki-api/` sibling exposing the engine's command catalog over
HTTP/RPC+SSE. Revisiting "where does the durable stream actually run?" reframed the real need.

**Findings.** The engine is *already* a complete application that talks to storage over HTTP via
`@durable-streams/client`. What's missing for any shared, multi-process setup isn't an API in front
of the engine — it's a **durable server behind it**. You don't wrap the streams; you **run `wiki`
wherever you want and point every instance at the same stream host.**

## Decision
wiki-server/ is that host: a durable deployment of @durable-streams/server. It does
not itself wrap the engine in an HTTP/RPC API. wiki-api/ is removed from the plan (struck from
wiki/DESIGN.md §2/§5/§16/§18). (Later — ADR-S3 —
wiki-server additionally hosts the wiki-mcp module, which embeds the engine and exposes MCP;
hosting a separate module is distinct from wiki-server itself becoming the engine wrapper that
wiki-api would have been.)

## Consequences
The stream-host layer and the engine couple only through the wire protocol — URL
layout, envelopes, OCC stay in the client. The agent-facing surface is wiki-mcp, hosted by
wiki-server (ADR-S3) — superseding the earlier
sketch of wiki-cli as the primary consumer.

## Relations
- **Superseded by** → [wiki-server hosts wiki-mcp](decision-record:mq110v2c-007c-hjq73f)
