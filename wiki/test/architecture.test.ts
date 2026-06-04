/**
 * The `architecture` page type: a node in a typed graph describing the codebase. It holds the
 * documentation sections (summary/purpose/usage/data-model/invariants), CODE references
 * (file + symbol, no line numbers), and MODULE dependencies (integrity-checked refs to other
 * architecture pages whose labels are render-derived). Freshness is a lightweight current⇄stale
 * lifecycle an agent drives — no draft state, since docs are written after the code exists.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IWiki, IWorkspaceHandle, PageId } from "../src/api";
import { architecturePageTypes } from "wiki-models/architecture";
import { Toc } from "wiki-models/toc";
import { createTestWiki, type ITestWiki } from "../src/testing";

/** Extract the "## <heading>" block body (trailing trimmed) from a rendered page. */
function block(md: string, heading: string): string {
  const start = md.indexOf(`## ${heading}\n`);
  if (start < 0) return "";
  const after = md.slice(start + `## ${heading}\n`.length);
  const end = after.indexOf("\n## ");
  return (end < 0 ? after : after.slice(0, end)).trimEnd();
}

const statusOf = (md: string): string => md.match(/\*\*Status:\*\* (\w+)/)?.[1] ?? "";

describe("architecture: a typed graph node describing the codebase", () => {
  let harness: ITestWiki;
  let wiki: IWiki;
  let ws: IWorkspaceHandle;
  let engine: PageId;
  let schema: PageId;

  beforeAll(async () => {
    harness = await createTestWiki(architecturePageTypes);
    wiki = harness.wiki;
    ws = await wiki.createWorkspace({ name: "Arch" });
    schema = (await ws.createPage("architecture", { title: "Schema layer", parentId: null })).value;
    engine = (await ws.createPage("architecture", { title: "Engine", parentId: null })).value;

    await ws.mutate(engine, "setKind", { kind: "package" });
    await ws.mutate(engine, "setSummary", { text: "The transport-free wiki engine." });
    await ws.mutate(engine, "setPurpose", { text: "Owns the metaschema, reducers, and render." });
    await ws.mutate(engine, "setDataModel", { text: "PageState, ISection, IField." });
    await ws.mutate(engine, "setUsage", { text: "Imported by wiki-mcp's public surface." });
    await ws.mutate(engine, "addCodeRef", { file: "wiki/src/api.ts", symbol: "definePageType", kind: "function" });
    await ws.mutate(engine, "addCodeRef", { file: "wiki/src/core/operations.ts" });
    await ws.mutate(engine, "addInvariant", { text: "Ships zero concrete page types." });
    await ws.mutate(engine, "addDependency", { targetId: String(schema), role: "exposes", note: "the feature bundle" });
  });

  afterAll(async () => {
    await harness.stop();
  });

  it("renders kind, prose sections, and the synced-commit placeholder deterministically", async () => {
    const md = await ws.toMarkdown(engine);
    expect(await ws.toMarkdown(engine)).toBe(md); // deterministic
    expect(block(md, "Kind")).toBe("package");
    expect(block(md, "Summary")).toBe("The transport-free wiki engine.");
    expect(block(md, "Purpose")).toBe("Owns the metaschema, reducers, and render.");
    expect(block(md, "Synced commit")).toBe("_None._"); // empty scalar → engine default placeholder
    expect(statusOf(md)).toBe("current");
  });

  it("formats code references with optional symbol/kind and no line numbers", async () => {
    const md = await ws.toMarkdown(engine);
    expect(block(md, "Code references")).toBe(
      "- function `definePageType` in `wiki/src/api.ts`\n- `wiki/src/core/operations.ts`",
    );
  });

  it("renders contained sub-nodes as links (page-id href) in a Components section; a leaf shows the placeholder", async () => {
    const container = (await ws.createPage("architecture", { title: "Container", parentId: null })).value;
    const childA = (await ws.createPage("architecture", { title: "Child A", parentId: container })).value;
    const childB = (await ws.createPage("architecture", { title: "Child B", parentId: container })).value;
    expect(block(await ws.toMarkdown(container), "Components")).toBe(`- [Child A](${childA})\n- [Child B](${childB})`);
    // A leaf node shows the derived placeholder.
    expect(block(await ws.toMarkdown(childA), "Components")).toBe("_No components._");
    // The link label is render-derived — renaming the child reflows it.
    await ws.setPageTitle(childA, "Child A!");
    expect(block(await ws.toMarkdown(container), "Components")).toBe(`- [Child A!](${childA})\n- [Child B](${childB})`);
  });

  it("renders a dependency edge with a render-derived target title", async () => {
    expect(block(await ws.toMarkdown(engine), "Dependencies")).toBe("- **exposes** → Schema layer — the feature bundle");
    // Renaming the target page reflows the dependency label (it's render-derived, not stored text).
    await ws.setPageTitle(schema, "Schema");
    expect(block(await ws.toMarkdown(engine), "Dependencies")).toBe("- **exposes** → Schema — the feature bundle");
  });

  it("rejects a dependency that is non-existent or self-referential", async () => {
    await expect(
      ws.mutate(engine, "addDependency", { targetId: "architecture:does-not-exist", role: "calls" }),
    ).rejects.toThrow();
    await expect(ws.mutate(engine, "addDependency", { targetId: String(engine), role: "calls" })).rejects.toThrow();
  });

  it("adds then removes code refs / dependencies / invariants and returns the new ids", async () => {
    const node = (await ws.createPage("architecture", { title: "RemoveMe", parentId: null })).value;
    const dep = (await ws.createPage("architecture", { title: "Dep", parentId: null })).value;
    const cr = (await ws.mutate(node, "addCodeRef", { file: "a/b.ts" })).value as { codeRefId: string };
    const inv = (await ws.mutate(node, "addInvariant", { text: "must hold" })).value as { invariantId: string };
    const dp = (await ws.mutate(node, "addDependency", { targetId: String(dep), role: "calls" })).value as {
      dependencyId: string;
    };
    expect(cr.codeRefId && inv.invariantId && dp.dependencyId).toBeTruthy();
    expect(block(await ws.toMarkdown(node), "Code references")).toBe("- `a/b.ts`");
    await ws.mutate(node, "removeCodeRef", { codeRefId: cr.codeRefId });
    await ws.mutate(node, "removeDependency", { dependencyId: dp.dependencyId });
    await ws.mutate(node, "removeInvariant", { invariantId: inv.invariantId });
    const md = await ws.toMarkdown(node);
    expect(block(md, "Code references")).toBe("_No code references._");
    expect(block(md, "Dependencies")).toBe("_No dependencies._");
    expect(block(md, "Invariants & constraints")).toBe("_None._");
  });

  it("drives the current⇄stale freshness lifecycle and rejects off-FSM events", async () => {
    // markCurrent is illegal while already current.
    await expect(ws.mutate(engine, "markCurrent", {})).rejects.toThrow();
    await ws.mutate(engine, "recordSync", { commit: "abc1234" });
    await ws.mutate(engine, "markStale", {});
    // markStale is illegal while already stale.
    await expect(ws.mutate(engine, "markStale", {})).rejects.toThrow();
    let md = await ws.toMarkdown(engine);
    expect(statusOf(md)).toBe("stale");
    expect(block(md, "Synced commit")).toBe("abc1234");
    // A stale node is still editable (you fix it, then re-affirm).
    await ws.mutate(engine, "recordSync", { commit: "def5678" });
    await ws.mutate(engine, "markCurrent", {});
    md = await ws.toMarkdown(engine);
    expect(statusOf(md)).toBe("current");
    expect(block(md, "Synced commit")).toBe("def5678");
  });
});

