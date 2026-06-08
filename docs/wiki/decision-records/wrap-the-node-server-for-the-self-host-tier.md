# ADR-21: Wrap the Node server for the self-host tier

**Status:** accepted

## Metadata
- **Date:** 2026-06-01
- **Scope:** wiki-server

## Context
Which server does `wiki-server` run? `@durable-streams/server`'s own README scopes it to
"development, testing, and prototyping" and recommends the **Caddy plugin / Electric Cloud / Caddy
standalone binary** for production; [wiki/DESIGN.md ADR-001](../wiki/DESIGN.md) echoes the dev/test/
embedding framing. The Node package also offers only **in-memory and file-backed** storage — no
ACID/redb, no request middleware.

## Decision
v1 wiki-server wraps DurableStreamTestServer with file-backed storage as a
simple, durable self-host, with a bin, config, and a container. Default storage is file;
memory is the dev switch. Auth/TLS are delegated to a reverse proxy (§9), since
the server has no middleware. ACID and managed operation are reached by swapping to the production
tier — a server-side-only change (clients keep their baseUrl, §8.3).

Why this is acceptable despite the upstream framing. At the engine's gentle target scale, a
file-backed node that fsyncs every append before ack is genuinely durable and far simpler than
standing up Caddy. We treat the production tier as a drop-in upgrade rather than a prerequisite, and
we do not overclaim: there is no ACID tier in this package, and durability/ops guarantees are
those of file-backed LMDB + append-only logs, nothing more.

## Consequences
Right-sized for this scale, not a ceiling; monotonic disk growth until compaction
lands (§7.2); security depends on the proxy being present whenever the
host is exposed (§9).

## Relations
_None._
