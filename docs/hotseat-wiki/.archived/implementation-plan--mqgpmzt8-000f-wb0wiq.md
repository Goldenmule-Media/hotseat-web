# Implementation plan — Auto-resolve build-feature's workspace from a repo hotseat.config.json

**Status:** ready

## Steps
- [x] Add hotseat.config.json at the repo root with { "workspaceId": "ws:mpzncs2z-0001-2wgv51" } (and a short header comment is not possible in JSON — document the key in READMEs instead). Commit it so it travels with every clone/worktree.
- [x] Edit canonical SKILL.md (plugins/hotseat/skills/build-feature/SKILL.md): change frontmatter to arguments: [target] and argument-hint to '[feature-brief:id | "one-line intent"]  (workspace auto-resolved from hotseat.config.json; pass a leading ws: token to override)'. Keep Read in allowed-tools.
- [x] In that SKILL.md, rewrite the Inputs 'Workspace' bullet into a resolution block: resolve the workspace id once at start — precedence (1) a leading ws: token in $target overrides, (2) Read hotseat.config.json at the worktree root and use workspaceId, (3) listWorkspaces + confirm with the user (and offer to write hotseat.config.json). Call the resolved value $WS.
- [x] In that SKILL.md, replace every $workspace substitution (nextActions/tree/createPage/etc.) with the runtime-resolved $WS, and adjust the Target bullet so a leading ws: override token is stripped from the intent.
- [x] Copy the edited canonical SKILL.md verbatim to .claude/skills/build-feature/SKILL.md so the two stay byte-identical (verify with diff).
- [x] Update docs: plugins/hotseat/README.md (document hotseat.config.json + the no-arg invocation), plugins/hotseat/skills/build-feature/README.md, and the .claude/skills/build-feature/README.md copy (keep READMEs in sync).
- [x] Bump plugins/hotseat/.claude-plugin/plugin.json version 0.2.0 → 0.3.0 (the skill's invocation contract changed).
- [x] Verify: hotseat.config.json parses and workspaceId matches; both SKILL.md copies diff-clean; npm run typecheck && npm run test still green (no code touched).
- [x] Also update the repo root README.md — its 'Build a feature' quickstart still showed the old two-arg invocation (caught by /code-review). Switch to the no-workspace-arg form and point at hotseat.config.json.

## Data models & interfaces
```json
// hotseat.config.json (repo root, committed)
{
  "workspaceId": "ws:mpzncs2z-0001-2wgv51"
}
```

```yaml
# SKILL.md frontmatter (changed fields)
argument-hint: '[feature-brief:id | "one-line intent"]  (workspace auto-resolved from hotseat.config.json; prefix a ws: token to override)'
arguments: [target]
```

```markdown
Workspace resolution (in the skill body), in precedence order:
1. If $target begins with a `ws:` token → that token is $WS (override); the rest is the real target.
2. Else Read `hotseat.config.json` at the worktree root → use its `workspaceId` as $WS.
3. Else call `listWorkspaces`, confirm $WS with the user, and offer to write hotseat.config.json.
Use $WS wherever a workspace id is needed for the rest of the run.
```

## Open questions
_None._

## Resolved questions
_None._

## References
_None._

## Child pages
_None._
