/**
 * Stream-to-stream workspace replication integration test.
 *
 * Two INDEPENDENT in-memory Durable-Streams servers stand in for "local" and
 * "remote": a workspace is authored on the SOURCE server, `replicateWorkspace`
 * copies its stream to the DEST server, and a fresh wiki bound to the DEST proves
 * the copy is byte-identical (same event log, same Markdown), commit boundaries are
 * preserved, the copy is idempotent + resumable, the workspace lists on the dest,
 * a dry-run writes nothing, and a divergent destination is refused.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { IStreamConfig, IWiki, PageId, WorkspaceId } from "../src/api";
import { replicateWorkspace, ReplicationConflictError } from "../src/core/replicate";
import { EventLog } from "../src/stores/event-log";
import { startTestServer, wikiOn, type ITestServer } from "../src/testing";
import { featurePageTypes } from "wiki-models/feature";

const NS = "test"; // matches wikiOn's default namespace

const cfg = (url: string): IStreamConfig => ({ baseUrl: url, namespace: NS });

/** A deterministic id generator with a distinct prefix (so two wikis mint distinct eventIds). */
function prefixedIds(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

/** Author a small but non-trivial workspace (a feature-brief + its pinned children + a few edits). */
async function seedWorkspace(wiki: IWiki): Promise<{ handle: Awaited<ReturnType<IWiki["createWorkspace"]>>; wsId: WorkspaceId; briefId: PageId }> {
  const handle = await wiki.createWorkspace({ name: "Docs" });
  const { value: briefId } = await handle.createPage("feature-brief", { title: "Export", parentId: null });
  await handle.mutate(briefId, "setSummary", { text: "Copy a workspace between servers." });
  await handle.mutate(briefId, "addConstraint", { text: "deterministic render" });
  await handle.mutate(briefId, "beginPlanning", {});
  return { handle, wsId: handle.id, briefId };
}

describe("replicateWorkspace: copy a workspace between servers", () => {
  let srcServer: ITestServer;
  let dstServer: ITestServer;
  let srcWiki: IWiki;
  const opened: IWiki[] = [];

  beforeEach(async () => {
    srcServer = await startTestServer();
    dstServer = await startTestServer();
    srcWiki = wikiOn(srcServer.url, featurePageTypes);
  });

  afterEach(async () => {
    await srcWiki.close();
    await Promise.all(opened.splice(0).map((w) => w.close()));
    await srcServer.stop();
    await dstServer.stop();
  });

  /** A fresh wiki bound to the dest server (tracked for teardown). */
  function destWiki(): IWiki {
    const w = wikiOn(dstServer.url, featurePageTypes);
    opened.push(w);
    return w;
  }

  it("produces a byte-identical workspace on the destination (round-trip identity)", async () => {
    const { wsId } = await seedWorkspace(srcWiki);

    const report = await replicateWorkspace({ source: cfg(srcServer.url), dest: cfg(dstServer.url), workspaceId: wsId });
    expect(report.copiedEvents).toBe(report.sourceEvents);
    expect(report.destHeadAfter).toBe(report.sourceEvents);

    const srcHistory = await srcWiki.openWorkspace(wsId).then((h) => h.history());
    const destFresh = await destWiki().openWorkspace(wsId);

    // Same event log, verbatim — every envelope field carried unchanged.
    expect(await destFresh.history()).toEqual(srcHistory);
    // Therefore the same deterministic Markdown render of the whole tree.
    const srcHandle = await srcWiki.openWorkspace(wsId);
    expect(await destFresh.toMarkdown()).toBe(await srcHandle.toMarkdown());
  });

  it("preserves array-message commit boundaries (a multi-event commit is not flattened)", async () => {
    const { wsId } = await seedWorkspace(srcWiki);
    await replicateWorkspace({ source: cfg(srcServer.url), dest: cfg(dstServer.url), workspaceId: wsId });

    const srcLog = new EventLog({ baseUrl: srcServer.url, namespace: NS });
    const dstLog = new EventLog({ baseUrl: dstServer.url, namespace: NS });
    try {
      const srcCommits = await srcLog.readCommits(wsId);
      const dstCommits = await dstLog.readCommits(wsId);
      // Same commit grouping AND same bytes.
      expect(dstCommits.map((c) => c.length)).toEqual(srcCommits.map((c) => c.length));
      expect(dstCommits).toEqual(srcCommits);
      // createPage("feature-brief") materializes pinned children in ONE commit, so at
      // least one commit carries more than one event — proving it wasn't flattened.
      expect(srcCommits.some((c) => c.length > 1)).toBe(true);
    } finally {
      await srcLog.close();
      await dstLog.close();
    }
  });

  it("is idempotent and resumable (re-running copies only new commits)", async () => {
    const { handle, wsId, briefId } = await seedWorkspace(srcWiki);

    const first = await replicateWorkspace({ source: cfg(srcServer.url), dest: cfg(dstServer.url), workspaceId: wsId });
    expect(first.copiedCommits).toBeGreaterThan(0);

    // Re-run against an up-to-date destination: nothing to copy, no throw.
    const second = await replicateWorkspace({ source: cfg(srcServer.url), dest: cfg(dstServer.url), workspaceId: wsId });
    expect(second.copiedCommits).toBe(0);
    expect(second.copiedEvents).toBe(0);
    expect(second.destHeadBefore).toBe(first.destHeadAfter);

    // Append two more commits on the source, then resume: only the new commits copy.
    await handle.mutate(briefId, "askQuestion", { text: "which formats?" });
    await handle.mutate(briefId, "addConstraint", { text: "streaming" });

    const third = await replicateWorkspace({ source: cfg(srcServer.url), dest: cfg(dstServer.url), workspaceId: wsId });
    expect(third.copiedCommits).toBe(2);
    expect(third.destHeadAfter).toBe(third.sourceEvents);

    // Destination is current with the source again.
    const destFresh = await destWiki().openWorkspace(wsId);
    expect(await destFresh.history()).toEqual(await (await srcWiki.openWorkspace(wsId)).history());
  });

  it("copies the catalog so the workspace lists on the destination", async () => {
    const { wsId } = await seedWorkspace(srcWiki);
    const report = await replicateWorkspace({ source: cfg(srcServer.url), dest: cfg(dstServer.url), workspaceId: wsId });
    expect(report.catalogEventsCopied).toBeGreaterThan(0);

    const listed = await destWiki().listWorkspaces();
    const entry = listed.find((w) => w.id === wsId);
    expect(entry).toBeDefined();
    expect(entry?.name).toBe("Docs");
    expect(entry?.status).toBe("active");
  });

  it("dry-run writes nothing but reports what would be copied", async () => {
    const { wsId } = await seedWorkspace(srcWiki);

    const report = await replicateWorkspace({
      source: cfg(srcServer.url),
      dest: cfg(dstServer.url),
      workspaceId: wsId,
      dryRun: true,
    });
    expect(report.copiedEvents).toBe(report.sourceEvents);
    expect(report.copiedEvents).toBeGreaterThan(0);
    expect(report.destHeadAfter).toBe(0);
    // The catalog count is the real would-copy (the dest has no entry for this ws yet),
    // computed via non-creating probes — so a dry-run reports it without side effects.
    expect(report.catalogEventsCopied).toBeGreaterThan(0);

    // Nothing landed on the destination: the workspace stream was never even created
    // (a dry-run is side-effect-free), and the workspace does not list.
    const dstLog = new EventLog({ baseUrl: dstServer.url, namespace: NS });
    try {
      expect(await dstLog.exists(wsId)).toBe(false);
    } finally {
      await dstLog.close();
    }
    expect(await destWiki().listWorkspaces()).toHaveLength(0);
  });

  it("refuses a destination whose history diverges from the source", async () => {
    const { wsId } = await seedWorkspace(srcWiki);

    // Pre-create a DIFFERENT workspace under the SAME id on the destination, using a
    // distinct id generator so its events carry distinct eventIds.
    const intruder = wikiOn(dstServer.url, featurePageTypes, { ids: prefixedIds("dst") });
    opened.push(intruder);
    const dHandle = await intruder.createWorkspace({ name: "Different", id: wsId });
    await dHandle.createPage("feature-brief", { title: "Unrelated", parentId: null });

    await expect(
      replicateWorkspace({ source: cfg(srcServer.url), dest: cfg(dstServer.url), workspaceId: wsId }),
    ).rejects.toBeInstanceOf(ReplicationConflictError);
  });
});
