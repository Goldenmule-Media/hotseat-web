/**
 * An {@link EventSource} backed by the embedded engine (DESIGN §5.1, §8). The
 * projection tailer reads localhost streams; rather than re-implement the Durable
 * Streams wire format here, we reuse the engine's PUBLIC surface: `listWorkspaces()`
 * for catalog discovery, and a hot {@link IWorkspaceHandle}'s `history()` for each
 * workspace's full contiguous event history (exactly what `applyCommit` folds,
 * ADR-M3). Keeping the engine as the only stream consumer honors ADR-M5 (wiki-mcp
 * imports only the engine) and keeps a single hydrated tail per workspace (DESIGN §7).
 *
 * `history()` returns the FULL history; `applyCommit`'s offset-skip makes re-reading
 * idempotent (events `<= applied_version` are no-ops, §5.1), so `sinceVersion` is an
 * optimization the engine source can safely ignore.
 */
import type { IEventEnvelope, Unsubscribe, WorkspaceId } from "wiki";

import type { EmbeddedEngine } from "../engine.js";
import type { EventSource } from "./projection.js";

/** Build an {@link EventSource} over the embedded engine. */
export function engineEventSource(engine: EmbeddedEngine): EventSource {
  return {
    async listWorkspaces(): Promise<readonly WorkspaceId[]> {
      const summaries = await engine.listWorkspaces();
      return summaries.map((s) => s.id);
    },
    async readHistory(workspace: WorkspaceId, _sinceVersion: number): Promise<readonly IEventEnvelope[]> {
      const handle = await engine.open(workspace);
      // The full contiguous history; the projection's offset-skip dedupes re-reads.
      return handle.history();
    },
    /**
     * Live tail: a workspace handle's `subscribe` fans out **external** events (writes
     * by other clients arriving on the stream tail, §8.4); a local commit through the
     * same handle does NOT fan out, so THIS process's own writes are pushed via
     * {@link ProjectionService.notify} instead. We fire on each event regardless of
     * version — the coalesced projector reads to head and the offset-skip dedupes.
     */
    async subscribe(workspace: WorkspaceId, onChange: () => void): Promise<Unsubscribe> {
      const handle = await engine.open(workspace);
      return handle.subscribe((_event: IEventEnvelope) => onChange());
    },
  };
}
