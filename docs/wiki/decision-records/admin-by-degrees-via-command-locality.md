# ADR: Admin "by degrees" via command locality

**Status:** accepted

## Metadata
- **Date:** 2026-06-02
- **Scope:** wiki-cli
- **Legacy ID:** wiki-cli/ADR-C2

## Context
Some admin actions are inherently local (process control); others should work against
any server (observability).

## Decision
Tag every command data / global-admin / local-admin and gate it on the
active profile: local-admin requires a manage block (co-location); global-admin uses the
control API and works local or remote; data needs only a reachable streams origin. Out-of-scope
invocations fail fast with a directing message (exit 8).

## Consequences
"Stream logs from anywhere, manage the process only where it runs" becomes a
first-class, predictable rule rather than per-command surprise.

## Relations
_None._
