/**
 * The `toc` page type renders a generated, curatable table of contents of its CHILDREN.
 * The entry list is a DERIVED view of the live child set:
 * adding / renaming / removing a child reflows the TOC with no write to the TOC page. The
 * page stores only the curation — groups (title + blurb + order) and a child→group placement
 * — which is reconciled against the live children at render, so it never drifts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IWiki, IWorkspaceHandle, PageId } from "../src/api";
import { tocPageTypes } from "wiki-models/toc";
import { createTestWiki, type ITestWiki } from "../src/testing";

describe("toc: a derived, groupable table of contents of children", () => {
  let harness: ITestWiki;
  let wiki: IWiki;
  let ws: IWorkspaceHandle;
  let toc: PageId;
  let alpha: PageId;
  let beta: PageId;
  let gamma: PageId;
  let delta: PageId;

  /** A child entry as it renders: a Markdown link to the child page (href = its id). */
  const entry = (id: PageId, title: string): string => `[${title}](${id})`;

  /** The "## Contents" block of the rendered TOC (heading stripped, trailing trimmed). */
  async function contents(): Promise<string> {
    const md = await ws.toMarkdown(toc);
    const start = md.indexOf("## Contents\n");
    if (start < 0) return "";
    return md.slice(start + "## Contents\n".length).trimEnd();
  }

  /** Create a child page under the TOC and return its id (children are themselves toc pages). */
  async function child(title: string): Promise<PageId> {
    return (await ws.createPage("toc", { title, parentId: toc })).value;
  }

  beforeAll(async () => {
    harness = await createTestWiki(tocPageTypes);
    wiki = harness.wiki;
    ws = await wiki.createWorkspace({ name: "TOC" });
    toc = (await ws.createPage("toc", { title: "Index", parentId: null })).value;
    alpha = await child("Alpha");
    beta = await child("Beta");
    gamma = await child("Gamma");
  });

  afterAll(async () => {
    await harness.stop();
  });

  it("with no groups, lists every child as a flat linked list in tree order", async () => {
    const block = await contents();
    expect(await contents()).toBe(block); // deterministic
    expect(block).toBe(`- ${entry(alpha, "Alpha")}\n- ${entry(beta, "Beta")}\n- ${entry(gamma, "Gamma")}`);
  });

  it("buckets assigned children under group rows and the rest under Ungrouped (nested)", async () => {
    const groupId = ((await ws.mutate(toc, "addGroup", { title: "Core" })).value as { groupId: string }).groupId;
    await ws.mutate(toc, "assignChild", { childId: String(alpha), groupId });
    await ws.mutate(toc, "assignChild", { childId: String(beta), groupId });
    expect(await contents()).toBe(
      `- **Core**\n  - ${entry(alpha, "Alpha")}\n  - ${entry(beta, "Beta")}\n- **Ungrouped**\n  - ${entry(gamma, "Gamma")}`,
    );
  });

  it("renders a group blurb inline on the group row", async () => {
    const groups = await groupIds();
    await ws.mutate(toc, "setGroupBlurb", { groupId: groups[0], blurb: "Foundational." });
    expect(await contents()).toBe(
      `- **Core** — Foundational.\n  - ${entry(alpha, "Alpha")}\n  - ${entry(beta, "Beta")}\n- **Ungrouped**\n  - ${entry(gamma, "Gamma")}`,
    );
  });

  it("reorders within a group by reordering placement (within-group = placement order)", async () => {
    await ws.mutate(toc, "reorderChildren", { orderedChildIds: [String(beta), String(alpha)] });
    expect(await contents()).toBe(
      `- **Core** — Foundational.\n  - ${entry(beta, "Beta")}\n  - ${entry(alpha, "Alpha")}\n- **Ungrouped**\n  - ${entry(gamma, "Gamma")}`,
    );
    // restore for later assertions
    await ws.mutate(toc, "reorderChildren", { orderedChildIds: [String(alpha), String(beta)] });
  });

  it("is DERIVED, not a snapshot: child renames and new children flow through with no TOC write", async () => {
    await ws.setPageTitle(alpha, "Alpha (core)");
    expect(await contents()).toBe(
      `- **Core** — Foundational.\n  - ${entry(alpha, "Alpha (core)")}\n  - ${entry(beta, "Beta")}\n- **Ungrouped**\n  - ${entry(gamma, "Gamma")}`,
    );
    // A brand-new child appears under Ungrouped automatically.
    delta = await child("Delta");
    expect(await contents()).toBe(
      `- **Core** — Foundational.\n  - ${entry(alpha, "Alpha (core)")}\n  - ${entry(beta, "Beta")}\n- **Ungrouped**\n  - ${entry(gamma, "Gamma")}\n  - ${entry(delta, "Delta")}`,
    );
  });

  it("unassigning returns a child to Ungrouped; removing a group ungroups its members", async () => {
    await ws.mutate(toc, "unassignChild", { childId: String(beta) });
    expect(await contents()).toBe(
      `- **Core** — Foundational.\n  - ${entry(alpha, "Alpha (core)")}\n- **Ungrouped**\n  - ${entry(beta, "Beta")}\n  - ${entry(gamma, "Gamma")}\n  - ${entry(delta, "Delta")}`,
    );
    const groups = await groupIds();
    await ws.mutate(toc, "removeGroup", { groupId: groups[0] });
    // No groups left → back to a flat linked list of all children in tree order.
    expect(await contents()).toBe(
      `- ${entry(alpha, "Alpha (core)")}\n- ${entry(beta, "Beta")}\n- ${entry(gamma, "Gamma")}\n- ${entry(delta, "Delta")}`,
    );
  });

  /** Read the current group element ids from the rendered state (helper for assertions). */
  async function groupIds(): Promise<string[]> {
    const state = await (await ws.page(toc)).state();
    const f = state.sections.find((s) => s.key === "groups")?.fields["items"];
    return f !== undefined && f.kind === "list" ? f.elements.map((e) => e.id) : [];
  }
});

