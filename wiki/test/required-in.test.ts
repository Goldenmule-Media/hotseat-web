/**
 * `requiredIn` — the engine's declared authored-ness gate (the dual of `mutableIn`).
 *
 * A field decl's `requiredIn: [statuses]` makes the engine enforce, on the write-side
 * dry-run post-state, that the field is AUTHORED (carries real content) whenever the page
 * is in one of those statuses — so a transition INTO a gated status rejects while content
 * is missing (with the missing `section.field` paths named), a write that would BLANK a
 * gated field while in such a status rejects (including via generated structural
 * commands), and `describeMutations` surfaces the gate predictively on transition edges.
 * Models declare WHICH fields matter per status; nothing is hand-rolled.
 *
 * Covers: the gate + unmet naming, per-kind authored-ness (scalar/prose/list), the
 * generated-command path, batch set+transition, and the three load-time lints
 * (unknown status / initial status / element field).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { arg, definePageType, t } from "../src/authoring";
import { z, zodSchema } from "../src/authoring";
import { Registry } from "../src/core/registry";
import { ValidationError } from "../src/core/errors";
import type { IWiki, IWorkspaceHandle } from "../src/api";
import { createTestWiki, type ITestWiki } from "../src/testing";

const empty = z.object({});

/** A minimal gated type: a scalar + a prose + a list, all required once `sealed`. */
const Memo = definePageType({
  type: "memo",
  version: 1,
  initialStatus: "draft",
  statusTransitions: [t("draft", "seal", "sealed"), t("sealed", "reopen", "draft")],
  sections: {
    head: {
      name: "Head",
      required: true,
      mutableIn: ["draft", "sealed"],
      fields: {
        owner: { kind: "scalar", required: true, requiredIn: ["sealed"] },
        body: { kind: "prose", required: true, requiredIn: ["sealed"] },
      },
    },
    points: {
      name: "Points",
      required: true,
      mutableIn: ["draft"],
      fields: { items: { kind: "list", element: "point", requiredIn: ["sealed"] } },
    },
  },
  elements: {
    point: { fields: { text: { kind: "prose", required: true } } },
  },
  sectionSet: { mode: "closed" },
  commands: {
    setOwner: {
      args: zodSchema(z.object({ owner: z.string() })),
      target: { section: "head", field: "owner" },
      set: { owner: arg("owner") },
    },
    setBody: {
      args: zodSchema(z.object({ text: z.string() })),
      target: { section: "head", field: "body" },
      set: { body: arg("text") },
    },
    addPoint: {
      args: zodSchema(z.object({ text: z.string() })),
      result: zodSchema(z.object({ pointId: z.string() })),
      target: { section: "points", field: "items" },
      set: { text: arg("text") },
    },
    seal: { args: zodSchema(empty), transition: { level: "page", event: "seal" } },
    reopen: { args: zodSchema(empty), transition: { level: "page", event: "reopen" } },
  },
  render: {
    title: "{title}",
    sections: [
      { section: "head", heading: "Head", field: "body", as: "block", placeholder: "_None._" },
      { section: "points", heading: "Points", field: "items", as: "bullets", item: "{text}" },
    ],
  },
});

