/**
 * `kindFor` ref-sugar (command-bus): the declarative `set: arg()` path on a `ref`-kind
 * field builds a first-class page-ref `IField` from a bare string id, and passes an
 * already-structured ref value through unchanged — so ANY model can author a ref field
 * declaratively (no `produces` escape hatch). Schema-agnostic: this minimal page type
 * carries a lone `ref` field and a single `set:` command; it knows nothing of ADRs.
 *
 * Before this case, `kindFor` defaulted a ref field to PROSE — a `set: arg(id)` would have
 * stored the id as text, and the engine's ref-integrity (RefIntegrityError) would never
 * have engaged. The third case proves integrity now does engage on the section-level field.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IField, IWiki, IWorkspaceHandle, PageId } from "../src/api";
import { arg, definePageType, t, z, zodSchema } from "../src/authoring";
import { createTestWiki, type ITestWiki } from "../src/testing";

// A deliberately tiny type: one required section with a single `ref` field, one `set:`
// command that takes a string id, and one that takes a pre-built structured ref value.
const RefNote = definePageType({
  type: "refset-note",
  label: "Note",
  version: 1,
  initialStatus: "open",
  statusTransitions: [t("open", "close", "closed")],
  sections: {
    rel: { name: "Relations", required: true, mutableIn: ["open"], fields: { link: { kind: "ref" } } },
  },
  sectionSet: { mode: "closed" },
  commands: {
    // string id → page-ref (the common case the sugar now supports).
    setLink: {
      args: zodSchema(z.object({ link: z.string() })),
      target: { section: "rel", field: "link" },
      set: { link: arg("link") },
    },
    // a pre-structured ref value must pass through untouched (cross-page element/section refs).
    setLinkRaw: {
      args: zodSchema(z.object({ link: z.any() })),
      target: { section: "rel", field: "link" },
      set: { link: arg("link") },
    },
  },
  render: {
    title: "{title}",
    graphSections: false,
    sections: [{ section: "rel", field: "link", heading: "Link", as: "inline" }],
  },
});

const linkField = async (ws: IWorkspaceHandle, id: PageId): Promise<IField | undefined> => {
  const state = await (await ws.page(id)).state();
  return state.sections.find((s) => s.key === "rel")?.fields["link"] as IField | undefined;
};

describe("kindFor: refs are first-class in the declarative set: sugar", () => {
  let harness: ITestWiki;
  let wiki: IWiki;
  let ws: IWorkspaceHandle;
  let a: PageId;
  let b: PageId;

  beforeAll(async () => {
    harness = await createTestWiki([RefNote]);
    wiki = harness.wiki;
    ws = await wiki.createWorkspace({ name: "Refs" });
    a = (await ws.createPage("refset-note", { title: "A", parentId: null })).value;
    b = (await ws.createPage("refset-note", { title: "B", parentId: null })).value;
  });

  afterAll(async () => {
    await harness.stop();
  });

  it("builds a page-ref IField from a bare string id (not prose)", async () => {
    await ws.mutate(a, "setLink", { link: String(b) });
    const f = await linkField(ws, a);
    expect(f?.kind).toBe("ref");
    if (f?.kind === "ref") expect(f.target).toEqual({ kind: "page", id: String(b) });
    // It renders as the target's render-derived label ("B"), not the raw id — which is exactly
    // how a ref differs from prose here (prose would have stored and shown the id string).
    const md = await ws.toMarkdown(a);
    expect(/## Link\n+B\b/.test(md)).toBe(true);
    expect(md.includes(String(b))).toBe(false);
  });

  it("passes an already-structured ref value through unchanged", async () => {
    const structured: IField = { kind: "ref", target: { kind: "page", id: String(a) as PageId } };
    await ws.mutate(b, "setLinkRaw", { link: structured });
    const f = await linkField(ws, b);
    expect(f).toEqual(structured);
  });

  it("rejects a string id that does not resolve (ref-integrity engages on the section field)", async () => {
    await expect(ws.mutate(a, "setLink", { link: "refset-note:does-not-exist" })).rejects.toThrow();
  });
});
