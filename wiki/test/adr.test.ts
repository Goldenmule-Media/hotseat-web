/**
 * `decision-record` (ADR) page type — decisions as first-class, FSM-governed wiki pages.
 *
 * Exercises the testing-plan for the "ADR page type" feature: the proposed→accepted→superseded
 * lifecycle, the integrity-checked `supersededBy` edge (the load-bearing decision), the
 * two-op atomic supersession batch, the dissolved "ADR-M7" collision, deterministic render,
 * and that the bundle loads via its default-exported array with the engine staying schema-
 * agnostic (only the generic `kindFor` ref-sugar, covered by ref-set-sugar.test.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { adrPageTypes } from "wiki-models/adr";
import { Toc } from "wiki-models/toc";
import type { IWiki, IWorkspaceHandle, PageId } from "../src/api";
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

/** Create an ADR under `parent`, fill the required content, and (optionally) accept it. */
async function makeAdr(
  ws: IWorkspaceHandle,
  parent: PageId,
  title: string,
  opts: { date?: string; scope?: string; legacyId?: string; accept?: boolean } = {},
): Promise<PageId> {
  const id = (await ws.createPage("decision-record", { title, parentId: parent })).value;
  await ws.mutate(id, "setDate", { date: opts.date ?? "2026-06-05" });
  if (opts.scope !== undefined) await ws.mutate(id, "setScope", { scope: opts.scope });
  if (opts.legacyId !== undefined) await ws.mutate(id, "setLegacyId", { legacyId: opts.legacyId });
  await ws.mutate(id, "setContext", { text: `Why ${title}.` });
  await ws.mutate(id, "addDecisionBlock", { text: `We will ${title}.` });
  await ws.mutate(id, "addConsequence", { text: `${title} has consequences.` });
  if (opts.accept) await ws.mutate(id, "accept", {});
  return id;
}