describe("requiredIn: the engine-enforced authored-ness gate", () => {
  let harness: ITestWiki;
  let wiki: IWiki;
  let ws: IWorkspaceHandle;

  beforeAll(async () => {
    harness = await createTestWiki([Memo]);
    wiki = harness.wiki;
    ws = await wiki.createWorkspace({ name: "Memos" });
  });

  afterAll(async () => {
    await harness.stop();
  });

  it("blocks the transition into a gated status, naming every missing section.field", async () => {
    const memo = (await ws.createPage("memo", { title: "q3 plan", parentId: null })).value;
    await expect(ws.mutate(memo, "seal", {})).rejects.toThrow(
      /author head\.owner, head\.body, points\.items — required in status "sealed"/,
    );
    // describeMutations surfaces the same gate predictively (the edge is FSM-legal).
    const desc = await (await ws.page(memo)).describeMutations();
    const seal = desc.find((d) => d.name === "seal");
    expect(seal?.available).toBe(false);
    expect(seal?.unmet).toMatch(/head\.owner, head\.body, points\.items/);
  });

  it("opens once every gated field is authored — scalar, prose, AND non-empty list", async () => {
    const memo = (await ws.createPage("memo", { title: "q4 plan", parentId: null })).value;
    await ws.mutate(memo, "setOwner", { owner: "Ben" });
    await ws.mutate(memo, "setBody", { text: "Ship it." });
    // list still empty → still blocked, naming only the list.
    await expect(ws.mutate(memo, "seal", {})).rejects.toThrow(/author points\.items — required/);
    await ws.mutate(memo, "addPoint", { text: "First point." });
    await ws.mutate(memo, "seal", {});
    const desc = await (await ws.page(memo)).describeMutations();
    expect(desc.find((d) => d.name === "seal")?.available).toBe(false); // already sealed (FSM)
  });

  it("rejects blanking a gated field while IN the gated status — curated and generated commands alike", async () => {
    const memo = (await ws.createPage("memo", { title: "q5 plan", parentId: null })).value;
    await ws.mutate(memo, "setOwner", { owner: "Ben" });
    await ws.mutate(memo, "setBody", { text: "Hold the line." });
    await ws.mutate(memo, "addPoint", { text: "Only point." });
    await ws.mutate(memo, "seal", {});

    // Curated command (head is mutable in sealed — the WRITE is legal; the BLANK is not).
    await expect(ws.mutate(memo, "setOwner", { owner: "" })).rejects.toThrow(/head\.owner/);
    // Generated structural command (the auto-derived setHeadOwner) — same gate, same path.
    await expect(
      ws.mutate(memo, "setHeadOwner" as never, { value: { kind: "scalar", value: "" } } as never),
    ).rejects.toThrow(/head\.owner/);
    // A non-blanking edit stays legal.
    await ws.mutate(memo, "setOwner", { owner: "Ada" });

    // Back in draft the gate lifts: blanking is legal again.
    await ws.mutate(memo, "reopen", {});
    await ws.mutate(memo, "setOwner", { owner: "" });
  });

  it("lands an author-then-transition batch atomically (each command decided against the fold)", async () => {
    const memo = (await ws.createPage("memo", { title: "q6 plan", parentId: null })).value;
    await ws.mutateMany(memo, [
      { command: "setOwner", args: { owner: "Ben" } },
      { command: "setBody", args: { text: "One commit." } },
      { command: "addPoint", args: { text: "Atomic." } },
      { command: "seal", args: {} },
    ]);
    const desc = await (await ws.page(memo)).describeMutations();
    expect(desc.find((d) => d.name === "reopen")?.available).toBe(true); // sealed reached
  });

  // ── load-time lints ──
  const base = {
    version: 1,
    initialStatus: "draft",
    statusTransitions: [t("draft", "seal", "sealed")],
    sectionSet: { mode: "closed" },
    commands: { seal: { args: zodSchema(empty), transition: { level: "page", event: "seal" } } },
    render: { title: "{title}", sections: [] },
  };

  it("rejects requiredIn naming an unknown status at registration", () => {
    const def = definePageType({
      ...base,
      type: "bad-unknown",
      sections: {
        head: { name: "Head", mutableIn: ["draft"], fields: { owner: { kind: "scalar", requiredIn: ["shipped"] } } },
      },
    } as never);
    expect(() => new Registry([def])).toThrow(ValidationError);
  });

  it("rejects requiredIn naming the INITIAL status (pages are born empty — unsatisfiable)", () => {
    const def = definePageType({
      ...base,
      type: "bad-initial",
      sections: {
        head: { name: "Head", mutableIn: ["draft"], fields: { owner: { kind: "scalar", requiredIn: ["draft"] } } },
      },
    } as never);
    expect(() => new Registry([def])).toThrow(ValidationError);
  });

  it("rejects requiredIn on an ELEMENT field (page-status gates apply to section fields only)", () => {
    const def = definePageType({
      ...base,
      type: "bad-element",
      sections: {
        points: { name: "Points", mutableIn: ["draft"], fields: { items: { kind: "list", element: "point" } } },
      },
      elements: {
        point: { fields: { text: { kind: "prose", requiredIn: ["sealed"] } } },
      },
    } as never);
    expect(() => new Registry([def])).toThrow(ValidationError);
  });
});
