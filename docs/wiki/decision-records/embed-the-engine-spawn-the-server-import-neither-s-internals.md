# ADR-25: Embed the engine; spawn the server; import neither's internals

**Status:** accepted

## Metadata
- **Date:** 2026-06-02
- **Scope:** wiki-cli

## Context
`wiki-cli` needs the engine's behavior and must reach (and sometimes operate) a
`wiki-server`.

## Decision
Depend on wiki as a library (call createWiki and its interfaces). Treat
wiki-server as a binary to spawn and an HTTP control API to call — never a code import. The CLI
holds no domain state and reimplements no rules.

## Consequences
Two narrow, honest seams; each package versions independently. The CLI is stateless
per invocation, so concurrent users collaborate through the server's stream with the engine's OCC.
Mirrors the existing boundaries (wiki-server imports neither the engine nor the CLI).

## Relations
_None._
