/**
 * `ElementDecl.mutableIn` — the element-status write-gate.
 *
 * A `setElementField` (curated `produces` OR generated `set<Sec><Field><ElField>`) is
 * legal only while the element's FSM status is one the decl lists; evaluation is per op,
 * in op order, against the evolving in-commit state, so a transition earlier in the same
 * command/batch opens the gate for the edits after it. addElement / removeElement /
 * moveElement / element transitions are never gated. Plus the two registration lints.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IWorkspaceHandle, PageId, SectionOp } from "../src/api";
import { arg, definePageType, t, z, zodSchema } from "../src/authoring";
import { MutationNotAllowedError, ValidationError } from "../src/core/errors";
import { Registry } from "../src/core/registry";
import { createTestWiki, type ITestWiki } from "../src/testing";

const Spec = definePageType({
  type: "spec-fixture",
  version: 1,
  initialStatus: "draft",
  statusTransitions: [t("draft", "seal", "sealed")],
  sections: {
    spec: { name: "Spec", required: true, fields: { items: { kind: "list", element: "claim" } } },
  },
  elements: {
    claim: {
      fields: { body: { kind: "prose", required: true } },
      status: {
        initial: "ai-draft",
        transitions: [
          t("ai-draft", "submit", "review"),
          t("review", "reject", "ai-draft"),
          t("review", "approve", "approved"),
        ],
      },
      mutableIn: ["ai-draft"],
    },
  },
  sectionSet: { mode: "closed" },
  commands: {
    addClaim: {
      args: zodSchema(z.object({ body: z.string() })),
      result: zodSchema(z.object({ claimId: z.string() })),
      target: { section: "spec", field: "items" },
      set: { body: arg("body") },
    },
    submitClaim: {
      args: zodSchema(z.object({ claimId: z.string() })),
      target: { section: "spec", field: "items", element: { idArg: "claimId" } },
      transition: { level: "element", event: "submit" },
    },
    rejectClaim: {
      args: zodSchema(z.object({ claimId: z.string() })),
      target: { section: "spec", field: "items", element: { idArg: "claimId" } },
      transition: { level: "element", event: "reject" },
    },
    // Curated edit WITHOUT a transition — must obey the gate.
    rewriteClaim: {
      args: zodSchema(z.object({ claimId: z.string(), body: z.string() })),
      target: { section: "spec", field: "items" },
      produces: (_page, args) => {
        const a = args as { claimId: string; body: string };
        return [
          { op: "setElementField", section: "spec", field: "items", id: a.claimId, elementField: "body", value: { kind: "prose", value: a.body } },
        ];
      },
    },
    // Transition INTO the mutable status, THEN edit — one op list; must pass from `review`.
    rejectAndRewrite: {
      args: zodSchema(z.object({ claimId: z.string(), body: z.string() })),
      target: { section: "spec", field: "items" },
      produces: (_page, args) => {
        const a = args as { claimId: string; body: string };
        return [
          { op: "transition", level: "element", section: "spec", field: "items", element: a.claimId, event: "reject" },
          { op: "setElementField", section: "spec", field: "items", id: a.claimId, elementField: "body", value: { kind: "prose", value: a.body } },
        ];
      },
    },
    // Edit FIRST, transition after — the edit sees the pre-transition status; must reject from `review`.
    rewriteThenReject: {
      args: zodSchema(z.object({ claimId: z.string(), body: z.string() })),
      target: { section: "spec", field: "items" },
      produces: (_page, args) => {
        const a = args as { claimId: string; body: string };
        return [
          { op: "setElementField", section: "spec", field: "items", id: a.claimId, elementField: "body", value: { kind: "prose", value: a.body } },
          { op: "transition", level: "element", section: "spec", field: "items", element: a.claimId, event: "reject" },
        ];
      },
    },
    // addElement then edit the just-added element in one op list — creation-time authoring.
    addAndAnnotate: {
      args: zodSchema(z.object({ body: z.string() })),
      result: zodSchema(z.object({ claimId: z.string() })),
      target: { section: "spec", field: "items" },
      produces: (_page, args, ctx) => {
        const a = args as { body: string };
        const id = ctx.newId();
        const ops: SectionOp[] = [
          { op: "addElement", section: "spec", field: "items", id, fields: { body: { kind: "prose", value: "seed" } } },
          { op: "setElementField", section: "spec", field: "items", id, elementField: "body", value: { kind: "prose", value: a.body } },
        ];
        return ops;
      },
    },
  },
  render: {
    title: "{title}",
    graphSections: false,
    sections: [{ section: "spec", field: "items", as: "bullets", item: "{body}" }],
  },
});

describe("element-status write-gate (ElementDecl.mutableIn)", () => {
  let harness: ITestWiki;
  let ws: IWorkspaceHandle;

  beforeAll(async () => {
    harness = await createTestWiki([Spec]);
    ws = await harness.wiki.createWorkspace({ name: "Gate" });
  });

  afterAll(async () => {
    await harness.stop();
  });

  let seq = 0;
  /** A fresh page with one claim; returns page + claim ids and drives the claim to `status`. */
  async function claimIn(status: "ai-draft" | "review"): Promise<{ page: PageId; claim: string }> {
    const page = (await ws.createPage("spec-fixture", { title: `Spec ${seq++}`, parentId: null })).value;
    const claim = ((await ws.mutate(page, "addClaim", { body: "v1" })).value as { claimId: string }).claimId;
    if (status === "review") await ws.mutate(page, "submitClaim", { claimId: claim });
    return { page, claim };
  }

  async function bodyOf(page: PageId, claim: string): Promise<string> {
    const state = await (await ws.page(page)).state();
    const f = state.sections.find((s) => s.key === "spec")!.fields["items"];
    const el = f!.kind === "list" ? f.elements.find((e) => e.id === claim) : undefined;
    const body = el?.fields["body"];
    return body !== undefined && body.kind === "prose" ? body.value : "";
  }

  it("accepts the generated setElementField command while the element is in an allowed status", async () => {
    const { page, claim } = await claimIn("ai-draft");
    await ws.mutate(page, "setSpecItemsBody", { id: claim, value: { kind: "prose", value: "v2" } });
    expect(await bodyOf(page, claim)).toBe("v2");
  });

  it("rejects the generated setElementField command in a disallowed status, naming id/status/allowed", async () => {
    const { page, claim } = await claimIn("review");
    const attempt = ws.mutate(page, "setSpecItemsBody", { id: claim, value: { kind: "prose", value: "nope" } });
    await expect(attempt).rejects.toThrow(MutationNotAllowedError);
    await expect(attempt).rejects.toThrow(new RegExp(`${claim}.*"review".*ai-draft`));
    expect(await bodyOf(page, claim)).toBe("v1");
  });

  it("rejects a curated (produces) setElementField in a disallowed status", async () => {
    const { page, claim } = await claimIn("review");
    await expect(ws.mutate(page, "rewriteClaim", { claimId: claim, body: "nope" })).rejects.toThrow(
      MutationNotAllowedError,
    );
  });

  it("passes a transition-then-edit sequence in ONE op list (sequential, evolving state)", async () => {
    const { page, claim } = await claimIn("review");
    await ws.mutate(page, "rejectAndRewrite", { claimId: claim, body: "v2 after reject" });
    expect(await bodyOf(page, claim)).toBe("v2 after reject");
  });

  it("rejects an edit-then-transition sequence — the edit sees the pre-transition status", async () => {
    const { page, claim } = await claimIn("review");
    await expect(ws.mutate(page, "rewriteThenReject", { claimId: claim, body: "nope" })).rejects.toThrow(
      MutationNotAllowedError,
    );
    expect(await bodyOf(page, claim)).toBe("v1");
  });

  it("passes a transition-then-edit sequence across an atomic batch (mutateMany)", async () => {
    const { page, claim } = await claimIn("review");
    await ws.mutateMany(page, [
      { command: "rejectClaim", args: { claimId: claim } },
      { command: "setSpecItemsBody", args: { id: claim, value: { kind: "prose", value: "batched" } } },
    ]);
    expect(await bodyOf(page, claim)).toBe("batched");
  });

  it("never gates addElement (a just-added element edits freely in the same op list)", async () => {
    const page = (await ws.createPage("spec-fixture", { title: `Spec ${seq++}`, parentId: null })).value;
    const r = (await ws.mutate(page, "addAndAnnotate", { body: "authored at create" })).value as { claimId: string };
    expect(await bodyOf(page, r.claimId)).toBe("authored at create");
  });

  it("never gates moveElement / removeElement or the element's own transitions", async () => {
    const { page, claim } = await claimIn("review");
    const second = ((await ws.mutate(page, "addClaim", { body: "other" })).value as { claimId: string }).claimId;
    await ws.mutate(page, "moveSpecItemsElement", { id: claim, toIndex: 1 });
    await ws.mutate(page, "rejectClaim", { claimId: claim }); // transition while gated: fine
    await ws.mutate(page, "removeSpecItemsElement", { id: second });
    const state = await (await ws.page(page)).state();
    const f = state.sections.find((s) => s.key === "spec")!.fields["items"];
    expect(f!.kind === "list" ? f.elements.map((e) => e.id) : []).toEqual([claim]);
  });
});

