# Cross-workspace page moves are a source-journaled saga that keeps page ids and leaves forwards

**Status:** accepted

## Metadata
- **Number:** ADR-39
- **Date:** 2026-10-13
- **Scope:** wiki
- **Deciders:** Ben Jordan

## Context
Pages sometimes belong in another workspace. The Godot addon pages are moving into the Sovereign Axe workspace, and more game workspaces will follow. A workspace is one stream and the unit of atomic consistency, so a move touches two streams and cannot be one commit. Recreating the pages through the public API would lose their ids, their statuses, their serial numbers and their history. Pages that stay behind would also stop validating, because every write checks that each ref on the page resolves in the same workspace.

## Decision
A move is a saga of single-stream commits, each idempotent, journaled on the source stream. The source begins the move, which freezes the subtrees. The host copies the attachments the pages reference. The target imports the pages in one commit. The source then completes the move. A target that refuses the import aborts the move and the source unfreezes. Any other failure leaves the move pending, and running the move again or resuming it finishes it from the journal. The wiki-mcp host also finishes pending moves when it boots.

Page ids are kept. The target receives each page's node fields and status in a PagesImported event, followed by one SectionOpsApplied per page that rebuilds its content, so the content stays an op history that upcasters apply to. No FSM edges are replayed. Serial numbers are re-minted after the target's own, and the original numbers stay in the import event. History stays in the source.

Completing a move drops the pages from the source and leaves a forward for each one, naming its new workspace and its title when it left. Refs and links that leave the moved pages become cross-workspace references back to the source. Edges into the moved pages from pages that stay become cross-workspace edges. A local ref that names a moved page still resolves through its forward, so the page that holds it stays writable, and it renders as a wiki:// link to the page's new home. Reading or changing a moved page fails with PAGE_MOVED, which names the new workspace.

The engine owns the steps and wiki/admin owns the saga, so the MCP tool and the operator script run the same code. A move needs access to both workspaces.

## Consequences
A moved page's file leaves the source mirror and appears in the target's mirror. This is a move, not an archive, so nothing parks in the archived folder.

Every engine that tails a workspace must know the move events before the first move lands, or its tail stops. The server, wiki-ui and every installed wiki-mirror have to be upgraded first.

A forward lasts until the page moves back. Moving it back clears the forward, and links in the original workspace that pointed at it become local again. Content refs in other pages keep naming the workspace they were written against and resolve through that workspace's forwards.

## Relations
_None._
