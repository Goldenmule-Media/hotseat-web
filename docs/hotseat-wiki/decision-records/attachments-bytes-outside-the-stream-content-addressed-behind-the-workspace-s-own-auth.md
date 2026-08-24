# Attachments: bytes outside the stream, content-addressed behind the workspace's own auth

**Status:** proposed

## Metadata
- **Number:** ADR-36
- **Date:** 2026-08-19
- **Scope:** wiki-server

## Context
Pages needed to carry images, and later any file. The event stream is the wrong place for bytes: it is append-only and folded on every read, so binary in it would bloat every fold, every snapshot and every mirror tail forever. The stream host has no blob concept and buffers whole request bodies into memory with no size cap, so pushing binary through it as a one-message octet-stream was not viable either. The content model already declared the answer without ever building it, since attachment-ref has sat in ADR-6's closed field-kind vocabulary from the start, described as a content-addressed pointer to bytes in an external store, and used by zero page types.

## Decision
Binary NEVER enters the event stream. A workspace's events reference bytes by a stable id and nothing else, and upload and download are separate HTTP operations against a store wiki-server owns.

The id is the sha256 of the content. That makes an upload idempotent, a blob immutable, identical bytes one blob on every machine, and a cached copy safe to trust forever. It also means the stored filename is only a DEFAULT: identical bytes uploaded twice are one blob and the first name wins, so the name a reader should see belongs to the REFERENCE, an attachment-ref's name or an image block's alt.

The store is file-type-agnostic. It records mime, name and size and inspects none of them, so a PDF or an audio clip works exactly as an image does; the only gates are a size ceiling and a mime allowlist, both configuration rather than code.

Blobs are served at `/{ns}/workspace/{id}/blobs`. That path shape is load-bearing, not cosmetic: it is the one shape the auth gateway's deny-by-default allowlist already gates on workspace membership, so blob access IS workspace access rather than a second policy that could drift from it.

The public port becomes a FRONT DOOR in every auth mode. The stream host cannot be extended without patching the vendored package, so anything served alongside streams must be intercepted in front of it. The host now always binds an internal loopback port and a front door always owns the configured address: the auth gateway under GitHub auth, a plain proxying listener otherwise. Without this, attachments would be reachable in production and missing in local development.

Two carriers reference a blob, and there is deliberately no third. An `image` block places one inline inside a blocks field. An `attachment-ref` field hangs any file off a section or element field and renders as a link, which is what a PDF wants. Both put the same `attachment:<sha256>` string in their ref, so every consumer resolves refs with one carrier-blind pass.

## Consequences
wiki-server gains a blob store under its data directory, beside the stream segments, which persists in the same volume with no deployment change. wiki gains an isomorphic `wiki/attachments` client, usable from both Node and the browser, sharing the stream config's headers seam so a refreshing token works unchanged.

The renderer stays pure: it emits the ref verbatim and each consumer resolves it. wiki-mirror downloads referenced blobs into an assets directory beside the tree and rewrites refs to relative paths, so images render on GitHub. wiki-ui fetches them with the bearer and swaps in object URLs, because a plain img element cannot send an Authorization header and a cookie is unavailable across origins.

Attachment refs are not integrity-checked and orphaned blobs are not collected. Ingestion is synchronous and pure, so an existence check would need I/O; and sweeping orphans needs a cross-workspace reference scan. Blobs are deduplicated and cheap, so a maintenance command can come later if it is ever wanted.

## Relations
_None._
