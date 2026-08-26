/**
 * Driving one navigation and reading back what it cost.
 *
 * Completion is `article.markdown[data-page-id="<target>"]` — CONTENT identity, not route
 * identity. usePage keeps the previous page's body on screen while the next one loads, so a
 * wait keyed on the URL or on a spinner disappearing would happily measure the old page.
 */
import type { Page } from "@playwright/test";
import type { NavRecord, PerfDump } from "../../lib/perf";
import { round } from "./stats";

declare global {
  interface Window {
    __wikiPerf: { take(): PerfDump; peek(): PerfDump; reset(): void };
  }
}

/** One navigation, reduced to the numbers a scenario reports. */
export interface Sample {
  readonly pageId: string;
  readonly fromPageId: string | null;
  /** The headline: the click, to the frame carrying the new body. */
  readonly clickToPainted: number;
  /** Click to route commit — the App Router hop, before the engine is asked anything. */
  readonly routeCommitMs: number;
  readonly toMarkdownMs: number;
  readonly describeMutationsMs: number;
  readonly renderMarkdownMs: number;
  /** HTML in hand, to painted: React commit + innerHTML + style/layout. */
  readonly commitToPaint: number;
  readonly rpcCount: number;
  readonly bodyBytes: number;
  readonly htmlBytes: number;
}

function rpcMs(n: NavRecord, name: string): number {
  const spans = n.rpc.filter((r) => r.name === name);
  return round(spans.reduce((a, r) => a + (r.end - r.start), 0));
}

export function derive(n: NavRecord): Sample {
  const painted = n.paintedAt ?? n.t0;
  return {
    pageId: n.pageId,
    fromPageId: n.fromPageId,
    clickToPainted: round(painted - n.t0),
    routeCommitMs: round((n.routeCommitAt ?? n.t0) - n.t0),
    toMarkdownMs: rpcMs(n, "toMarkdown"),
    describeMutationsMs: rpcMs(n, "describeMutations"),
    renderMarkdownMs: round(n.htmlMs ?? 0),
    commitToPaint: round(painted - (n.htmlAt ?? painted)),
    rpcCount: n.rpc.length,
    bodyBytes: n.bodyBytes ?? 0,
    htmlBytes: n.htmlBytes ?? 0,
  };
}

/** Wait until the engine is up and tailing — every warm scenario starts from here. */
export async function waitForLive(page: Page): Promise<void> {
  await page.waitForSelector('.live-indicator[data-state="live"]', { timeout: 180_000 });
}

export async function waitForPage(page: Page, pageId: string): Promise<void> {
  await page.waitForSelector(`article.markdown[data-page-id="${pageId}"]`, { timeout: 60_000 });
}

/**
 * Click a sidebar row and return the recorded navigation. Callers must ALTERNATE targets:
 * TreeItem.activate() is `if (!isActive) router.push(href)`, so clicking the row that is
 * already open navigates nowhere and would record nothing.
 */
export async function clickNav(page: Page, target: string): Promise<Sample> {
  await page.evaluate(() => window.__wikiPerf.reset());
  await page.click(`.tree-row[data-page-id="${target}"]`);
  await waitForPage(page, target);
  // The paint mark lands a frame or two after the element exists, so wait for the record.
  await page.waitForFunction(
    (id) => window.__wikiPerf.peek().navs.some((n) => n.pageId === id && n.complete),
    target,
    { timeout: 60_000 },
  );
  const { navs } = await page.evaluate(() => window.__wikiPerf.take());
  const done = navs.filter((n) => n.complete && n.pageId === target);
  if (done.length !== 1) throw new Error(`expected exactly 1 navigation to ${target}, got ${done.length}`);
  return derive(done[0]!);
}

/** Cold/boot numbers for a freshly loaded page: `paintedAt` is already ms since navigation start. */
export async function loadAndMeasure(page: Page, workspaceId: string, pageId: string): Promise<{ sample: Sample; boot: PerfDump["boot"] }> {
  await page.goto(`/${encodeURIComponent(workspaceId)}/${encodeURIComponent(pageId)}`);
  await waitForPage(page, pageId);
  await page.waitForFunction(
    (id) => window.__wikiPerf.peek().navs.some((n) => n.pageId === id && n.complete),
    pageId,
    { timeout: 180_000 },
  );
  const dump = await page.evaluate(() => window.__wikiPerf.take());
  const rec = dump.navs.find((n) => n.complete && n.pageId === pageId)!;
  return { sample: { ...derive(rec), clickToPainted: round(rec.paintedAt ?? 0) }, boot: dump.boot };
}
