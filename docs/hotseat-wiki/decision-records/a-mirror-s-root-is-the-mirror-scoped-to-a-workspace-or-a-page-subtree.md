# A mirror's root is the mirror, scoped to a workspace or a page subtree

**Status:** accepted

## Metadata
- **Number:** ADR-37
- **Date:** 2026-10-13
- **Scope:** wiki-mirror
- **Deciders:** Ben Jordan

## Context
A mirror entry mapped one whole workspace to one root and wrote the tree under `<root>/<workspace-slug>/`. Two needs broke that shape. First, a single workspace can hold several projects, such as the Sovereign Axe workspace with one page per game, and each game's repo should carry only its own part. Second, every repo ended up with its mirror at a different depth and under a folder named after the workspace, so renaming a workspace moved its whole mirror and stranded links into the old path. The user asked for one standard folder in every repo.

## Decision
An emitter entry may name a subtreeRootId, a page id. The entry then mirrors that page and its descendants only. The same workspace may appear in several entries, each with a different subtree and a different root, and a whole-workspace entry may sit beside them. Each workspace and subtree pair may appear once, and no root may repeat or sit inside another root.

The root is the mirror. A whole-workspace entry writes its top-level pages directly into the root, with no workspace-name folder. A subtree entry writes its page to index.md at the root and nests the descendants beneath it, so renaming or moving that page moves no file. The archive folder and the assets folder sit at the root in both cases. By convention a repo's root is the wiki-mirror folder at the repo's top level. The hotseat-web repo is the exception and keeps docs/hotseat-wiki, because its wiki-mirror folder is the package itself.

The subtree is keyed by page id rather than by title or path, so it survives renames and reparents. A subtree root that disappears from the fold fails the reconcile and leaves the root untouched, rather than reading as the deletion of everything below it.

## Consequences
The manifest records a layout version and the entry's scope. A manifest written under the old slug layout, or for a different subtree, forces a full rebuild on the next start that writes the new tree and sweeps the old files. Existing mirrors therefore migrate on their own when the service restarts, but each repo sees its mirrored files move in one commit.

Several entries on one workspace share the engine's single handle, so they share one stream tail and one probe request. A commit outside a subtree writes nothing in that root, and the manifest is rewritten only when an owned file changes, so a game repo stays quiet while other games are edited.

A page moved out of a subtree leaves that root and appears in whichever entry covers its new place. This is a move, so the rule that archiving never deletes a mirrored file is unchanged. Links from inside a subtree to pages outside it still render as page-id links, exactly as in a whole-workspace mirror.

## Relations
_None._
