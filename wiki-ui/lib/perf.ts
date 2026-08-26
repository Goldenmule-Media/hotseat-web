/**
 * Navigation-latency instrumentation. ALWAYS ON — a handful of `performance` calls plus one
 * array push per navigation is sub-100µs against tens of milliseconds, and always-on means the
 * numbers describe the app that actually ships, not a special build.
 *
 * The authoritative numbers live in a module ring buffer, NOT on the performance timeline.
 * `performance.measure(name, startMarkName)` resolves a mark NAME to the most recent mark of
 * that name, which mis-attributes silently whenever a navigation is superseded (click A, click
 * B, A's RPC resolves and measures against B's start mark). So every span is captured
 * numerically into a {@link NavRecord}, and timeline entries are emitted only as a DevTools
 * affordance — always via the `{start, end}` options form, which bypasses name resolution.
 *
 * Environment-agnostic by contract: no `window`/`document` at module scope, so this imports
 * cleanly in the Node test environment and (later) inside the SharedWorker.
 */

/** One RPC round trip as the TAB observes it: serialize, worker scheduling, engine, clone back. */
export interface RpcSpan {
  readonly name: string;
  readonly pageId: string | null;
  readonly start: number;
  readonly end: number;
  readonly ok: boolean;
}

/** One sidebar-click-to-painted navigation. Times are tab-local `performance.now()` ms. */
export interface NavRecord {
  navId: number;
  /** "tree" = a sidebar row click; "other" = a link/search/direct nav, opened at route commit. */
  source: "tree" | "other";
  workspaceId: string;
  fromPageId: string | null;
  pageId: string;
  /** For comparing against another context's clock later (the worker has its own origin). */
  timeOrigin: number;
  t0: number;
  /** PageView's layout effect for this pageId — everything before it is the App Router hop. */
  routeCommitAt?: number;
  rpc: RpcSpan[];
  htmlAt?: number;
  htmlMs?: number;
  bodyBytes?: number;
  htmlBytes?: number;
  paintedAt?: number;
  complete: boolean;
}

/** Cold-start attribution: worker construction and the handshake that awaits the engine boot. */
export interface BootRecord {
  timeOrigin: number;
  connectStart?: number;
  workerCtorAt?: number;
  handshakeStart?: number;
  handshakeEnd?: number;
}

export interface PerfDump {
  readonly navs: readonly NavRecord[];
  /** RPCs that belonged to no open navigation — visible, never mis-attributed. */
  readonly stray: readonly RpcSpan[];
  readonly boot: BootRecord | null;
}

const MAX_NAVS = 50;
const MAX_STRAY = 100;

let current: NavRecord | null = null;
let done: NavRecord[] = [];
let stray: RpcSpan[] = [];
let bootRec: BootRecord | null = null;
let navSeq = 0;

// Timeline entry names actually emitted, so `clearTimeline` can drop exactly those.
const emitted = new Set<string>();

function hasPerf(): boolean {
  return typeof performance !== "undefined";
}

function now(): number {
  return hasPerf() ? performance.now() : 0;
}

function origin(): number {
  return hasPerf() && typeof performance.timeOrigin === "number" ? performance.timeOrigin : 0;
}

function emitMark(name: string, detail: unknown): void {
  if (!hasPerf()) return;
  try {
    performance.mark(name, { detail });
    emitted.add(name);
  } catch {
    // A runtime without the options form (or with marks disabled) simply gets no timeline entry.
  }
}

function emitMeasure(name: string, start: number, end: number, detail: unknown): void {
  if (!hasPerf()) return;
  try {
    performance.measure(name, { start, end, detail });
    emitted.add(name);
  } catch {
    /* see emitMark */
  }
}

/** Drop this navigation's timeline entries. Safe: the authoritative numbers are already copied. */
function clearTimeline(): void {
  if (!hasPerf()) return;
  for (const name of emitted) {
    try {
      performance.clearMarks(name);
      performance.clearMeasures(name);
    } catch {
      /* ignore */
    }
  }
}

/** Close the open record (complete or not) into the ring, so it can never leak into the next. */
function closeCurrent(): void {
  if (current === null) return;
  done.push(current);
  if (done.length > MAX_NAVS) done.splice(0, done.length - MAX_NAVS);
  current = null;
}

