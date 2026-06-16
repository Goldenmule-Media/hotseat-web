# Feature: Auto-resolve build-feature's workspace from a repo hotseat.config.json

**Status:** shipped

## Summary
The /build-feature skill currently requires the workspace id as its first positional argument, even though a repo maps 1:1 to a wiki workspace. Add a committed, repo-root hotseat.config.json holding that binding ({ "workspaceId": "ws:..." }) and make the skill resolve the workspace from it, so the common invocation is just /build-feature "<intent | feature-brief:id>". Resolution precedence: an explicit ws: token in the args overrides; otherwise read hotseat.config.json; otherwise fall back to listWorkspaces + confirm. Scope is the skill + a new config file + docs — no engine/package code. Because hotseat.config.json is committed, every clone and parallel worktree carries the binding automatically.

## Components affected
- hotseat.config.json (new) — repo-root file holding { workspaceId } (the repo→workspace binding); committed so it travels with every clone/worktree
- plugins/hotseat/skills/build-feature/SKILL.md (canonical) — make the workspace arg optional; add a workspace-resolution block; replace $workspace substitutions with a runtime-resolved id
- .claude/skills/build-feature/SKILL.md (project copy) — apply the identical edits; the two copies must stay byte-identical
- plugins/hotseat/README.md + skills/build-feature/README.md (+ .claude copy) — document hotseat.config.json and the no-workspace-arg invocation
- plugins/hotseat/.claude-plugin/plugin.json — version bump (skill invocation contract changed)

## Design constraints
1. Resolution precedence is explicit ws: arg → hotseat.config.json workspaceId → listWorkspaces + human confirm. Never silently guess a workspace when the config is missing.
2. The skill is a Markdown prompt, not executable code: resolution is done by the model via the Read tool reading hotseat.config.json at the worktree root (Read is already in allowed-tools). No new runtime/engine code.
3. The two SKILL.md copies (plugins canonical + .claude project) must remain byte-identical after the edit — verified by diff.
4. hotseat.config.json.workspaceId must equal the real workspace this repo documents (ws:mpzncs2z-0001-2wgv51).
5. Keep the config minimal (just workspaceId for now). The server URL stays in .mcp.json; do not duplicate it. Broadening the config's role is deferred (see open question).

## Open questions
_None._

## Resolved questions
1. **Should hotseat.config.json stay minimal (just workspaceId, consumed only by the skill), or grow into the single repo→workspace binding also consumed by other tooling (e.g. wiki-mirror's inverse workspaceId→root map, or the MCP server URL now in .mcp.json)? Recommendation: ship minimal now; revisit unification separately. Proceeding with minimal unless you say otherwise.** — _Ship minimal (workspaceId only, consumed by the skill). Broadening hotseat.config.json into the single repo→workspace binding for other tooling (wiki-mirror's inverse map, the MCP server URL) is deferred to a separate feature if/when needed._

## References
_None._

## Child pages
- [Implementation plan — Auto-resolve build-feature's workspace from a repo hotseat.config.json](implementation-plan:mqgpmzt8-000f-wb0wiq)
- [Testing plan — Auto-resolve build-feature's workspace from a repo hotseat.config.json](testing-plan:mqgpmzt8-000g-lld99t)
- [Spec — Auto-resolve build-feature's workspace from a repo hotseat.config.json](feature-spec:mqgpmzt8-000h-6ym7gh)

## Commits
- `706cbbf7325c59e3e7e58530f41fca3455ec4968` feat(build-feature): auto-resolve workspace from a repo hotseat.config.json
- `68d5f09a73c620d4acbbf150bb724f4558f52d8f` docs: update root README quickstart for workspace-less /build-feature
