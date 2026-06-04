/**
 * feature-spec page + cross-page element `ref` (feature-review.md Item 1).
 *
 * Exercises the engine primitive (an element-addressable, CROSS-PAGE ref + its
 * integrity check + render-derived label) end-to-end through the model:
 *   - addDecision threads an inline `ref` from the spec to a resolved brief question,
 *   - ref integrity rejects a decision pointing at a non-existent question,
 *   - the `seal` gate (reference-completeness) blocks until EVERY resolved decision is
 *     referenced, then succeeds — and reopens,
 *   - the spec renders each decision with the question's text as the ref's label
 *     (cross-page, label-field driven, deterministic).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IWiki, IWorkspaceHandle, PageId } from "../src/api";
import { PreconditionUnmetError, RefIntegrityError } from "../src/core/errors";
import { featurePageTypes } from "wiki-models/feature";
import { createTestWiki, type ITestWiki } from "../src/testing";

describe("feature-spec: cross-page decision refs + reference-completeness seal", () => {
  let harness: ITestWiki;
  let wiki: IWiki;
  let ws: IWorkspaceHandle;
  let brief: PageId;
  let spec: PageId;
  let q1: string;
  let q2: string;

  beforeAll(async () => {
    harness = await createTestWiki(featurePageTypes);
    wiki = harness.wiki;
    ws = await wiki.createWorkspace({ name: "Spec" });
    const c = await ws.createPage("feature-brief", { title: "Bulk export", parentId: null });
    brief = c.value;
    spec = (await (await ws.page(brief, { consistentWith: c.token })).children())
      .find((ch) => ch.type === "feature-spec")!.id;

    // Two decided questions on the brief (resolved), plus one left open.
    q1 = ((await ws.mutate(brief, "askQuestion", { text: "Which formats in v1?" })).value as { questionId: string }).questionId;
    q2 = ((await ws.mutate(brief, "askQuestion", { text: "Server or client engine?" })).value as { questionId: string }).questionId;
    await ws.mutate(brief, "askQuestion", { text: "Pagination while streaming?" }); // stays open — not a decision
    await ws.mutate(brief, "answerQuestion", { questionId: q1, answer: "CSV and JSON." });
    await ws.mutate(brief, "answerQuestion", { questionId: q2, answer: "Client-side engine." });
  });

  afterAll(async () => {
    await harness.stop();
  });

  it("rejects a decision whose ref points at a non-existent question (cross-page ref integrity)", async () => {
    await expect(
      ws.mutate(spec, "addDecision", { questionId: "question:does-not-exist", text: "bogus" }),
    ).rejects.toBeInstanceOf(RefIntegrityError);
  });

  it("blocks `seal` until EVERY resolved decision is referenced, then seals", async () => {
    // Nothing referenced yet → both resolved decisions are missing.
    await expect(ws.mutate(spec, "seal", {})).rejects.toBeInstanceOf(PreconditionUnmetError);

    // Reference q1 only → still one decision unreferenced.
    await ws.mutate(spec, "addDecision", { questionId: q1, text: "Export supports CSV and JSON." });
    await expect(ws.mutate(spec, "seal", {})).rejects.toBeInstanceOf(PreconditionUnmetError);

    // Reference q2 → every resolved decision is now threaded in → seal succeeds.
    await ws.mutate(spec, "addDecision", { questionId: q2, text: "The engine runs client-side." });
    const sealed = await ws.mutate(spec, "seal", {});
    expect(await (await ws.page(spec, { consistentWith: sealed.token })).status()).toBe("sealed");

    // The open (undecided) question is NOT required — seal succeeded with it still open.
    const reopened = await ws.mutate(spec, "reopen", {});
    expect(await (await ws.page(spec, { consistentWith: reopened.token })).status()).toBe("drafting");
  });

  it("renders each decision with the referenced question's text as the ref label (cross-page, deterministic)", async () => {
    const md = await ws.toMarkdown(spec);
    expect(await ws.toMarkdown(spec)).toBe(md); // determinism
    // The decision prose is followed by the cross-page label = the question's `text`.
    expect(md).toContain("Export supports CSV and JSON. Which formats in v1?");
    expect(md).toContain("The engine runs client-side. Server or client engine?");
  });
});
