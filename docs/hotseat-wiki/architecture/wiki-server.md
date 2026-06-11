# wiki-server

**Status:** current

## Kind
package

## Summary
Thin process **wiring** — implements no engine logic. Runs `@durable-streams/server` (the durable stream host) AND hosts `wiki-mcp` in-process, booting three listeners in one process: the **stream host** (`:4437`), a **control listener** (`:4438` — `/_server/health` | `/info` | `/logs` | `/models`), and the embedded **MCP** streamable-HTTP endpoint (`:4439/mcp`).

## Purpose
Be the single runnable process that stands up storage + read model + MCP for local dev and deployment. It owns process lifecycle and configuration (`flags → env → defaults`), wires the embedded wiki-mcp's stream URL to its own co-hosted Durable Streams host, and loads page-type bundles at boot (`--models` / `--models-dir`) or at runtime via the control listener.

## Design notes
_No design notes._

## Components
_No components._

## Dependencies
- **depends-on** → [wiki-mcp](architecture:mpznj4z6-000d-dzkr85) — Hosts wiki-mcp in-process; must NOT import `wiki` directly (only transitively via wiki-mcp).

## Code references
- `wiki-server/src/main.ts`
- `wiki-server/src/control.ts`
- `wiki-server/src/config.ts`

## Data model
Holds no domain state of its own — it composes others': the Durable Streams host owns the append-only event streams (file storage under the data dir), and the embedded wiki-mcp owns the SQL read model. Its own surface is operational: resolved config (`WIKI_SERVER_*`, precedence flags → env → defaults) and the control endpoints (`health` / `info` / `logs` / `models`, the last reporting the loaded bundles + a `generation` counter).

## Usage
`npm run start -w wiki-server` boots all three listeners; file storage defaults to `./.wiki-data`. Loads **no page types by default** — provide them: `--models wiki-models/feature` (or `WIKI_SERVER_MODELS`), or `--models-dir ../wiki-models/src` to load every bundle (id = directory name; `npm start` at the repo root and `start:all` do exactly this). At runtime: `POST /_server/models {id, specifier}` or `GET :4438/_server/models`. Config keys: `WIKI_SERVER_*` (host / port / storage / data-dir / control-port / mcp-port / models / models-dir) plus the resolved embedded `WIKI_MCP_*`.

## Invariants & constraints
- Thin wiring ONLY: implements no engine logic. Imports `@durable-streams/server` + `wiki-mcp`.
- MUST NOT import `wiki` directly — only transitively via wiki-mcp (a load-bearing import boundary).
- Loads no page types by default; the schema must be provided explicitly (`--models` / `--models-dir` / `WIKI_SERVER_MODELS*`).
- Three listeners in one process: stream host `:4437`, control `:4438`, MCP `:4439/mcp`. Config precedence is flags → env → defaults.
- Overrides the embedded wiki-mcp's stream URL to its own co-hosted Durable Streams host.

## Synced commit
e357aa7