describe("toc: group ordering and empty state", () => {
  let harness: ITestWiki;
  let wiki: IWiki;
  let ws: IWorkspaceHandle;

  async function contentsOf(page: PageId): Promise<string> {
    const md = await ws.toMarkdown(page);
    const start = md.indexOf("## Contents\n");
    return start < 0 ? "" : md.slice(start + "## Contents\n".length).trimEnd();
  }

  beforeAll(async () => {
    harness = await createTestWiki(tocPageTypes);
    wiki = harness.wiki;
    ws = await wiki.createWorkspace({ name: "TOC ordering" });
  });

  afterAll(async () => {
    await harness.stop();
  });

  it("renders the empty-contents placeholder when there are no children", async () => {
    const empty = (await ws.createPage("toc", { title: "Empty", parentId: null })).value;
    expect(await contentsOf(empty)).toBe("_No pages yet._");
  });

  it("reorderGroups ignores unknown ids WITHOUT shifting the real groups", async () => {
    const toc = (await ws.createPage("toc", { title: "Ordered", parentId: null })).value;
    const ids: string[] = [];
    for (const title of ["A", "B", "C", "D"]) {
      ids.push(((await ws.mutate(toc, "addGroup", { title })).value as { groupId: string }).groupId);
    }
    expect(await contentsOf(toc)).toBe("- **A**\n- **B**\n- **C**\n- **D**");

    // An unknown id must not consume an index slot (the bug: it shifted every following group).
    await ws.mutate(toc, "reorderGroups", { orderedGroupIds: ["nonexistent-X", ids[3]] });
    expect(await contentsOf(toc)).toBe("- **D**\n- **A**\n- **B**\n- **C**");

    // moveGroup moves a single group to an explicit index.
    await ws.mutate(toc, "moveGroup", { groupId: ids[0], toIndex: 0 }); // A back to front
    expect(await contentsOf(toc)).toBe("- **A**\n- **D**\n- **B**\n- **C**");
  });

  it("excludes an archived child from the contents (flat and grouped), and restores it on unarchive", async () => {
    const toc = (await ws.createPage("toc", { title: "Archiving", parentId: null })).value;
    const one = (await ws.createPage("toc", { title: "One", parentId: toc })).value;
    const two = (await ws.createPage("toc", { title: "Two", parentId: toc })).value;
    const entry = (id: PageId, title: string): string => `[${title}](${id})`;
    expect(await contentsOf(toc)).toBe(`- ${entry(one, "One")}\n- ${entry(two, "Two")}`);

    // Archiving a child drops it from the flat list entirely (no dead link).
    await ws.archivePage(two);
    expect(await contentsOf(toc)).toBe(`- ${entry(one, "One")}`);

    // It also drops from a curated group placement — and doesn't reappear under Ungrouped.
    const groupId = ((await ws.mutate(toc, "addGroup", { title: "G" })).value as { groupId: string }).groupId;
    await ws.mutate(toc, "assignChild", { childId: String(one), groupId });
    await ws.mutate(toc, "assignChild", { childId: String(two), groupId });
    expect(await contentsOf(toc)).toBe(`- **G**\n  - ${entry(one, "One")}`);

    // Unarchiving brings it back, still honouring its stored placement.
    await ws.unarchivePage(two);
    expect(await contentsOf(toc)).toBe(`- **G**\n  - ${entry(one, "One")}\n  - ${entry(two, "Two")}`);
  });
});
