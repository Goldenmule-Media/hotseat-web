/**
 * The ADR migration (wiki-models/scripts/migrate-adrs): parse the five DESIGN.md ADR
 * appendices and write them as `decision-record` pages under a "Decision Records" TOC inside
 * the REPO's wiki workspace (a workspace maps to a repo/product), alongside its other TOCs.
 * Runs the REAL parser over the REAL repo DESIGN.md files against an in-memory wiki, so it both
 * checks the parser against live source and proves the round-trip (incl. the integrity-checked
 * supersession edge, the dissolved ADR-M7 collision, and re-run reset). Deterministic.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { migrateAdrs, migrationPageTypes, parseRepoAdrs, type ParsedAdr } from "wiki-models/scripts/migrate-adrs";
import type { IWiki, IWorkspaceHandle, PageId } from "../src/api";
import { createTestWiki, type ITestWiki } from "../src/testing";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function block(md: string, heading: string): string {
  const start = md.indexOf(`## ${heading}\n`);
  if (start < 0) return "";
  const after = md.slice(start + `## ${heading}\n`.length);
  const end = after.indexOf("\n## ");
  return (end < 0 ? after : after.slice(0, end)).trimEnd();
}
const statusOf = (md: string): string => md.match(/\*\*Status:\*\* (\w+)/)?.[1] ?? "";

describe("ADR migration: parse the DESIGN.md appendices", () => {
  let parsed: ParsedAdr[];

  beforeAll(() => {
    parsed = parseRepoAdrs(REPO_ROOT);
  });

  it("parses all ~28 ADRs across the five packages, in package order", () => {
    const byScope = (scope: string): ParsedAdr[] => parsed.filter((a) => a.scope === scope);
    expect(byScope("wiki").length).toBe(11); // ADR-001…011
    expect(byScope("wiki-mcp").length).toBe(7); // ADR-M1…M7
    expect(byScope("wiki-server").length).toBe(3); // ADR-S1…S3
    expect(byScope("wiki-models").length).toBe(2); // ADR-W1 + ADR-M7
    expect(byScope("wiki-cli").length).toBe(5); // ADR-C1…C5
    expect(parsed.length).toBe(28);
  });

  it("preserves date / scope / legacyId, and a non-empty Context + Decision", () => {
    const a1 = parsed.find((a) => a.legacyId === "wiki/ADR-001");
    expect(a1?.title).toBe("Use Durable Streams directly; no storage port");
    expect(a1?.date).toBe("2026-06-01");
    expect(a1?.scope).toBe("wiki");
    expect(a1!.context.length).toBeGreaterThan(0);
    expect(a1!.decision.length).toBeGreaterThan(0);
  });

  it("the prose's `### ADR-…` is the ONLY identity source — the two ADR-M7 records are distinct", () => {
    const m7 = parsed.filter((a) => a.adrId === "ADR-M7");
    expect(m7.length).toBe(2);
    expect(m7.map((a) => a.legacyId).sort()).toEqual(["wiki-mcp/ADR-M7", "wiki-models/ADR-M7"]);
  });

  it("routes a fenced code block in a decision into a code block (ADR-003 carries the IReadModel snippet)", () => {
    const a3 = parsed.find((a) => a.legacyId === "wiki/ADR-003");
    expect(a3?.decision.some((b) => b.kind === "code")).toBe(true);
    // …and no `prose` block carries a fence (a prose field would be rejected by ingestion).
    expect(parsed.every((a) => a.context.includes("```") === false)).toBe(true);
  });
});

describe("ADR migration: write the records into an ADRs workspace", () => {
  let harness: ITestWiki;
  let wiki: IWiki;
  let ws: IWorkspaceHandle;
  let container: PageId;
  let byLegacy: ReadonlyMap<string, PageId>;
  let superseded: readonly string[];

  let siblingToc: PageId;

  beforeAll(async () => {
    harness = await createTestWiki(migrationPageTypes);
    wiki = harness.wiki;
    // The repo's wiki workspace already holds other TOCs — model that so we prove the ADRs
    // land ALONGSIDE existing content, not in a workspace of their own.
    ws = await wiki.createWorkspace({ name: "wiki" });
    siblingToc = (await ws.createPage("toc", { title: "Architecture", parentId: null })).value;
    const result = await migrateAdrs(ws, parseRepoAdrs(REPO_ROOT));
    container = result.container;
    byLegacy = result.byLegacy;
    superseded = result.superseded;
  });

  afterAll(async () => {
    await harness.stop();
  });

  it("adds a Decision Records TOC alongside the workspace's existing TOCs", async () => {
    const roots = await ws.tree();
    const tops = roots.children.filter((n) => n.archived !== true).map((n) => n.title).sort();
    expect(tops).toEqual(["Architecture", "Decision Records"]);
    expect(siblingToc).not.toBe(container); // coexists, not replaces
  });

  it("creates one decision-record per source ADR (plus the meta-ADR), all under the container", async () => {
    expect(byLegacy.size).toBe(28);
    const children = await (await ws.page(container)).children();
    expect(children.length).toBe(29); // 28 migrated + the meta-ADR
  });

  it("writes the wiki-native meta-ADR first — the one record with NO legacy id", async () => {
    const children = await (await ws.page(container)).children();
    const first = children[0]!;
    const md = await ws.toMarkdown(first.id);
    expect(md.startsWith("# ADR: Design decisions live in the wiki\n")).toBe(true);
    expect(block(md, "Metadata")).not.toContain("Legacy ID"); // born in the wiki — no legacy
    expect(block(md, "Metadata")).toContain("**Deciders:** Ben Jordan");
    expect(statusOf(md)).toBe("accepted");
  });

  it("preserves legacyId / date / scope on a migrated record and accepts it", async () => {
    const md = await ws.toMarkdown(byLegacy.get("wiki-mcp/ADR-M7")!);
    expect(md.startsWith("# ADR: AST/analysis as read-side projections")).toBe(true);
    expect(block(md, "Metadata")).toContain("**Scope:** wiki-mcp");
    expect(block(md, "Metadata")).toContain("**Legacy ID:** wiki-mcp/ADR-M7");
    expect(block(md, "Metadata")).toContain("**Date:** 2026-06-03");
    expect(statusOf(md)).toBe("accepted");
  });

  it("wires the ADR-S1 → ADR-S3 supersession as an integrity-checked, both-directions edge", async () => {
    expect([...superseded]).toEqual(["wiki-server/ADR-S1"]);
    const s1 = byLegacy.get("wiki-server/ADR-S1")!;
    const s3 = byLegacy.get("wiki-server/ADR-S3")!;
    const s1md = await ws.toMarkdown(s1);
    const s3md = await ws.toMarkdown(s3);
    expect(statusOf(s1md)).toBe("superseded");
    expect(block(s1md, "Relations")).toBe(`- **Superseded by** → [wiki-server hosts wiki-mcp](${s3})`);
    expect(block(s3md, "Relations")).toBe(`- **Supersedes** → [Host streams; do not wrap the engine](${s1})`);
  });

  it("is re-runnable IN PLACE: a second migration resets the prior subtree, not duplicates it", async () => {
    const ws2 = await wiki.createWorkspace({ name: "wiki-rerun" });
    const first = await migrateAdrs(ws2, parseRepoAdrs(REPO_ROOT));
    const again = await migrateAdrs(ws2, parseRepoAdrs(REPO_ROOT)); // re-run into the SAME workspace
    expect(again.byLegacy.size).toBe(first.byLegacy.size);
    expect([...again.superseded]).toEqual([...first.superseded]);
    // Exactly ONE active "Decision Records" TOC remains (the prior one was archived + renamed),
    // and it holds the fresh full set; the old subtree is hidden, not duplicated.
    const roots = await ws2.tree();
    const activeContainers = roots.children.filter((n) => n.title === "Decision Records" && n.archived !== true);
    expect(activeContainers.length).toBe(1);
    expect(activeContainers[0]!.id).toBe(again.container);
    const active = await (await ws2.page(again.container)).children();
    expect(active.length).toBe(29);
    // The re-run's supersession still renders both directions on the new records.
    const s1md = await ws2.toMarkdown(again.byLegacy.get("wiki-server/ADR-S1")!);
    expect(statusOf(s1md)).toBe("superseded");
  });
});
