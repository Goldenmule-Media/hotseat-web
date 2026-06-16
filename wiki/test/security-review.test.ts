/**
 * Integration test for the real `security-review` bundle (wiki-models/security): the page
 * type whose emitted Markdown shows only OPEN findings — numbered at render time, with inline
 * cross-references that renumber with the list and degrade to a title once a target is hidden.
 * Drives the model through its own declarative + produces commands (no engine internals).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { securityPageTypes } from "wiki-models/security";
import type { IWiki, IWorkspaceHandle, PageId } from "../src/api";
import { createTestWiki, type ITestWiki } from "../src/testing";

describe("security-review model", () => {
  let harness: ITestWiki;
  let wiki: IWiki;
  let ws: IWorkspaceHandle;

  beforeAll(async () => {
    harness = await createTestWiki([...securityPageTypes]);
    wiki = harness.wiki;
    ws = await wiki.createWorkspace({ name: "Audit" });
  });

  afterAll(async () => {
    await harness.stop();
  });

  let seq = 0;
  async function add(page: PageId, title: string, severity: string): Promise<string> {
    const r = await ws.mutate(page, "addFinding", { title, severity });
    return (r.value as { findingId: string }).findingId;
  }

  it("renders a scoped, numbered audit with cross-references and hides resolved findings", async () => {
    const p = (await ws.createPage("security-review", { title: `Auth review ${seq++}`, parentId: null })).value;
    await ws.mutate(p, "setScope", { text: "The authorization system in reactor-api." });

    const f1 = await add(p, "JWT verification bypass", "high");
    const f2 = await add(p, "Open redirect in callback", "medium");
    const f3 = await add(p, "Timing leak in token compare", "low");
    await ws.mutate(p, "setFindingDetail", { findingId: f1, markdown: "The verifier accepts `alg:none`." });
    await ws.mutate(p, "setImpact", { findingId: f1, text: "Full authentication bypass." });
    await ws.mutate(p, "setRecommendation", { findingId: f1, text: "Pin to RS256." });
    await ws.mutate(p, "setFindingDetail", { findingId: f3, markdown: "Non-constant-time compare." });
    // Finding 3 references finding 1 by its render-time ordinal.
    await ws.mutate(p, "citeFinding", { findingId: f3, targetFindingId: f1 });

    const md = await ws.toMarkdown(p);
    expect(md).toContain("## Scope");
    expect(md).toContain("The authorization system in reactor-api.");
    expect(md).toContain("### 1. JWT verification bypass (high)");
    expect(md).toContain("### 2. Open redirect in callback (medium)");
    expect(md).toMatch(/### 3\. Timing leak in token compare \(low\)/);
    expect(md).toContain("**Impact:** Full authentication bypass.");
    expect(md).toContain("**Recommendation:** Pin to RS256.");
    expect(md).toContain("Related: 1"); // ref → finding 1's current ordinal
    expect(md).toMatch(/`alg:none`/); // inline Markdown was reified

    // Resolve finding 1 (the fix is done): it vanishes and the rest renumber, and finding 3's
    // reference degrades to the now-hidden finding's title.
    await ws.mutate(p, "resolveFinding", { findingId: f1, resolution: "Reject alg:none; pinned RS256." });
    const after = await ws.toMarkdown(p);
    expect(after).not.toMatch(/### \d+\. JWT verification bypass/); // hidden entirely
    expect(after).toContain("### 1. Open redirect in callback (medium)");
    expect(after).toContain("### 2. Timing leak in token compare (low)");
    expect(after).toContain("Related: JWT verification bypass"); // degraded to title, not a stale number
    // Deterministic.
    expect(await ws.toMarkdown(p)).toBe(after);
  });

  it("freezes the document once closed", async () => {
    const p = (await ws.createPage("security-review", { title: `Closed review ${seq++}`, parentId: null })).value;
    await ws.mutate(p, "setScope", { text: "scope" });
    await add(p, "Some finding", "info");
    await ws.mutate(p, "close", {});
    expect(await (await ws.page(p)).status()).toBe("closed");
    // findings is mutable only while open → adding once closed is rejected.
    await expect(ws.mutate(p, "addFinding", { title: "late", severity: "low" })).rejects.toThrow();
  });
});
