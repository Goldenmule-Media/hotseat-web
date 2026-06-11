# hotseat — Claude Code plugin

Ships the **`build-feature`** skill (FSM-gated feature builds driven by the structured wiki)
plus the **`wiki` MCP server config** it depends on, so installing this plugin gives any repo
both in one step. The skill is namespaced as `hotseat:build-feature`; invoke it as
`/build-feature` (or `/hotseat:build-feature` if another skill shadows the short name).

## Install

The `hotseat-web` repo is its own marketplace (`.claude-plugin/marketplace.json` at the repo
root). From any Claude Code session:

```
/plugin marketplace add Goldenmule-Media/hotseat-web     # or a local path to a checkout
/plugin install hotseat@hotseat
```

To test changes before pushing: `/plugin marketplace add /path/to/hotseat-web`, then install,
then `/plugin marketplace update hotseat` after edits.

Discovery: the `feature` model bundle declares this plugin (a `skills` export in
`wiki-models/src/feature/index.ts`), so a running server reports the skill and the exact
install commands above — the `listModelSkills` MCP tool, or `GET :4438/_server/models`.

## Prerequisites (per machine)

The skill talks to a running `wiki-server`; the plugin only carries the client wiring.

1. A `wiki-server` running with the `feature` model loaded — from a `hotseat-web` checkout:
   `npm start` (or `npm run start -w wiki-server -- --models wiki-models/feature`).
2. The MCP endpoint defaults to `http://127.0.0.1:4439/mcp`; override with the
   `WIKI_MCP_URL` env var if your server lives elsewhere.
3. If the target repo should mirror wiki Markdown to disk, run the `wiki-mirror` process with a
   local `wiki-mirror.config.json` mapping the workspace to a root — the plugin does not do this for you.

## Contents

- `skills/build-feature/` — the skill (spine + `workflows/` fan-out templates). See its
  [README](skills/build-feature/README.md) for design and usage.
- `.mcp.json` — the `wiki` MCP server entry (HTTP, `WIKI_MCP_URL`-overridable).

## Source of truth

The canonical copy of the skill lives here. `hotseat-web`'s own `.claude/skills/build-feature/`
is the same skill loaded as a project skill for work inside this repo — keep the two in sync
when editing (or delete the project copy and install the plugin here too).