describe("mutableIn registration lints", () => {
  it("rejects mutableIn on an element without a status FSM", () => {
    const def = definePageType({
      type: "gate-no-fsm",
      version: 1,
      initialStatus: "draft",
      statusTransitions: [],
      sections: {
        spec: { name: "Spec", fields: { items: { kind: "list", element: "claim" } } },
      },
      elements: {
        claim: { fields: { body: { kind: "prose" } }, mutableIn: ["ai-draft"] },
      },
      sectionSet: { mode: "closed" },
      commands: {},
      render: { title: "{title}", sections: [] },
    } as never);
    expect(() => new Registry([def])).toThrow(ValidationError);
  });

  it("rejects mutableIn naming a status outside the element FSM", () => {
    const def = definePageType({
      type: "gate-bad-status",
      version: 1,
      initialStatus: "draft",
      statusTransitions: [],
      sections: {
        spec: { name: "Spec", fields: { items: { kind: "list", element: "claim" } } },
      },
      elements: {
        claim: {
          fields: { body: { kind: "prose" } },
          status: { initial: "ai-draft", transitions: [t("ai-draft", "submit", "review")] },
          mutableIn: ["ai-draft", "not-a-status"],
        },
      },
      sectionSet: { mode: "closed" },
      commands: {},
      render: { title: "{title}", sections: [] },
    } as never);
    expect(() => new Registry([def])).toThrow(ValidationError);
  });

  it("accepts a gate naming real element-FSM statuses", () => {
    expect(() => new Registry([Spec])).not.toThrow();
  });
});
