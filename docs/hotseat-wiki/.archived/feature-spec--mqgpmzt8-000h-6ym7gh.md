# Spec — Auto-resolve build-feature's workspace from a repo hotseat.config.json

**Status:** sealed

## Overview
The /build-feature skill no longer requires the wiki workspace id as an argument. Because a repo maps 1:1 to a workspace, the skill resolves the workspace from a committed repo-root hotseat.config.json. Scope is the skill prompt plus a config file and docs — no engine or package code.

## Design
## Workspace resolution

The skill resolves the workspace id once at the start, in precedence order: (1) a leading ws: token in the argument overrides; (2) otherwise the workspaceId in hotseat.config.json at the repo root; (3) otherwise it calls listWorkspaces, confirms with the user, and offers to write the config. It never silently guesses a workspace.

Resolution runs in the model via the Read tool (already in the skill's allowed-tools) reading hotseat.config.json — the skill is a Markdown prompt, so there is no new runtime or engine code. hotseat.config.json is committed, so the binding travels with every clone and parallel worktree.

## Surface

New repo-root hotseat.config.json holding { workspaceId }. SKILL.md drops the workspace positional arg (arguments: [target]) and adds the resolution block; the canonical plugin copy and the .claude project copy are kept byte-identical. READMEs (root, plugin, and both build-feature copies) document the config and the workspace-less invocation. The hotseat plugin is bumped 0.2.0 to 0.3.0 because the skill's invocation contract changed.

```json
{
  "workspaceId": "ws:mpzncs2z-0001-2wgv51"
}
```

## Decisions
Ship hotseat.config.json minimal — workspaceId only, consumed solely by the /build-feature skill. Broadening it into the single repo→workspace binding for other tooling (wiki-mirror's inverse workspaceId→root map, or the MCP server URL currently in .mcp.json) is deferred to a separate feature if/when needed. The minimal form is fully reversible. Should hotseat.config.json stay minimal (just workspaceId, consumed only by the skill), or grow into the single repo→workspace binding also consumed by other tooling (e.g. wiki-mirror's inverse workspaceId→root map, or the MCP server URL now in .mcp.json)? Recommendation: ship minimal now; revisit unification separately. Proceeding with minimal unless you say otherwise.

## References
_None._

## Child pages
_None._
