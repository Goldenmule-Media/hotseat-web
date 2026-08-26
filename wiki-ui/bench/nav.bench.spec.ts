/**
 * Sidebar-click-to-painted latency.
 *
 * The headline is **warm-repeat**: the engine is up, the workspace is folded, and the same two
 * pages are opened over and over. Anything that shows up there is a cost paid on EVERY click,
 * which is the reported symptom — cold boot cannot explain it and is measured separately.
 *
 * Each scenario gets its own BrowserContext: that is an incognito-like partition, so it means a
 * fresh SharedWorker, a fresh `idb://wiki-ui-search`, and a fresh HTTP cache — no hand-deleting
 * IndexedDB, and no leakage between scenarios.
 */
import { expect, test, type Browser, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { clickNav, loadAndMeasure, waitForLive, waitForPage, type Sample } from "./lib/measure";
import { printSummary, record, write } from "./report";

const HERE = dirname(fileURLToPath(import.meta.url));
const M = JSON.parse(readFileSync(join(HERE, "fixture", "manifest.json"), "utf8")) as {
  fixtureVersion: number;
  workspaceId: string;
  smallA: string;
  smallB: string;
  huge: string;
  deep: string;
  mediumIds: string[];
  pageCount: number;
};

const startedAt = new Date().toISOString();

/** Open the workspace at `pageId` with the engine live — the start state of every warm run. */
async function warmPage(browser: Browser, pageId: string): Promise<Page> {
  const page = await browser.newPage();
  await page.goto(`/${encodeURIComponent(M.workspaceId)}/${encodeURIComponent(pageId)}`);
  await waitForLive(page);
  await waitForPage(page, pageId);
  return page;
}

/** Alternate between two targets. Clicking the ACTIVE row is a no-op in TreeNav, so a run that
 *  hammered one target would record nothing at all. */
async function alternate(page: Page, a: string, b: string, clicks: number, discard: number): Promise<Sample[]> {
  const out: Sample[] = [];
  for (let i = 0; i < clicks; i++) out.push(await clickNav(page, i % 2 === 0 ? b : a));
  expect(out).toHaveLength(clicks);
  return out.slice(discard);
}

test("warm-repeat: A↔B with the engine live", async ({ browser }) => {
  const page = await warmPage(browser, M.smallA);
  const samples = await alternate(page, M.smallA, M.smallB, 24, 4);
  record("warm-repeat", samples, "24 clicks, first 4 discarded for JIT warmup");
  // Every navigation should cost exactly one page read and one descriptor read. A count that
  // drifts is a regression worth catching on its own — it needs no stable machine.
  for (const s of samples) expect(s.rpcCount).toBe(2);
  await page.close();
});

test("large-page: small↔huge", async ({ browser }) => {
  const page = await warmPage(browser, M.smallA);
  const samples = await alternate(page, M.smallA, M.huge, 12, 2);
  // Split by direction: the incoming page's size is what its render and parse cost, so these
  // are two different navigations, not two samples of one.
  record("large-page-in", samples.filter((s) => s.pageId === M.huge), "→ the ~300KB page");
  record("large-page-out", samples.filter((s) => s.pageId === M.smallA), "→ back to a 3KB page");
  await page.close();
});

test("deep-tree: a depth-3 page", async ({ browser }) => {
  const page = await warmPage(browser, M.smallA);
  const samples = await alternate(page, M.smallA, M.deep, 12, 2);
  record("deep-tree", samples.filter((s) => s.pageId === M.deep));
  await page.close();
});

test("warm-first-click: a page never read before", async ({ browser }) => {
  const samples: Sample[] = [];
  // A fresh context each time, so the target is genuinely being read for the first time.
  for (const target of M.mediumIds.slice(0, 5)) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`/${encodeURIComponent(M.workspaceId)}/${encodeURIComponent(M.smallA)}`);
    await waitForLive(page);
    await waitForPage(page, M.smallA);
    samples.push(await clickNav(page, target));
    await ctx.close();
  }
  record("warm-first-click", samples, "fresh context per sample; medium pages, never read");
});

test("cold: fresh context, empty IndexedDB", async ({ browser }) => {
  const samples: Sample[] = [];
  const boots: unknown[] = [];
  for (let i = 0; i < 5; i++) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const { sample, boot } = await loadAndMeasure(page, M.workspaceId, M.smallA);
    samples.push(sample);
    boots.push(boot);
    await ctx.close();
  }
  // Drop the first: it also pays the OS page cache warming on the build output.
  record("cold", samples.slice(1), "page load → first paint, incl. the pglite wasm compile", { boots: boots.slice(1) });
});

test.afterAll(async ({ browser }) => {
  printSummary();
  const file = write(
    { fixtureVersion: M.fixtureVersion, pages: M.pageCount },
    { name: browser.browserType().name(), version: browser.version(), headless: true },
    startedAt,
  );
  console.log(`\n  → ${file}\n`);
});
