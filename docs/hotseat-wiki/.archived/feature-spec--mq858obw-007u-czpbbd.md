# Spec — Model-packaged Claude skills

**Status:** sealed

## Overview
_No overview yet._

## Design
_No design yet._

## Decisions
Skill files stay in plugins/hotseat with bundles declaring pointers (the v1 pointer approach ships as-is). Moving skill files into bundle directories (per-bundle plugin manifests + marketplace entries) is deferred until more bundles ship skills — it would break the documented /plugin install hotseat@hotseat flow and orphan the .claude/skills sync copy for no current gain. Should skill FILES eventually move into bundle directories (e.g. wiki-models/src/feature/skills/ plus per-bundle plugin manifests and marketplace entries), or stay in plugins/hotseat with bundles declaring pointers? v1 implements the pointer approach — moving would break the documented /plugin install hotseat@hotseat flow, orphan the .claude/skills/build-feature sync copy, and decouple the plugin's .mcp.json wiring from the skill. Product-direction call, does not block v1.

## References
_None._

## Child pages
_None._
