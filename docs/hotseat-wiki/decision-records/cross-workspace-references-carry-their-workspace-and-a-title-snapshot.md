# Cross-workspace references carry their workspace and a title snapshot

**Status:** accepted

## Metadata
- **Number:** ADR-38
- **Date:** 2026-10-13
- **Scope:** wiki
- **Deciders:** Ben Jordan

## Context
Graph links and content refs could only point at pages in their own workspace, and the engine checked that the target existed on every write. Projects now span workspaces. A game workspace wants to point at shared Godot addon pages that live in another workspace, and a page moved between workspaces must keep the refs that point out of its old home. The engine cannot check a target in another stream, and the render must stay deterministic, so it cannot look up another workspace's title either.

## Decision
A graph link and a content ref may name the workspace of their target. A cross-workspace graph link adds workspace and title to the edge. A cross-workspace content ref adds workspace and title to any RefTarget kind, and a kind other than page must also name its page. The inline run form is ref plus workspace. The title is a snapshot taken when the reference is written, and it is the only label the reference ever renders with.

Both forms render as a Markdown link whose label is the title snapshot and whose href is wiki://<workspaceId>/<pageId>. Nothing resolves live, so equal state still renders byte-identical Markdown. A reference that names its own workspace is an ordinary local reference and is integrity-checked as before.

Validation is split by layer. The engine checks only what it can see: the source page exists, the named workspace is another one, and the title is non-empty. The host checks the rest before the write. It requires access to every workspace a write names, confirms the target exists in the read model, and stamps the target's current title, so an agent never authors the label. Re-writing a reference refreshes its snapshot.

## Consequences
A label can go stale when the target is renamed. That is accepted, and re-linking refreshes it. A dangling target is not detected after the write, and archived or moved status is never baked into the Markdown. Consumers such as wiki-ui may decorate a link, but the render never does.

A reader without access to the target workspace sees the title the author chose to disclose and is refused on navigation. Inbound lookups, the backlinks tool, list graph links and content refs from other workspaces only when the caller can access the source workspace, so a private workspace never reveals that it links in.

The edge's identity includes the target workspace, and the read model indexes links and refs by target workspace and page. The wiki:// scheme is shared with MCP resource URIs, whose page part contains a slash, so the two never parse as each other. The same shape lets a cross-workspace page move rewrite the refs that leave a moved subtree instead of rejecting them.

## Relations
_None._