describe("decision-record: lifecycle, render, and metadata", () => {
  let harness: ITestWiki;
  let wiki: IWiki;
  let ws: IWorkspaceHandle;
  let container: PageId;

  beforeAll(async () => {
    harness = await createTestWiki([...adrPageTypes, Toc]);
    wiki = harness.wiki;
    ws = await wiki.createWorkspace({ name: "ADRs" });
    container = (await ws.createPage("toc", { title: "Decision Records", parentId: null })).value;
  });

  afterAll(async () => {
    await harness.stop();
  });

  it("renders Nygard sections + a metadata block deterministically; title prefixed 'ADR:'", async () => {
    const adr = await makeAdr(ws, container, "use event sourcing", {
      scope: "wiki",
      legacyId: "wiki/ADR-001",
    });
    await ws.mutate(adr, "addDecider", { name: "Ben" });
    await ws.mutate(adr, "addDecider", { name: "Ada" });
    const md = await ws.toMarkdown(adr);
    expect(await ws.toMarkdown(adr)).toBe(md); // byte-identical re-render (determinism)
    expect(md.startsWith("# ADR: use event sourcing\n")).toBe(true);
    expect(statusOf(md)).toBe("proposed");
    expect(block(md, "Metadata")).toBe(
      "- **Date:** 2026-06-05\n- **Scope:** wiki\n- **Deciders:** Ben, Ada\n- **Legacy ID:** wiki/ADR-001",
    );
    expect(block(md, "Context")).toBe("Why use event sourcing.");
    expect(block(md, "Decision")).toBe("We will use event sourcing.");
    expect(block(md, "Consequences")).toBe("use event sourcing has consequences.");
    expect(block(md, "Relations")).toBe("_None._");
  });

  it("walks proposed → accepted; rejects an off-FSM jump (supersede from proposed)", async () => {
    const adr = await makeAdr(ws, container, "adopt CQRS");
    // supersede is not legal from `proposed`.
    await expect(ws.mutate(adr, "supersede", {})).rejects.toThrow();
    await ws.mutate(adr, "accept", {});
    expect(statusOf(await ws.toMarkdown(adr))).toBe("accepted");
    // accept again is now illegal.
    await expect(ws.mutate(adr, "accept", {})).rejects.toThrow();
  });

  it("proposed → rejected is terminal", async () => {
    const adr = await makeAdr(ws, container, "use XML everywhere");
    await ws.mutate(adr, "reject", {});
    expect(statusOf(await ws.toMarkdown(adr))).toBe("rejected");
    await expect(ws.mutate(adr, "accept", {})).rejects.toThrow();
  });

  it("accepted → deprecated is terminal", async () => {
    const adr = await makeAdr(ws, container, "store blobs in git", { accept: true });
    await ws.mutate(adr, "deprecate", {});
    expect(statusOf(await ws.toMarkdown(adr))).toBe("deprecated");
    await expect(ws.mutate(adr, "supersede", {})).rejects.toThrow();
  });

  it("rejects supersede while supersededBy is unset (namesSuccessor precondition)", async () => {
    const adr = await makeAdr(ws, container, "single ADR workspace", { accept: true });
    await expect(ws.mutate(adr, "supersede", {})).rejects.toThrow(/supersededBy/i);
    // describeMutations surfaces the precondition's reason rather than transitioning.
    const desc = await (await ws.page(adr)).describeMutations();
    const sup = desc.find((d) => d.name === "supersede");
    expect(sup?.available).toBe(false);
    expect(sup?.unmet).toMatch(/supersededBy/i);
  });

  it("rejects setSupersededBy at a non-existent page (engine ref-integrity)", async () => {
    const adr = await makeAdr(ws, container, "use Durable Streams", { accept: true });
    await expect(ws.mutate(adr, "setSupersededBy", { supersededBy: "decision-record:nope" })).rejects.toThrow();
  });

  it("supersedes atomically and renders both directions (Supersedes / Superseded by)", async () => {
    const old = await makeAdr(ws, container, "per-package ADR files", { accept: true });
    const replacement = await makeAdr(ws, container, "one ADR workspace", { accept: true });
    // Two ops, one atomic commit: set the ref, then transition gated on it being a live record.
    await ws.mutateMany(old, [
      { command: "setSupersededBy", args: { supersededBy: String(replacement) } },
      { command: "supersede", args: {} },
    ]);
    const oldMd = await ws.toMarkdown(old);
    const newMd = await ws.toMarkdown(replacement);
    expect(statusOf(oldMd)).toBe("superseded");
    expect(block(oldMd, "Relations")).toBe(`- **Superseded by** → [one ADR workspace](${replacement})`);
    // The reverse view is derived from the incoming ref — no stored back-pointer.
    expect(block(newMd, "Relations")).toBe(`- **Supersedes** → [per-package ADR files](${old})`);
    // The supersede label reflows on rename (render-derived, not stored text).
    await ws.setPageTitle(replacement, "the global ADR workspace");
    expect(block(await ws.toMarkdown(old), "Relations")).toBe(
      `- **Superseded by** → [the global ADR workspace](${replacement})`,
    );
  });

  it("aborts the WHOLE supersession batch if the gate fails — the ref-set does not persist", async () => {
    const adr = await makeAdr(ws, container, "self-supersede attempt", { accept: true });
    // setSupersededBy(self) ingests fine (self exists), but supersede's gate rejects a self-edge,
    // so the batch aborts atomically — the ref must NOT remain committed.
    await expect(
      ws.mutateMany(adr, [
        { command: "setSupersededBy", args: { supersededBy: String(adr) } },
        { command: "supersede", args: {} },
      ]),
    ).rejects.toThrow();
    const md = await ws.toMarkdown(adr);
    expect(statusOf(md)).toBe("accepted"); // not superseded
    expect(block(md, "Relations")).toBe("_None._"); // the ref-set rolled back with the batch
  });

  it("dissolves the historical 'ADR-M7' collision: two records, distinct ids + distinct legacyId", async () => {
    const mcp = await makeAdr(ws, container, "MCP authoring loop", { scope: "wiki-mcp", legacyId: "wiki-mcp/ADR-M7" });
    const models = await makeAdr(ws, container, "page-type bundles", {
      scope: "wiki-models",
      legacyId: "wiki-models/ADR-M7",
    });
    expect(String(mcp)).not.toBe(String(models));
    expect(block(await ws.toMarkdown(mcp), "Metadata")).toContain("**Legacy ID:** wiki-mcp/ADR-M7");
    expect(block(await ws.toMarkdown(models), "Metadata")).toContain("**Legacy ID:** wiki-models/ADR-M7");
  });
});

describe("decision-record: the bundle loads schema-agnostically and exposes its FSM", () => {
  let harness: ITestWiki;
  let wiki: IWiki;

  beforeAll(async () => {
    // Loads via the bundle's DEFAULT-exported array — the ModelRegistry contract — with no
    // engine/host change beyond the generic kindFor ref-sugar.
    harness = await createTestWiki(adrPageTypes);
    wiki = harness.wiki;
  });

  afterAll(async () => {
    await harness.stop();
  });

  it("fsmOf reports the four-transition decision FSM", () => {
    const fsm = wiki.fsmOf("decision-record");
    expect(fsm.initial).toBe("proposed");
    expect([...fsm.states].sort()).toEqual(["accepted", "deprecated", "proposed", "rejected", "superseded"]);
    const edges = fsm.transitions.map((tr) => `${tr.from}-${tr.event}->${tr.to}`).sort();
    expect(edges).toEqual([
      "accepted-deprecate->deprecated",
      "accepted-supersede->superseded",
      "proposed-accept->accepted",
      "proposed-reject->rejected",
    ]);
  });

  it("describeType reports the full curated command set", () => {
    const names = wiki.describeType("decision-record").commands.map((c) => c.name);
    for (const cmd of [
      "setDate", "setScope", "setLegacyId", "addDecider", "removeDecider",
      "setContext", "addDecisionBlock", "addDecisionCode", "addConsequence",
      "accept", "reject", "deprecate", "setSupersededBy", "supersede",
    ]) {
      expect(names).toContain(cmd);
    }
  });
});
