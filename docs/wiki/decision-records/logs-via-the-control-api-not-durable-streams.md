# ADR: Logs via the control API, not Durable Streams

**Status:** accepted

## Metadata
- **Date:** 2026-06-02
- **Scope:** wiki-cli
- **Legacy ID:** wiki-cli/ADR-C3

## Context
"Streaming logs" must be **global** (local + remote). One option was to publish logs to
a Durable Stream and tail it like domain events.

## Decision
wiki logs consumes an HTTP control API (GET /server/logs history,
?follow=1 SSE tail) rather than a Durable Stream, so it works identically local or remote. The
serving side piggybacks wiki-server's logging interface (logger → stdout + bounded history buffer
+ live subscribers) on a second listener (§7.1).

Why. Logs are ephemeral operational data, categorically different from the event-sourced,
durable domain data in the streams. Putting them in a durable stream would conflate the two planes,
consume retention/disk for transient output, and entangle ops telemetry with the consistency
substrate. The control API keeps the planes cleanly separate.

## Consequences
This is a directed but not-yet-landed wiki-server addition that
narrows that package's "no API surface" charter to allow a minimal operational API; the
authoritative contract must move into wiki-server/DESIGN.md (its own ADR) — this doc states only
the consumed view. Log history is bounded (a ring buffer), not durable — correct for telemetry.
Health/info ride the same listener, resolving the earlier "no health endpoint" gap
(wiki-server/DESIGN.md §8.4).

## Relations
_None._