describe("architecture: composes under a toc Architecture Overview", () => {
  let harness: ITestWiki;
  let wiki: IWiki;
  let ws: IWorkspaceHandle;

  const contents = (md: string): string => {
    const s = md.indexOf("## Contents\n");
    return s < 0 ? "" : md.slice(s + "## Contents\n".length).trimEnd();
  };

  beforeAll(async () => {
    harness = await createTestWiki([...architecturePageTypes, Toc]);
    wiki = harness.wiki;
    ws = await wiki.createWorkspace({ name: "Arch + TOC" });
  });

  afterAll(async () => {
    await harness.stop();
  });

  it("renders architecture nodes as entries of their toc parent, reflowing on rename", async () => {
    const toc = (await ws.createPage("toc", { title: "Architecture Overview", parentId: null })).value;
    const node = (await ws.createPage("architecture", { title: "Engine", parentId: toc })).value;
    expect(contents(await ws.toMarkdown(toc))).toBe("- Engine");
    await ws.setPageTitle(node, "The Engine");
    expect(contents(await ws.toMarkdown(toc))).toBe("- The Engine");
  });

  it("rejects a dependency to a non-architecture (toc) page", async () => {
    const other = (await ws.createPage("toc", { title: "Other index", parentId: null })).value;
    const node = (await ws.createPage("architecture", { title: "Module", parentId: null })).value;
    await expect(ws.mutate(node, "addDependency", { targetId: String(other), role: "depends-on" })).rejects.toThrow();
  });
});

describe("architecture: declared field constraints hold even on auto-generated structural commands", () => {
  let harness: ITestWiki;
  let wiki: IWiki;
  let ws: IWorkspaceHandle;
  let node: PageId;

  beforeAll(async () => {
    harness = await createTestWiki(architecturePageTypes);
    wiki = harness.wiki;
    ws = await wiki.createWorkspace({ name: "Arch constraints" });
    node = (await ws.createPage("architecture", { title: "Node", parentId: null })).value;
  });

  afterAll(async () => {
    await harness.stop();
  });

  it("enforces the kind enum on the generated setSummaryKind (not just the curated setKind)", async () => {
    await expect(ws.mutate(node, "setSummaryKind", { value: "not-a-kind" })).rejects.toThrow();
    await ws.mutate(node, "setSummaryKind", { value: "service" }); // a valid enum value still works
    expect(block(await ws.toMarkdown(node), "Kind")).toBe("service");
  });

  it("enforces a required element field on the generated addElement (codeRef.file)", async () => {
    await expect(
      ws.mutate(node, "addCodeReferencesItemsElement", { fields: { kind: { kind: "scalar", value: "function" } } }),
    ).rejects.toThrow();
  });

  it("enforces an element-field enum (incl. empty) on the generated setElementField", async () => {
    const target = (await ws.createPage("architecture", { title: "Target", parentId: null })).value;
    const dp = (await ws.mutate(node, "addDependency", { targetId: String(target), role: "calls" })).value as {
      dependencyId: string;
    };
    await expect(ws.mutate(node, "setDependenciesItemsRole", { id: dp.dependencyId, value: "not-a-role" })).rejects.toThrow();
    // A REQUIRED enum element field also rejects "" — element fields are never materialized, so an
    // empty there is a real, invalid value (unlike a materialized-empty section scalar).
    await expect(ws.mutate(node, "setDependenciesItemsRole", { id: dp.dependencyId, value: "" })).rejects.toThrow();
    await ws.mutate(node, "setDependenciesItemsRole", { id: dp.dependencyId, value: "owns" }); // a valid value still works
  });
});
