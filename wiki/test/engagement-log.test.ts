/**
 * `engagement-log` page type — one counterparty thread as a dated, newest-first log.
 *
 * Exercises the ordering contract (`recordEntry` inserts at the TOP, so the log reads
 * newest-first without any render-side sort), the `decide` completeness gate (the
 * disposition rides in the same atomic op list as the transition, so a thread cannot be
 * concluded without saying how), the element FSMs behind the two checklists (action
 * items and on-deck prompts) and their `awaitsHuman` classification, and deterministic
 * render.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { engagementPageTypes } from "wiki-models/engagement";
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

async function makeLog(ws: IWorkspaceHandle, title: string, kind = "person"): Promise<PageId> {
  const id = (await ws.createPage("engagement-log", { title, parentId: null })).value;
  await ws.mutate(id, "setKind", { kind });
  return id;
}

describe("engagement-log: newest-first ordering, decide gate, element FSMs, render", () => {
  let harness: ITestWiki;
  let wiki: IWiki;
  let ws: IWorkspaceHandle;

  beforeAll(async () => {
    harness = await createTestWiki([...engagementPageTypes]);
    wiki = harness.wiki;
    ws = await wiki.createWorkspace({ name: "Personal" });
  });

  afterAll(async () => {
    await harness.stop();
  });

  it("registers and is born active", async () => {
    const log = await makeLog(ws, "Josh");
    expect(statusOf(await ws.toMarkdown(log))).toBe("active");
  });

  it("records entries NEWEST FIRST regardless of the order they are written", async () => {
    const log = await makeLog(ws, "Brad");
    // Written oldest-first, as an importer walking a file top-to-bottom would NOT do.
    await ws.mutate(log, "recordEntry", { date: "2021-01-13", notes: "- Analytics package" });
    await ws.mutate(log, "recordEntry", { date: "2021-01-20", notes: "- Kinesis is not in BoB" });
    await ws.mutate(log, "recordEntry", { date: "2021-01-27", notes: "- M1 defaults to desktop" });

    const entries = block(await ws.toMarkdown(log), "Entries");
    const order = [...entries.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
    // Each insert goes to index 0, so the LAST written is the first rendered.
    expect(order).toEqual(["2021-01-27", "2021-01-20", "2021-01-13"]);
  });

  it("renders an entry's attendees, prep and notes as labelled body parts, omitting empties", async () => {
    const log = await makeLog(ws, "Sarah Bly");
    // Fed oldest-first, the way an importer must feed them: each insert lands at index 0,
    // so the newest ends up on top.
    await ws.mutate(log, "recordEntry", { date: "10/05/2023", notes: "- Need to move forward." });
    await ws.mutate(log, "recordEntry", {
      date: "10/26/2023",
      attendees: "Ben, Sarah",
      prep: "- Transition\n- AWS bills",
      notes: "- Very thorough, nothing outstanding.",
    });

    const entries = block(await ws.toMarkdown(log), "Entries");
    expect(entries).toContain("### 10/26/2023");
    expect(entries).toContain("**Attendees:** Ben, Sarah");
    expect(entries).toContain("**Prep:**");
    expect(entries).toContain("Very thorough");
    // The entry with no attendees/prep renders neither label.
    expect(entries.indexOf("### 10/26/2023")).toBeLessThan(entries.indexOf("### 10/05/2023"));
    const second = entries.slice(entries.indexOf("### 10/05/2023"));
    expect(second).not.toContain("**Attendees:**");
    expect(second).not.toContain("**Prep:**");
    // A labelled BLOCK body takes its own line, so the bullet list survives intact.
    expect(entries).toContain("**Prep:**\n\n- Transition\n- AWS bills");
  });

  it("refuses `decide` until a disposition is authored, then records it atomically", async () => {
    const log = await makeLog(ws, "Thiago Marcal", "candidate");

    // `decide` carries the disposition in its own args, so the gate is unrepresentable-by-
    // construction rather than a rejection — but the schema still refuses a bogus value.
    await expect(ws.mutate(log, "decide", { disposition: "maybe" } as never)).rejects.toThrow();

    await ws.mutate(log, "decide", { disposition: "no-hire", note: "Strong on systems, thin on product." });
    const md = await ws.toMarkdown(log);
    expect(statusOf(md)).toBe("decided");
    expect(block(md, "Outcome")).toContain("**Disposition:** no-hire");
    expect(block(md, "Outcome")).toContain("Strong on systems");
  });

  it("reopens a decided thread and takes a later entry", async () => {
    const log = await makeLog(ws, "George Gilmartin", "candidate");
    await ws.mutate(log, "decide", { disposition: "pass" });
    expect(statusOf(await ws.toMarkdown(log))).toBe("decided");

    await ws.mutate(log, "reopen", {});
    await ws.mutate(log, "recordEntry", { date: "2022-04-01", notes: "- Re-opened for the platform req." });
    const md = await ws.toMarkdown(log);
    expect(statusOf(md)).toBe("active");
    expect(block(md, "Entries")).toContain("Re-opened for the platform req.");
  });

  it("drives action items through their element FSM and renders them as a checklist", async () => {
    const log = await makeLog(ws, "Facundo");
    const a = (await ws.mutate(log, "addActionItem", { text: "Ship Zack a computer", on: "2019-10-21" }))
      .value as { itemId: string };
    const b = (await ws.mutate(log, "addActionItem", { text: "Chase the React upgrade" })).value as {
      itemId: string;
    };

    let items = block(await ws.toMarkdown(log), "Action items");
    expect(items).toContain("- [ ] Ship Zack a computer");
    expect(items).toContain("- [ ] Chase the React upgrade");

    await ws.mutate(log, "completeActionItem", { itemId: a.itemId });
    await ws.mutate(log, "dropActionItem", { itemId: b.itemId });

    items = block(await ws.toMarkdown(log), "Action items");
    expect(items).toContain("- [x] Ship Zack a computer");
    // `dropped` is not the checked status, so a dropped item stays unchecked.
    expect(items).toContain("- [ ] Chase the React upgrade");
  });

  it("flags open action items and unraised on-deck prompts as awaiting a human", async () => {
    const log = await makeLog(ws, "Reinaldo");
    const item = (await ws.mutate(log, "addActionItem", { text: "Get his tech goals written down" }))
      .value as { itemId: string };
    const prompt = (await ws.mutate(log, "addOnDeck", { text: "Ask about the equity conversation" }))
      .value as { promptId: string };

    const waiting = await (await ws.page(log)).attentionItems();
    expect(waiting.map((i) => i.elementId)).toEqual(
      expect.arrayContaining([item.itemId, prompt.promptId]),
    );

    // Ticking both clears them from the attention roll-up.
    await ws.mutate(log, "completeActionItem", { itemId: item.itemId });
    await ws.mutate(log, "raiseOnDeck", { promptId: prompt.promptId });
    expect(await (await ws.page(log)).attentionItems()).toHaveLength(0);
  });

  it("has no agent-drivable forward edge — every transition is a human decision", () => {
    const fsm = wiki.fsmOf("engagement-log");
    expect(fsm.transitions.every((tr) => tr.meta?.agency !== "agent")).toBe(true);
    // …and no self-loop that would make a self-directing loop spin.
    expect(fsm.transitions.every((tr) => tr.from !== tr.to)).toBe(true);
  });

  it("renders byte-identically for equal state", async () => {
    const one = await makeLog(ws, "Determinism A");
    const two = await makeLog(ws, "Determinism B");
    for (const id of [one, two]) {
      await ws.mutate(id, "setContext", { text: "Same context." });
      await ws.mutate(id, "recordEntry", { date: "2024-01-01", notes: "- Same notes." });
      await ws.mutate(id, "addActionItem", { text: "Same item" });
    }
    const a = (await ws.toMarkdown(one)).replace("Determinism A", "X");
    const b = (await ws.toMarkdown(two)).replace("Determinism B", "X");
    expect(a).toBe(b);
  });
});