function open(source: NavRecord["source"], workspaceId: string, pageId: string, fromPageId: string | null, t0: number): NavRecord {
  closeCurrent();
  navSeq += 1;
  current = { navId: navSeq, source, workspaceId, fromPageId, pageId, timeOrigin: origin(), t0, rpc: [], complete: false };
  return current;
}

// ── the recording surface ───────────────────────────────────────────────────────

/** A sidebar row click, stamped inside the app's own React handler (before `router.push`). */
export function navStart(workspaceId: string, pageId: string, fromPageId: string | null): void {
  open("tree", workspaceId, pageId, fromPageId, now());
  emitMark("wiki:nav-start", { pageId, fromPageId });
}

/**
 * The route segment committed for `pageId`. With no open navigation this OPENS one
 * (`source:"other"`) — which is how link clicks, the search palette and direct URL loads get
 * measured without instrumenting each of them.
 */
export function routeCommit(workspaceId: string, pageId: string): void {
  const t = now();
  const rec = current !== null && current.pageId === pageId ? current : open("other", workspaceId, pageId, current?.pageId ?? null, t);
  if (rec.routeCommitAt === undefined) rec.routeCommitAt = t;
  emitMeasure("wiki:route-commit", rec.t0, t, { pageId });
}

/** Time one RPC and attribute it to the open navigation for `pageId` (else to {@link PerfDump.stray}). */
export function rpc<T>(name: string, pageId: string | null, p: Promise<T>): Promise<T> {
  const start = now();
  const finish = (ok: boolean): void => {
    const span: RpcSpan = { name, pageId, start, end: now(), ok };
    if (current !== null && pageId !== null && current.pageId === pageId) current.rpc.push(span);
    else {
      stray.push(span);
      if (stray.length > MAX_STRAY) stray.splice(0, stray.length - MAX_STRAY);
    }
    emitMeasure(`wiki:rpc:${name}`, span.start, span.end, { pageId, ok });
  };
  return p.then(
    (v) => {
      finish(true);
      return v;
    },
    (e: unknown) => {
      finish(false);
      throw e;
    },
  );
}

/** Time the synchronous Markdown→HTML step and record it as this navigation's `htmlAt`. */
export function timeMarkdown<T>(pageId: string, bodyBytes: number, fn: () => T): T {
  const start = now();
  const value = fn();
  const end = now();
  if (current !== null && current.pageId === pageId && !current.complete) {
    current.htmlAt = end;
    current.htmlMs = end - start;
    current.bodyBytes = bodyBytes;
  }
  emitMeasure("wiki:markdown", start, end, { pageId, bodyBytes });
  return value;
}

/** The frame carrying `pageId`'s body has been presented. First call wins per navigation. */
export function painted(pageId: string, htmlBytes: number): void {
  if (current === null || current.pageId !== pageId || current.complete) return;
  current.paintedAt = now();
  current.htmlBytes = htmlBytes;
  current.complete = true;
  emitMeasure("wiki:painted", current.t0, current.paintedAt, { pageId, htmlBytes });
  clearTimeline();
}

/** Stamp one field of the one-shot boot record (cold-start attribution). */
export function bootMark(field: Exclude<keyof BootRecord, "timeOrigin">): void {
  if (bootRec === null) bootRec = { timeOrigin: origin() };
  if (bootRec[field] === undefined) bootRec[field] = now();
}

// ── the reading surface ─────────────────────────────────────────────────────────

/** Read without draining — for eyeballing state in DevTools, and for polling until a
 *  navigation completes without consuming the record you are waiting for. */
export function peek(): PerfDump {
  const navs = current !== null && current.complete ? [...done, current] : [...done];
  return { navs, stray: [...stray], boot: bootRec };
}

/** Drain every finished navigation. A complete open record is included and then closed out. */
export function take(): PerfDump {
  const navs = done;
  done = [];
  if (current !== null && current.complete) {
    navs.push(current);
    current = null;
  }
  const s = stray;
  stray = [];
  return { navs, stray: s, boot: bootRec };
}

export function reset(): void {
  closeCurrent();
  done = [];
  stray = [];
  current = null;
  clearTimeline();
}

/** Expose `take`/`reset` on `window` for DevTools and the Playwright harness. Idempotent. */
export function installBridge(): void {
  if (typeof window === "undefined") return;
  (window as unknown as { __wikiPerf?: unknown }).__wikiPerf = { take, peek, reset };
}
