# ADR-2: Use Durable Streams directly; no storage port

**Status:** accepted

## Metadata
- **Date:** 2026-06-01
- **Scope:** wiki

## Context
The first draft wrapped Durable Streams in an `EventStore` port with
`InMemory`/`DurableStreams`/`File` adapters ("test in-memory, swap later").

**Findings.** Durable Streams *is* the storage layer; durability is a **server** setting
(in-memory / file / ACID via `DurableStreamTestServer({ dataDir })` or the Rust server's
`DS_STORAGE__MODE`; production via Caddy / Electric Cloud). `@durable-streams/server` is built
for dev/test/CI/embedding. The client is fetch-based and portable; only the server needs Node.

## Decision
Drop the port and custom adapters. Use Durable Streams directly via one thin
EventLog (events↔messages, version↔offset, OCC). Tests use an in-memory DurableStreamTestServer.

Why this isn't the abstraction we rejected. EventLog is an anti-corruption boundary around
one young (0.2.x) dependency and a real impedance mismatch — not a swappable multi-backend layer.
No interface until a second backend actually exists.

## Consequences
_None._

## Relations
_None._
