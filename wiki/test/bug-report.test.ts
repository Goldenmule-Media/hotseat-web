/**
 * `bug-report` page type — defects as FSM-governed wiki pages.
 *
 * Exercises the draft→open completeness gate (the "required on creation" pieces:
 * component, platform, version, summary), the single-command atomic close (record the
 * fix commit + transition in one op list — a commit-less close is unrepresentable),
 * the reopen→re-close loop (the resolution list keeps the full fix history), the
 * post-close content freeze, and deterministic render.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bugPageTypes } from "wiki-models/bug";
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

/** Create a bug report and author the four create-gate basics (component/platform/version/summary). */
async function makeBug(ws: IWorkspaceHandle, title: string, opts: { open?: boolean } = {}): Promise<PageId> {
  const id = (await ws.createPage("bug-report", { title, parentId: null })).value;
  await ws.mutate(id, "setComponent", { component: "wiki-mcp" });
  await ws.mutate(id, "setPlatform", { platform: "macOS 15" });
  await ws.mutate(id, "setVersion", { version: "0.1.0" });
  await ws.mutate(id, "setSummary", { text: `${title} happens.` });
  if (opts.open) await ws.mutate(id, "open", {});
  return id;
}

describe("bug-report: lifecycle, completeness gate, atomic close, render", () => {
  let harness: ITestWiki;
  let wiki: IWiki;
  let ws: IWorkspaceHandle;

  beforeAll(async () => {
    harness = await createTestWiki([...bugPageTypes]);
    wiki = harness.wiki;
    ws = await wiki.createWorkspace({ name: "Bugs" });
  });

  afterAll(async () => {
    await harness.stop();
  });

  it("is born in draft and cannot open until component/platform/version/summary are authored (engine requiredIn gate)", async () => {
    const bug = (await ws.createPage("bug-report", { title: "crash on save", parentId: null })).value;
    expect(statusOf(await ws.toMarkdown(bug))).toBe("draft");

    // The engine gate's unmet reason names ALL the missing `section.field` paths.
    await expect(ws.mutate(bug, "open", {})).rejects.toThrow(
      /report\.component, report\.platform, report\.version, summary\.body/,
    );

    // Author them one at a time — the reason shrinks as the report completes.
    await ws.mutate(bug, "setComponent", { component: "wiki" });
    await ws.mutate(bug, "setPlatform", { platform: "node 20" });
    await expect(ws.mutate(bug, "open", {})).rejects.toThrow(/report\.version, summary\.body/);
    const desc = await (await ws.page(bug)).describeMutations();
    const open = desc.find((d) => d.name === "open");
    expect(open?.available).toBe(false);
    expect(open?.unmet).toMatch(/report\.version, summary\.body/);

    await ws.mutate(bug, "setVersion", { version: "0.1.0" });
    await ws.mutate(bug, "setSummary", { text: "Saving a page crashes the host." });
    await ws.mutate(bug, "open", {});
    expect(statusOf(await ws.toMarkdown(bug))).toBe("open");

    // The gate also HOLDS while open: blanking a required-in-open field rejects.
    await expect(ws.mutate(bug, "setComponent", { component: "" })).rejects.toThrow(/report\.component/);
  });

  it("close records the fix commit AND transitions in ONE command; a commit-less close is unrepresentable", async () => {
    const bug = await makeBug(ws, "stale token", { open: true });

    // No args → Zod rejects before anything lands; the page stays open, resolution stays empty.
    await expect(ws.mutate(bug, "close", {})).rejects.toThrow();
    let md = await ws.toMarkdown(bug);
    expect(statusOf(md)).toBe("open");
    expect(block(md, "Resolution")).toBe("_None._");

    const { value } = await ws.mutate(bug, "close", { sha: "abc1234", message: "fix stale token rebase" });
    expect((value as { commitId: string }).commitId).toBeTruthy();
    md = await ws.toMarkdown(bug);
    expect(statusOf(md)).toBe("closed");
    expect(block(md, "Resolution")).toBe("- `abc1234` fix stale token rebase");
  });

  it("freezes content when closed; reopen unfreezes; a re-close appends a second fix commit", async () => {
    const bug = await makeBug(ws, "render drift", { open: true });
    await ws.mutate(bug, "addReproStep", { text: "Render the page twice." });
    await ws.mutate(bug, "close", { sha: "1111111", message: "first fix" });

    // closed = frozen: content edits and double-close both reject.
    await expect(ws.mutate(bug, "addReproStep", { text: "too late" })).rejects.toThrow();
    await expect(ws.mutate(bug, "setObserved", { text: "too late" })).rejects.toThrow();
    await expect(ws.mutate(bug, "close", { sha: "2222222", message: "again" })).rejects.toThrow();

    // reopen → author again → re-close with a SECOND commit; both stay in the history.
    await ws.mutate(bug, "reopen", {});
    expect(statusOf(await ws.toMarkdown(bug))).toBe("open");
    await ws.mutate(bug, "setObserved", { text: "Still drifts on the second render." });
    await ws.mutate(bug, "close", { sha: "3333333", message: "second fix" });
    const md = await ws.toMarkdown(bug);
    expect(statusOf(md)).toBe("closed");
    expect(block(md, "Resolution")).toBe("- `1111111` first fix\n- `3333333` second fix");
    // reopen is the only edge out of closed.
    await expect(ws.mutate(bug, "open", {})).rejects.toThrow();
  });

  it("renders the full report deterministically", async () => {
    const bug = await makeBug(ws, "emitter skips archive");
    await ws.mutate(bug, "addReproStep", { text: "Archive a mirrored page." });
    await ws.mutate(bug, "addReproStep", { text: "List the .archived directory." });
    await ws.mutate(bug, "setExpected", { text: "The file moves to .archived." });
    await ws.mutate(bug, "setObserved", { text: "The file is deleted." });
    await ws.mutate(bug, "open", {});

    const md = await ws.toMarkdown(bug);
    expect(await ws.toMarkdown(bug)).toBe(md); // byte-identical re-render (determinism)
    expect(md).toMatch(/^# Bug: emitter skips archive\n/);
    expect(block(md, "Report")).toBe(
      "- **Component:** wiki-mcp\n- **Platform:** macOS 15\n- **Version:** 0.1.0",
    );
    expect(block(md, "Summary")).toBe("emitter skips archive happens.");
    expect(block(md, "Repro steps")).toBe(
      "1. Archive a mirrored page.\n2. List the .archived directory.",
    );
    expect(block(md, "Expected result")).toBe("The file moves to .archived.");
    expect(block(md, "Observed result")).toBe("The file is deleted.");
  });

  it("surfaces `open` as the agent edge via nextActions-style descriptors", async () => {
    const bug = await makeBug(ws, "slow projection");
    const desc = await (await ws.page(bug)).describeMutations();
    const open = desc.find((d) => d.name === "open");
    expect(open?.available).toBe(true);
    expect(open?.agency).toBe("agent");
    // close/reopen carry no agency (closing claims a real fix — never auto-driven).
    expect(desc.find((d) => d.name === "close")?.agency).toBeUndefined();
  });
});
