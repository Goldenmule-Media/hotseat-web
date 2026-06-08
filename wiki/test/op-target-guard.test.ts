/**
 * Id-addressed ops (remove/move/set element|block via `produces`) must fail LOUDLY when
 * their target id does not exist — instead of the reducer's silent `if (idx !== -1)` no-op,
 * which let a stale/mistyped id "succeed" while changing nothing. The guard lives on the
 * decide path (command bus); the reducer stays tolerant for replay.
 *
 * These tests also pin that an add command's returned id IS the stored id (the round-trip
 * remove uses the exact id the add returned) — i.e. there is no id truncation.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IWiki, IWorkspaceHandle, PageId } from "../src/api";
import { ItemNotFoundError } from "../src/core/errors";
import { featurePageTypes } from "wiki-models/feature";
import { createTestWiki, type ITestWiki } from "../src/testing";

describe("id-addressed ops fail loudly on a stale target", () => {
  let harness: ITestWiki;
  let wiki: IWiki;
  let ws: IWorkspaceHandle;
  let brief: PageId;
  let spec: PageId;

  beforeAll(async () => {
    harness = await createTestWiki(featurePageTypes);
    wiki = harness.wiki;
    ws = await wiki.createWorkspace({ name: "Guard" });
    const created = await ws.createPage("feature-brief", { title: "G", parentId: null });
    brief = created.value;
    const kids = await (await ws.page(brief, { consistentWith: created.token })).children();
    spec = kids.find((k) => k.type === "feature-spec")!.id;
  });
  afterAll(async () => {
    await harness.stop();
  });

  it("removeElement (produces) rejects an unknown id, and round-trips the exact id addComponent returned", async () => {
    const { value } = await ws.mutate(brief, "addComponent", { name: "engine" });
    const componentId = (value as { componentId: string }).componentId;

    await expect(ws.mutate(brief, "removeComponent", { componentId: "no-such-id" })).rejects.toBeInstanceOf(ItemNotFoundError);

    // The id returned by addComponent removes cleanly — proving the add-result id IS the
    // stored id (no truncation).
    await expect(ws.mutate(brief, "removeComponent", { componentId })).resolves.toBeDefined();
  });

  it("removeBlock (produces) rejects an unknown blockId, and round-trips the exact id addParagraph returned", async () => {
    const { value } = await ws.mutate(spec, "addParagraph", { text: "a design note" });
    const blockId = (value as { blockId: string }).blockId;

    await expect(ws.mutate(spec, "removeDesignBlock", { blockId: "no-such-block" })).rejects.toBeInstanceOf(ItemNotFoundError);
    await expect(ws.mutate(spec, "removeDesignBlock", { blockId })).resolves.toBeDefined();
  });
});
