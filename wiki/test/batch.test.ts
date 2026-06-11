/**
 * Atomic batch mutation (`IWorkspaceHandle.mutateMany`). A batch of page commands
 * is decided by FOLDING each command over an evolving in-flight copy of state, then
 * committed as ONE atomic array-message: order-dependent sequences work (a transition
 * sees a field an earlier command set), the whole batch shares one consistency token,
 * and any rejection aborts the WHOLE batch with nothing committed.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { IWiki, IWorkspaceHandle, PageId } from "../src/api";
import { definePageType, t, arg } from "../src/core/define";
import { BatchCommandError, BatchCommandsError, MutationNotAllowedError } from "../src/core/errors";
import { zodSchema, z } from "../src/schema/zod-adapter";
import { featurePageTypes } from "wiki-models/feature";
import { createTestWiki, type ITestWiki } from "../src/testing";

// A minimal 3-state type with a content field + two chained transitions and NO
// preconditions — so the fold's order-dependence and rollback are testable in isolation.
const Flow = definePageType({
  type: "flow",
  version: 1,
  initialStatus: "a",
  statusTransitions: [t("a", "go1", "b"), t("b", "go2", "c")],
  sections: {
    body: { name: "Body", required: true, mutableIn: ["a", "b", "c"], fields: { text: { kind: "prose" } } },
  },
  commands: {
    setText: { args: zodSchema(z.object({ text: z.string() })), target: { section: "body", field: "text" }, set: { text: arg("text") } },
    go1: { args: zodSchema(z.object({})), transition: { level: "page", event: "go1" } },
    go2: { args: zodSchema(z.object({})), transition: { level: "page", event: "go2" } },
  },
  render: { sections: [{ section: "body", heading: "Body", field: "text", as: "block" }] },
});

describe("mutateMany — atomic, order-dependent single-page batch", () => {
  let harness: ITestWiki;
  let wiki: IWiki;
  let ws: IWorkspaceHandle;
  let page: PageId;

  beforeEach(async () => {
    harness = await createTestWiki([Flow, ...featurePageTypes]);
    wiki = harness.wiki;
    ws = await wiki.createWorkspace({ name: "Batch" });
    page = (await ws.createPage("flow", { title: "F", parentId: null })).value;
  });
  afterEach(async () => {
    await harness.stop();
  });

  it("applies an ordered batch as ONE commit with one token; results align to commands", async () => {
    const before = (await ws.history()).length;
    const { value, token } = await ws.mutateMany(page, [
      { command: "setText", args: { text: "hello" } },
      { command: "go1" },
      { command: "go2" },
    ]);
    expect(value.results).toHaveLength(3);

    // Read-your-writes on the single batch token sees EVERY command's effect.
    const view = await ws.page(page, { consistentWith: token });
    expect(await view.status()).toBe("c");
    expect(await view.toMarkdown()).toContain("hello");

    // The batch's 3 content events landed as one contiguous run past the prior head.
    const after = await ws.history();
    expect(after.length).toBe(before + 3);
    expect(after.slice(before).every((e) => e.meta.command === "mutateMany")).toBe(true);
  });

  it("folds state forward: go2 is illegal alone from 'a' but legal after go1 in the same batch", async () => {
    // go2 alone from the initial status is rejected …
    await expect(ws.mutate(page, "go2", {})).rejects.toBeInstanceOf(MutationNotAllowedError);
    // … but [go1, go2] succeeds because go1's transition is folded before go2 decides.
    const { token } = await ws.mutateMany(page, [{ command: "go1" }, { command: "go2" }]);
    expect(await (await ws.page(page, { consistentWith: token })).status()).toBe("c");
  });

  it("is all-or-nothing: a mid-batch rejection aborts the WHOLE batch, committing nothing", async () => {
    const before = await ws.history();
    // [setText (legal), go2 (illegal from 'a'), setText] — go2 fails at index 1.
    const err = await ws
      .mutateMany(page, [
        { command: "setText", args: { text: "doomed" } },
        { command: "go2" },
        { command: "setText", args: { text: "never" } },
      ])
      .catch((e) => e);
    expect(err).toBeInstanceOf(BatchCommandError);
    expect(err.index).toBe(1);
    expect(err.command).toBe("go2");

    // Nothing committed: history unchanged, status still initial, the index-0 setText
    // that "succeeded" in the fold did NOT persist.
    const after = await ws.page(page);
    expect(await after.status()).toBe("a");
    expect(await after.toMarkdown()).not.toContain("doomed");
    expect((await ws.history()).length).toBe(before.length);
  });

  it("collects EVERY independent failure in one pass: two illegal commands → BatchCommandsError", async () => {
    const before = await ws.history();
    // [go2 (illegal from 'a'), setText (legal), go2 (still illegal — go1 never folded)].
    // Both go2's fail independently; the legal setText between them does not rescue them.
    const err = await ws
      .mutateMany(page, [
        { command: "go2" },
        { command: "setText", args: { text: "doomed" } },
        { command: "go2" },
      ])
      .catch((e) => e);
    expect(err).toBeInstanceOf(BatchCommandsError);
    expect(err.code).toBe("BATCH_COMMAND_FAILED");
    expect(err.failures.map((f: { index: number }) => f.index)).toEqual([0, 2]);
    expect(err.failures.every((f: { command: string }) => f.command === "go2")).toBe(true);
    expect(err.failures[0].cause).toBeInstanceOf(MutationNotAllowedError);
    // Both failures are enumerated in the message, and the legal set rides through.
    expect(err.message).toContain("[0]");
    expect(err.message).toContain("[2]");
    expect(err.message).toContain("go1");
    // Atomic: nothing committed.
    const after = await ws.page(page);
    expect(await after.status()).toBe("a");
    expect(await after.toMarkdown()).not.toContain("doomed");
    expect((await ws.history()).length).toBe(before.length);
  });

  it("still throws the singular BatchCommandError when exactly ONE command fails", async () => {
    const err = await ws
      .mutateMany(page, [{ command: "setText", args: { text: "ok" } }, { command: "go2" }])
      .catch((e) => e);
    expect(err).toBeInstanceOf(BatchCommandError);
    expect(err).not.toBeInstanceOf(BatchCommandsError);
    expect(err.index).toBe(1);
  });

  it("the wrapped error carries the underlying typed cause + legal set", async () => {
    const err = await ws.mutateMany(page, [{ command: "go2" }]).catch((e) => e);
    expect(err).toBeInstanceOf(BatchCommandError);
    expect(err.code).toBe("BATCH_COMMAND_FAILED");
    expect(err.index).toBe(0);
    expect(err.cause).toBeInstanceOf(MutationNotAllowedError);
    // The legal set rides through in the message (e.g. "Allowed: [..., go1, ...]").
    expect(err.message).toContain("go1");
  });

  it("a single-element batch behaves like mutate", async () => {
    const { value, token } = await ws.mutateMany(page, [{ command: "setText", args: { text: "solo" } }]);
    expect(value.results).toHaveLength(1);
    expect(await (await ws.page(page, { consistentWith: token })).toMarkdown()).toContain("solo");
  });

  it("a batched cascadeFinalize command (ship) finalizes every pinned child in the one commit", async () => {
    // Mirror the sign-off setup: drive the bundle to `review` with every ship gate met.
    const brief = (await ws.createPage("feature-brief", { title: "Cascade", parentId: null })).value;
    const kids = await (await ws.page(brief)).children();
    const plan = kids.find((k) => k.type === "implementation-plan")!.id;
    const testPlan = kids.find((k) => k.type === "testing-plan")!.id;
    const spec = kids.find((k) => k.type === "feature-spec")!.id;
    const q1 = ((await ws.mutate(brief, "askQuestion", { text: "Which formats?" })).value as { questionId: string }).questionId;
    await ws.mutate(brief, "answerQuestion", { questionId: q1, answer: "CSV/JSON." });
    await ws.mutate(brief, "beginPlanning", {});
    const step = ((await ws.mutate(plan, "addStep", { text: "Stream it" })).value as { stepId: string }).stepId;
    await ws.mutate(plan, "addDataModel", { language: "ts", source: "interface E {}" });
    const cs = ((await ws.mutate(testPlan, "addCase", { text: "fast" })).value as { caseId: string }).caseId;
    await ws.mutate(brief, "beginImplementation", {});
    await ws.mutate(plan, "markStepDone", { stepId: step });
    await ws.mutate(testPlan, "markCasePassed", { caseId: cs });
    await ws.mutate(brief, "submitForReview", {});
    await ws.mutate(spec, "addDecision", { questionId: q1, text: "v1 ships CSV and JSON." });

    const before = (await ws.history()).length;
    // Ship via the BATCH path — the cross-page child finalizes must ride inside the
    // batch's single atomic commit (proves the fold resolves child pageId/schemaVersion).
    const { token } = await ws.mutateMany(brief, [{ command: "ship" }]);
    const at = { consistentWith: token };
    expect(await (await ws.page(brief, at)).status()).toBe("shipped");
    expect(await (await ws.page(plan, at)).status()).toBe("ready");
    expect(await (await ws.page(testPlan, at)).status()).toBe("ready");
    expect(await (await ws.page(spec, at)).status()).toBe("sealed");
    // One brief ship + three child finalize events, all in one commit.
    expect((await ws.history()).length).toBe(before + 4);
  });

  it("populates a real feature-brief bundle page in one commit (the motivating case)", async () => {
    const brief = (await ws.createPage("feature-brief", { title: "Demo", parentId: null })).value;
    const before = (await ws.history()).length;
    const { value, token } = await ws.mutateMany(brief, [
      { command: "setSummary", args: { text: "A batched brief." } },
      { command: "addComponent", args: { name: "engine" } },
      { command: "addComponent", args: { name: "mcp" } },
      { command: "addConstraint", args: { text: "atomic" } },
    ]);
    expect(value.results).toHaveLength(4);
    // addComponent returns its created id — proves per-command results flow through.
    expect(value.results[1]).toMatchObject({ componentId: expect.any(String) });

    const md = await (await ws.page(brief, { consistentWith: token })).toMarkdown();
    expect(md).toContain("A batched brief.");
    expect(md).toContain("engine");
    expect(md).toContain("atomic");
    // 4 commands → 4 content events in a single contiguous commit run.
    expect((await ws.history()).length).toBe(before + 4);
  });
});
