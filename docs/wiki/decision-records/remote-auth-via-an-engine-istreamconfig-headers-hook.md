# ADR: Remote auth via an engine `IStreamConfig.headers` hook

**Status:** accepted

## Metadata
- **Date:** 2026-06-02
- **Scope:** wiki-cli
- **Legacy ID:** wiki-cli/ADR-C4

## Context
Authed remote servers expect `Authorization: Bearer <token>`. The control-API seam can
send it directly, but the engine's stream traffic can't yet — `IStreamConfig` carries no headers,
though `@durable-streams/client` accepts `headers`/`fetch`.

## Decision
Add an optional IStreamConfig.headers (static map or () => headers for refresh)
that EventLog forwards to the client at every call-site it uses — DurableStream.create,
stream(...), and DurableStream.head (the handle's append inherits the create-time headers).
Threading it to only one site leaves reads or existence-checks unauthenticated → 401. wiki-cli
populates it from the profile token (from tokenenv/--token/WIKITOKEN, never the config file).

Alternative / fallback. If touching the engine is undesirable now, defer remote-auth: v1
targets only unauthenticated or network-ACL'd servers, and authed remote profiles land once the hook
exists. (A CLI-side global fetch wrapper was rejected — it can't reliably intercept every engine
code path.)

## Consequences
One tiny, well-supported engine change unlocks authed remote profiles for both
seams; the dynamic-headers form leaves room for SSO/refresh later.

## Relations
_None._
