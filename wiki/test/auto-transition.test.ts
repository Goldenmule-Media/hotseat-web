/**
 * `autoTransitions` — a page status DERIVED from content.
 *
 * After every page command the engine evaluates each declared `when` on the post-state and
 * fires the first whose edge is legal from the post-state status, in the SAME commit. Both
 * directions are declared here ("every claim approved → complete", "one is not → back to
 * drafting"), so the status is a pure function of the list and no command has to remember
 * to move it. Plus the registration lint for an event no edge declares.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { DeepReadonly, IWorkspaceHandle, PageId, PageState } from "../src/api";
import { arg, definePageType, t, z, zodSchema } from "../src/authoring";
import { ValidationError } from "../src/core/errors";
import { Registry } from "../src/core/registry";
import { createTestWiki, type ITestWiki } from "../src/testing";

/** The claims list, as the auto-transition predicates see it. */
function claims(page: DeepReadonly<PageState>): readonly { readonly status?: string }[] {
  const f = page.sections.find((s) => s.key === "spec")?.fields["items"];
  return f !== undefined && f.kind === "list" ? f.elements : [];
}
const allApproved = (page: DeepReadonly<PageState>): boolean => {
  const xs = claims(page);
  return xs.length > 0 && xs.every((c) => c.status === "approved");
};

const Spec = definePageType({
  type: "auto-fixture",
  version: 1,
  initialStatus: "drafting",
  statusTransitions: [
    t("drafting", "claimsComplete", "complete"),
    t("complete", "claimsReopened", "drafting"),
    t("complete", "ship", "shipped", { agency: "human" }),
  ],
  autoTransitions: [
    { event: "claimsComplete", when: allApproved },
    { event: "claimsReopened", when: (page) => !allApproved(page) },
  ],
  sections: {
    spec: {
      name: "Spec",
      required: true,
      mutableIn: ["drafting", "complete"],
      fields: { items: { kind: "list", element: "claim" } },
    },
  },
  elements: {
    claim: {
      fields: { body: { kind: "prose", required: true } },
      status: {
        initial: "open",
        transitions: [t("open", "approve", "approved"), t("approved", "reopen", "open")],
      },
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
    approveClaim: {
      args: zodSchema(z.object({ claimId: z.string() })),
      target: { section: "spec", field: "items", element: { idArg: "claimId" } },
      transition: { level: "element", event: "approve" },
    },
    reopenClaim: {
      args: zodSchema(z.object({ claimId: z.string() })),
      target: { section: "spec", field: "items", element: { idArg: "claimId" } },
      transition: { level: "element", event: "reopen" },
    },
    ship: {
      args: zodSchema(z.object({})),
      transition: { level: "page", event: "ship" },
    },
  },
  render: {
    title: "{title}",
    graphSections: false,
    sections: [{ section: "spec", field: "items", as: "bullets", item: "{body}" }],
  },
});

describe("autoTransitions — a status derived from content", () => {
  let harness: ITestWiki;
  let ws: IWorkspaceHandle;

  beforeAll(async () => {
    harness = await createTestWiki([Spec]);
    ws = await harness.wiki.createWorkspace({ name: "Auto" });
  });

  afterAll(async () => {
    await harness.stop();
  });

  let seq = 0;
  const statusOf = async (page: PageId): Promise<string> => (await (await ws.page(page)).state()).status;
  const addClaim = async (page: PageId, body: string): Promise<string> =>
    ((await ws.mutate(page, "addClaim", { body })).value as { claimId: string }).claimId;

  async function fresh(): Promise<PageId> {
    return (await ws.createPage("auto-fixture", { title: `Spec ${seq++}`, parentId: null })).value;
  }

  it("fires in the commit that completes the content — no second command", async () => {
    const page = await fresh();
    const a = await addClaim(page, "one");
    const b = await addClaim(page, "two");
    expect(await statusOf(page)).toBe("drafting");

    await ws.mutate(page, "approveClaim", { claimId: a });
    expect(await statusOf(page)).toBe("drafting"); // one still open

    await ws.mutate(page, "approveClaim", { claimId: b });
    expect(await statusOf(page)).toBe("complete");
  });

  it("fires the opposite edge when the content stops qualifying", async () => {
    const page = await fresh();
    const a = await addClaim(page, "only");
    await ws.mutate(page, "approveClaim", { claimId: a });
    expect(await statusOf(page)).toBe("complete");

    await ws.mutate(page, "reopenClaim", { claimId: a });
    expect(await statusOf(page)).toBe("drafting");
  });

  it("an ADDED unapproved element drops a complete page back", async () => {
    const page = await fresh();
    const a = await addClaim(page, "first");
    await ws.mutate(page, "approveClaim", { claimId: a });
    expect(await statusOf(page)).toBe("complete");

    await addClaim(page, "late arrival");
    expect(await statusOf(page)).toBe("drafting");
  });

  it("an empty list does not qualify — vacuous truth is not completion", async () => {
    const page = await fresh();
    expect(await statusOf(page)).toBe("drafting");
  });

  it("a page whose content already qualifies catches up on its next command", async () => {
    // The engine only ever moves on a command: a page that qualified before the rule existed
    // (or before an unrelated edit) advances on the next one, not spontaneously.
    const page = await fresh();
    const a = await addClaim(page, "one");
    await ws.mutate(page, "approveClaim", { claimId: a });
    expect(await statusOf(page)).toBe("complete");
  });

  it("leaves a status the FSM does not declare the edge from alone", async () => {
    const page = await fresh();
    const a = await addClaim(page, "only");
    await ws.mutate(page, "approveClaim", { claimId: a });
    await ws.mutate(page, "ship", {});
    expect(await statusOf(page)).toBe("shipped");

    // `claimsReopened` has no edge out of "shipped": the terminal status stands.
    await ws.mutate(page, "reopenClaim", { claimId: a });
    expect(await statusOf(page)).toBe("shipped");
  });

  it("the derived transition rides in the SAME commit as the content op", async () => {
    const page = await fresh();
    const a = await addClaim(page, "only");
    const before = (await ws.history()).length;
    await ws.mutate(page, "approveClaim", { claimId: a });
    expect(await statusOf(page)).toBe("complete");
    // One command, one committed event — the status is never briefly stale.
    expect((await ws.history()).length).toBe(before + 1);
  });

  it("rejects at registration an auto-transition whose event is on no edge", () => {
    const Broken = definePageType({
      type: "broken-auto",
      version: 1,
      initialStatus: "a",
      statusTransitions: [t("a", "go", "b")],
      autoTransitions: [{ event: "nosuch", when: () => true }],
      sections: { s: { name: "S", required: true, fields: { body: { kind: "blocks" } } } },
      commands: {},
      render: { title: "{title}", sections: [] },
    });
    expect(() => new Registry([Broken])).toThrow(ValidationError);
    try {
      new Registry([Broken]);
    } catch (e) {
      expect((e as ValidationError).issues.map((i) => i.message).join(" ")).toMatch(/can never fire/);
    }
  });
});
