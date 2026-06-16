# Testing plan — Auto-resolve build-feature's workspace from a repo hotseat.config.json

**Status:** ready

## Planned
_None._

## Passed
- hotseat.config.json exists at the repo root, parses as valid JSON, and its workspaceId equals ws:mpzncs2z-0001-2wgv51 (the workspace this repo documents).
- Both SKILL.md copies are byte-identical after the edit (diff .claude/skills/build-feature/SKILL.md plugins/hotseat/skills/build-feature/SKILL.md returns empty).
- The edited SKILL.md no longer requires a workspace argument: frontmatter arguments is [target], and the body contains the hotseat.config.json resolution block (no remaining reliance on a $workspace argument substitution).
- Repo health unaffected: npm run typecheck and npm run test both pass (no package/engine code was modified).
- Docs review: plugins/hotseat/README.md and the build-feature README(s) document hotseat.config.json and the workspace-less invocation, and stay consistent with the SKILL.md resolution precedence.

## Failed
_None._

## References
_None._

## Child pages
_None._
