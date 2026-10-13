/**
 * Cross-workspace links and content refs: a graph edge or a ref whose target lives in another
 * workspace's stream. The engine can't read that stream, so each carries the target's
 * workspace id and a write-time title snapshot, renders as a `wiki://<ws>/<page>` href, and
 * never resolves live.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import documentPageTypes from "wiki-models/document";
import { featurePageTypes } from "wiki-models/feature";
import type { IWorkspaceHandle, PageId, SectionId, WorkspaceId } from "../src/api";
import { Registry } from "../src/core/registry";
import { deserializeState, serializeState } from "../src/core/snapshot";
import { foldWorkspace } from "../src/core/workspace";
import { affectedPageIds } from "../src/search/render-docs";
import { collectCrossWorkspaceArgRefs, crossWorkspaceHref, crossWorkspaceRefOf, parseCrossWorkspaceHref } from "../src";
import { createTestWiki, type ITestWiki } from "../src/testing";

describe("cross-workspace links", () => {
  let harness: ITestWiki;
  let ws: IWorkspaceHandle;
  let other: IWorkspaceHandle;
  let brief: PageId;
  let local: PageId;
  let remote: PageId;

  beforeAll(async () => {
    harness = await createTestWiki(featurePageTypes);
    ws = await harness.wiki.createWorkspace({ name: "Here" });
    other = await harness.wiki.createWorkspace({ name: "There" });
    brief = (await ws.createPage("feature-brief", { title: "Brief", parentId: null })).value;
    local = (await ws.createPage("feature-brief", { title: "Local", parentId: null })).value;
    remote = (await other.createPage("feature-brief", { title: "Remote", parentId: null })).value;
  });

  afterAll(async () => {
    await harness.stop();
  });

  const references = async (token?: string): Promise<string> => {
    const md = await ws.toMarkdown(brief, token === undefined ? {} : { consistentWith: token });
    return md.slice(md.indexOf("## References"), md.indexOf("## Child pages"));
  };

  it("renders the title snapshot under a wiki:// href, next to local links", async () => {
    await ws.link(brief, local, "depends-on");
    const { token } = await ws.link(brief, remote, "uses", { workspace: other.id, title: "Remote addon" });
    expect(await references(token)).toBe(
      `## References\n- depends-on → [Local](${local})\n- uses → [Remote addon](wiki://${other.id}/${remote})\n\n`,
    );
  });

  it("never resolves the label live: renaming the target leaves the snapshot", async () => {
    await other.setPageTitle(remote, "Renamed remotely");
    expect(await references()).toContain("[Remote addon]");
  });

  it("re-linking refreshes the snapshot in place instead of adding an edge", async () => {
    const { token } = await ws.link(brief, remote, "uses", { workspace: other.id, title: "Renamed remotely" });
    const md = await references(token);
    expect(md).toContain(`- uses → [Renamed remotely](wiki://${other.id}/${remote})`);
    expect(md.match(/uses →/g)).toHaveLength(1);
  });

  it("an edge's identity includes its workspace", async () => {
    const third = "ws:elsewhere" as WorkspaceId;
    const { token } = await ws.link(brief, remote, "uses", { workspace: third, title: "Same id, other ws" });
    expect((await references(token)).match(/uses →/g)).toHaveLength(2);
    const { token: t2 } = await ws.unlink(brief, remote, "uses", third);
    expect((await references(t2)).match(/uses →/g)).toHaveLength(1);
  });

  it("unlink removes only the cross-workspace edge", async () => {
    const { token } = await ws.unlink(brief, remote, "uses", other.id);
    expect(await references(token)).toBe(`## References\n- depends-on → [Local](${local})\n\n`);
  });

  it("validates what it can: source exists, a different workspace, a non-empty title", async () => {
    await expect(ws.link("feature-brief:nope" as PageId, remote, "uses", { workspace: other.id, title: "x" })).rejects.toThrow(
      /does not exist/,
    );
    await expect(ws.link(brief, local, "uses", { workspace: ws.id, title: "x" })).rejects.toThrow(/is this workspace/);
    await expect(ws.link(brief, remote, "uses", { workspace: other.id, title: "  " })).rejects.toThrow(/non-empty title/);
    // A target this engine can't see is fine: the host validates it.
    await expect(
      ws.link(brief, "feature-brief:anywhere" as PageId, "uses", { workspace: other.id, title: "Unseen" }),
    ).resolves.toBeDefined();
  });

  it("is not a backlink of a same-id page here, and only touches its source on a commit", async () => {
    const history = await ws.history();
    const state = foldWorkspace(history, new Registry(featurePageTypes));
    const external = state.links.filter((l) => l.workspace !== undefined);
    expect(external).toEqual([
      { from: brief, to: "feature-brief:anywhere", role: "uses", workspace: other.id, title: "Unseen" },
    ]);
    const last = history[history.length - 1]!;
    expect([...affectedPageIds([last], state)]).toEqual([brief]);
  });

  it("survives a snapshot round-trip; local links keep their old shape", async () => {
    const state = foldWorkspace(await ws.history(), new Registry(featurePageTypes));
    const restored = deserializeState(JSON.parse(JSON.stringify(serializeState(state))));
    expect(restored.links).toEqual(state.links);
    expect(restored.links.find((l) => l.to === local)).toEqual({ from: brief, to: local, role: "depends-on" });
  });

  it("the href helpers round-trip and reject other hrefs", () => {
    const href = crossWorkspaceHref(other.id, remote);
    expect(parseCrossWorkspaceHref(href)).toEqual({ workspace: other.id, page: remote });
    expect(parseCrossWorkspaceHref(remote)).toBeUndefined();
    expect(parseCrossWorkspaceHref("wiki://ws-only")).toBeUndefined();
    expect(parseCrossWorkspaceHref(`wiki://default/page/${other.id}/${remote}`)).toBeUndefined();
  });
});

describe("cross-workspace refs in content", () => {
  let harness: ITestWiki;
  let ws: IWorkspaceHandle;
  let other: IWorkspaceHandle;
  let doc: PageId;
  let local: PageId;

  beforeAll(async () => {
    harness = await createTestWiki([...featurePageTypes, ...documentPageTypes]);
    ws = await harness.wiki.createWorkspace({ name: "Here" });
    other = await harness.wiki.createWorkspace({ name: "There" });
    doc = (await ws.createPage("document", { title: "Doc", parentId: null })).value;
    local = (await ws.createPage("document", { title: "Local", parentId: null })).value;
  });

  afterAll(async () => {
    await harness.stop();
  });

  it("renders an inline ref into another workspace with its title snapshot", async () => {
    const { token } = await ws.mutate(doc, "addParagraph", {
      inlines: ["See ", { ref: "document:far", workspace: other.id, title: "Far doc" }, " and ", { ref: local }, "."],
    });
    const md = await ws.toMarkdown(doc, { consistentWith: token });
    expect(md).toContain(`See [Far doc](wiki://${other.id}/document:far) and Local.`);
    expect(await ws.toMarkdown(doc, { consistentWith: token })).toBe(md);
  });

  it("rejects a cross-workspace ref without a title, or a non-page kind without its page", async () => {
    await expect(
      ws.mutate(doc, "addParagraph", { inlines: [{ ref: "document:far", workspace: other.id }] }),
    ).rejects.toThrow(/non-empty title/);
    expect(
      crossWorkspaceRefOf({ kind: "section", id: "s" as SectionId, workspace: other.id, title: "S" }, ws.id),
    ).toBeUndefined();
  });

  it("a ref naming its own workspace is a local ref, integrity-checked as usual", async () => {
    await expect(
      ws.mutate(doc, "addParagraph", { inlines: [{ ref: "document:missing", workspace: ws.id }] }),
    ).rejects.toThrow(/does not resolve/);
    const { token } = await ws.mutate(doc, "addParagraph", { inlines: [{ ref: local, workspace: ws.id }] });
    expect(await ws.toMarkdown(doc, { consistentWith: token })).toContain("\nLocal\n");
  });

  it("finds cross-workspace refs at any depth in raw args", () => {
    const args = {
      inlines: ["x", { ref: "document:a", workspace: "ws:b" }, { ref: "document:c" }],
      field: {
        kind: "ref",
        target: { kind: "element", page: "document:d", section: "s", field: "f", element: "e", workspace: "ws:b" },
      },
      same: { kind: "page", id: "document:e", workspace: ws.id },
    };
    const found = collectCrossWorkspaceArgRefs(args, ws.id);
    expect(found.map((f) => [f.workspace, f.page, f.kind])).toEqual([
      ["ws:b", "document:a", "page"],
      ["ws:b", "document:d", "element"],
    ]);
    found[0]!.holder["title"] = "Stamped";
    expect(args.inlines[1]).toEqual({ ref: "document:a", workspace: "ws:b", title: "Stamped" });
  });
});
