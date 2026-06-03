/**
 * The guarded code-edit command + the CONTENT-HASH PRECONDITION (structured-content
 * §5/§11, Phase 3). Drives the REAL engine over an in-memory DurableStreamTestServer:
 *
 *  1. The generated `apply<Section><Field>Edits` command applies a precomputed
 *     `TextEdit[]` to a `code` field, recomputes the hash, folds, and renders byte-stably.
 *  2. A WRONG `expectedHash` is REJECTED with the typed {@link StaleEditError}; the
 *     correct current hash APPLIES (the precondition re-runs inside the decide window).
 *  3. History records the SEMANTIC label (`label` arg, default = command name).
 *  4. The same machinery reaches a `code` BLOCK inside a `blocks` field (§3.1).
 *
 * The engine NEVER parses: it only replays the host-computed edits under the precondition.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  definePageType,
  zodSchema,
  z,
  type IField,
  type IBlock,
  type IWiki,
  type IWorkspaceHandle,
  type PageId,
  type DeepReadonly,
  type PageState,
  type SectionOp,
} from "../src/index";
import { StaleEditError } from "../src/core/errors";
import { contentHash } from "../src/core/ingestion";
import { createTestWiki, type ITestWiki } from "../src/testing";

const SRC = `export function alpha(x: number): number { return alpha(x) + beta(x); }\n`;

const CodeDoc = definePageType({
  type: "code-doc",
  version: 1,
  initialStatus: "draft",
  statusTransitions: [],
  sections: {
    impl: { name: "Implementation", required: true, mutableIn: ["draft"], fields: { snippet: { kind: "code" } } },
    doc: { name: "Doc", required: true, mutableIn: ["draft"], fields: { body: { kind: "blocks" } } },
  },
  commands: {
    // seed the code field with canonical source.
    setSnippet: {
      args: zodSchema(z.object({ source: z.string(), lang: z.string() })),
      produces: (_p, args): SectionOp[] => {
        const a = args as { source: string; lang: string };
        return [{ op: "setField", section: "impl", field: "snippet", value: { kind: "code", lang: a.lang, source: a.source, hash: "" } }];
      },
    },
    // seed a code block in the blocks field.
    addCodeBlock: {
      args: zodSchema(z.object({ source: z.string(), lang: z.string(), id: z.string() })),
      produces: (_p, args): SectionOp[] => {
        const a = args as { source: string; lang: string; id: string };
        const block: IBlock = { kind: "code", id: a.id as never, lang: a.lang, source: a.source, hash: "" };
        return [{ op: "addBlock", section: "doc", field: "body", block }];
      },
    },
  },
  render: { sections: [{ section: "impl", heading: "Impl", field: "snippet", as: "fenced" }] },
});

function codeField(state: DeepReadonly<PageState>, section: string, field: string): { source: string; hash: string } {
  const f = state.sections.find((s) => s.key === section)?.fields[field] as DeepReadonly<IField> | undefined;
  if (f === undefined || f.kind !== "code") throw new Error("not a code field");
  return { source: f.source, hash: f.hash };
}

describe("guarded code-edit command + content-hash precondition", () => {
  let harness: ITestWiki;
  let wiki: IWiki;
  let ws: IWorkspaceHandle;
  let page: PageId;

  beforeAll(async () => {
    harness = await createTestWiki([CodeDoc]);
    wiki = harness.wiki;
    ws = await wiki.createWorkspace({ name: "W" });
    const created = await ws.createPage("code-doc", { title: "P", parentId: null });
    page = created.value;
    await ws.mutate(page, "setSnippet", { source: SRC, lang: "ts" });
  });

  afterAll(async () => harness.stop());

  it("applies precomputed edits, recomputes the hash, folds, and renders byte-stably", async () => {
    const before = codeField(await (await wiki.openWorkspace(ws.id)).page(page).then((v) => v.state()), "impl", "snippet");
    expect(before.source).toBe(SRC);
    expect(before.hash).toBe(contentHash(SRC));

    // Rename `alpha` → `gamma` at its three occurrences (host-computed offsets).
    const edits = occurrences(SRC, "alpha").map((start) => ({ start, end: start + "alpha".length, replacement: "gamma" }));
    const c = await ws.mutate(page, "applyImplSnippetEdits", { edits, expectedHash: before.hash, label: "renameSymbol" });

    const after = codeField(await (await ws.page(page, { consistentWith: c.token })).state(), "impl", "snippet");
    const expected = SRC.replaceAll("alpha", "gamma");
    expect(after.source).toBe(expected);
    expect(after.hash).toBe(contentHash(expected));

    // Render is a verbatim fence of the new canonical source (byte-stable).
    const md = await ws.toMarkdown(page, { consistentWith: c.token });
    expect(md).toContain("```ts");
    expect(md).toContain("function gamma(x: number)");
    // A second render of identical state is byte-identical.
    expect(await ws.toMarkdown(page, { consistentWith: c.token })).toBe(md);
  });

  it("history records the semantic label", async () => {
    const hist = await ws.history();
    const last = hist[hist.length - 1]!;
    expect(last.meta.command).toBe("renameSymbol");
  });

  it("rejects a stale expectedHash with StaleEditError; the current hash applies", async () => {
    const cur = codeField(await (await ws.page(page)).state(), "impl", "snippet");
    const edit = [{ start: 0, end: 0, replacement: "// note\n" }];

    // A wrong hash → typed StaleEditError (distinct from stream-level ConcurrencyError).
    await expect(
      ws.mutate(page, "applyImplSnippetEdits", { edits: edit, expectedHash: "deadbeef" }),
    ).rejects.toBeInstanceOf(StaleEditError);

    // The CORRECT current hash applies.
    const c = await ws.mutate(page, "applyImplSnippetEdits", { edits: edit, expectedHash: cur.hash });
    const after = codeField(await (await ws.page(page, { consistentWith: c.token })).state(), "impl", "snippet");
    expect(after.source.startsWith("// note\n")).toBe(true);
    expect(after.hash).toBe(contentHash(after.source));
  });

  it("edits a code BLOCK inside a blocks field under the same precondition (§3.1)", async () => {
    const blockSrc = `function helper(){ return helper(); }\n`;
    await ws.mutate(page, "addCodeBlock", { source: blockSrc, lang: "ts", id: "blk-1" });
    const state = await (await ws.page(page)).state();
    const body = state.sections.find((s) => s.key === "doc")!.fields.body as DeepReadonly<IField>;
    if (body.kind !== "blocks") throw new Error("not blocks");
    const blk = body.blocks.find((b) => b.id === ("blk-1" as never))!;
    if (blk.kind !== "code") throw new Error("not code block");
    const curHash = blk.hash;

    const edits = occurrences(blockSrc, "helper").map((start) => ({ start, end: start + "helper".length, replacement: "aid" }));
    const c = await ws.mutate(page, "applyDocBodyBlockEdits", { block: "blk-1", edits, expectedHash: curHash, label: "renameSymbol" });

    const after = await (await ws.page(page, { consistentWith: c.token })).state();
    const body2 = after.sections.find((s) => s.key === "doc")!.fields.body as DeepReadonly<IField>;
    if (body2.kind !== "blocks") throw new Error("not blocks");
    const blk2 = body2.blocks.find((b) => b.id === ("blk-1" as never))!;
    if (blk2.kind !== "code") throw new Error("not code block");
    expect(blk2.source).toBe(blockSrc.replaceAll("helper", "aid"));
    expect(blk2.hash).toBe(contentHash(blk2.source));

    // A wrong hash on the block is also rejected.
    await expect(
      ws.mutate(page, "applyDocBodyBlockEdits", { block: "blk-1", edits: [{ start: 0, end: 0, replacement: "x" }], expectedHash: "00000000" }),
    ).rejects.toBeInstanceOf(StaleEditError);
  });
});

/** Every start offset of `needle` in `hay` (host-side, for the test's edit ranges). */
function occurrences(hay: string, needle: string): number[] {
  const out: number[] = [];
  let i = hay.indexOf(needle);
  while (i !== -1) {
    out.push(i);
    i = hay.indexOf(needle, i + needle.length);
  }
  return out;
}
