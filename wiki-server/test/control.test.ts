/**
 * Log API & consolidation tests. These drive the REAL
 * consolidating logger (`createLogger`) and the REAL control listener
 * (`startControlServer`) over HTTP — the same wiring `main.ts`/`startWikiServer`
 * use — and assert the behaviors:
 *
 *  - a record emitted via the **injected** (`mcp`-sourced) logger — the exact view
 *    `wiki-server` hands `createWikiMcp` — shows up in `GET /_server/logs`;
 *  - a `follow=1` SSE tail receives a **later** record (live, after the backlog);
 *  - `GET /_server/health` and `GET /_server/info` answer;
 *  - history honors `since` / `boot` / `source`.
 *
 * No `wiki` import (G2): the logger is the seam `wiki-mcp` would emit through.
 */
import { afterEach, describe, expect, it } from "vitest";

import { createLogger, type IConsolidatingLogger, type LogRecord } from "../src/logger";
import { startControlServer, type ControlServer } from "../src/control";

/** Track listeners started by a test so afterEach tears them down. */
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** A logger with a fixed boot id and an injectable, monotone clock (no wall-clock). */
function makeLogger(boot = "boot-test"): IConsolidatingLogger {
  let t = 0;
  return createLogger({
    bufferSize: 1000,
    format: "json",
    boot,
    now: () => new Date(Date.UTC(2020, 0, 1) + t++ * 1000).toISOString(),
    // Swallow stdout so the test output stays clean (the buffer + subscribers still fire).
    write: () => {},
  });
}

/** Start a control listener on an ephemeral port and register its teardown. */
async function startControl(logger: IConsolidatingLogger, overrides: Partial<{ isReady: () => boolean }> = {}): Promise<ControlServer> {
  const control = await startControlServer({
    host: "127.0.0.1",
    port: 0,
    logger,
    info: { version: "9.9.9", storage: "memory", baseUrl: "http://127.0.0.1:4437" },
    startedAt: Date.now() - 1234,
    ...(overrides.isReady !== undefined ? { isReady: overrides.isReady } : {}),
  });
  cleanups.push(() => control.stop());
  return control;
}

/** GET a control path and parse JSON. */
async function getJson(url: string): Promise<{ status: number; body: any }> {
  const res = await fetch(url);
  const body = await res.json();
  return { status: res.status, body };
}

describe("control: /_server/health + /_server/info", () => {
  it("health answers 200 ok when ready, 503 when not", async () => {
    let ready = true;
    const control = await startControl(makeLogger(), { isReady: () => ready });

    const ok = await getJson(`${control.url}/_server/health`);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ status: "ok" });

    ready = false;
    const down = await getJson(`${control.url}/_server/health`);
    expect(down.status).toBe(503);
    expect(down.body.status).toBe("unavailable");
  });

  it("info answers with the server facts", async () => {
    const logger = makeLogger("boot-info");
    const control = await startControl(logger);

    const { status, body } = await getJson(`${control.url}/_server/info`);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      version: "9.9.9",
      boot: "boot-info",
      storage: "memory",
      baseUrl: "http://127.0.0.1:4437",
      pid: process.pid,
    });
    expect(typeof body.uptimeMs).toBe("number");
    expect(body.uptimeMs).toBeGreaterThanOrEqual(0);
  });
});

describe("control: /_server/logs history + consolidation", () => {
  it("an mcp-sourced record (via the injected logger) shows up in GET /_server/logs", async () => {
    const logger = makeLogger();
    const control = await startControl(logger);

    // The exact view wiki-server hands createWikiMcp — `source: mcp`.
    const mcpLog = logger.forSource("mcp");
    mcpLog.info("projection caught up", { workspace: "ws-1", lag: 0 });

    const { status, body } = await getJson(`${control.url}/_server/logs`);
    expect(status).toBe(200);
    expect(body.boot).toBe("boot-test");
    const records = body.records as LogRecord[];
    const mcpRecord = records.find((r) => r.source === "mcp");
    expect(mcpRecord).toBeDefined();
    expect(mcpRecord).toMatchObject({
      source: "mcp",
      level: "info",
      msg: "projection caught up",
      fields: { workspace: "ws-1", lag: 0 },
    });
  });

  it("history honors `since` (only strictly-greater seq)", async () => {
    const logger = makeLogger();
    const control = await startControl(logger);
    const log = logger.forSource("server");
    log.info("a"); // seq 0
    log.info("b"); // seq 1
    log.info("c"); // seq 2

    const all = await getJson(`${control.url}/_server/logs`);
    expect((all.body.records as LogRecord[]).map((r) => r.msg)).toEqual(["a", "b", "c"]);

    const after = await getJson(`${control.url}/_server/logs?since=0`);
    expect((after.body.records as LogRecord[]).map((r) => r.msg)).toEqual(["b", "c"]);
    expect(after.body.next).toBe(2);
  });

  it("history honors `source` (filters to one plane)", async () => {
    const logger = makeLogger();
    const control = await startControl(logger);
    logger.forSource("server").info("from-server");
    logger.forSource("stream").info("from-stream");
    logger.forSource("mcp").info("from-mcp");

    const onlyMcp = await getJson(`${control.url}/_server/logs?source=mcp`);
    const records = onlyMcp.body.records as LogRecord[];
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ source: "mcp", msg: "from-mcp" });
  });

  it("history reflects `boot` so a tail detects a restart", async () => {
    const logger = makeLogger("boot-A");
    const control = await startControl(logger);
    logger.info("hello");

    // The caller's last-seen boot differs → still returns what we have, tagged with
    // THIS process's boot, so the caller knows to resync.
    const { body } = await getJson(`${control.url}/_server/logs?boot=boot-OLD`);
    expect(body.boot).toBe("boot-A");
    expect((body.records as LogRecord[]).map((r) => r.boot)).toEqual(["boot-A"]);
  });
});

describe("control: /_server/logs?follow=1 SSE tail", () => {
  it("a follow=1 tail replays the backlog, then receives a LATER record live", async () => {
    const logger = makeLogger();
    const control = await startControl(logger);

    // A record that exists BEFORE the tail opens (the backlog).
    logger.forSource("mcp").info("backlog-record", { n: 1 });

    const ac = new AbortController();
    cleanups.push(() => ac.abort());
    const res = await fetch(`${control.url}/_server/logs?follow=1`, {
      headers: { accept: "text/event-stream" },
      signal: ac.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const seen: LogRecord[] = [];

    /** Pull SSE chunks until `predicate` holds over the records seen so far. */
    async function readUntil(predicate: (records: LogRecord[]) => boolean): Promise<void> {
      let buffer = "";
      while (!predicate(seen)) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
          if (dataLine) seen.push(JSON.parse(dataLine.slice("data: ".length)) as LogRecord);
        }
      }
    }

    // First: the backlog record replays.
    await readUntil((rs) => rs.some((r) => r.msg === "backlog-record"));

    // Then a LATER record, emitted after the tail is live, must arrive.
    logger.forSource("mcp").info("live-record", { n: 2 });
    await readUntil((rs) => rs.some((r) => r.msg === "live-record"));

    const msgs = seen.map((r) => r.msg);
    expect(msgs).toContain("backlog-record");
    expect(msgs).toContain("live-record");
    // The backlog is delivered before the live record (ordering preserved).
    expect(msgs.indexOf("backlog-record")).toBeLessThan(msgs.indexOf("live-record"));

    await reader.cancel();
  });

  it("a follow=1 tail with since= skips the backlog at/under that seq", async () => {
    const logger = makeLogger();
    const control = await startControl(logger);
    logger.info("old-0"); // seq 0
    logger.info("old-1"); // seq 1

    const ac = new AbortController();
    cleanups.push(() => ac.abort());
    const res = await fetch(`${control.url}/_server/logs?follow=1&since=1`, {
      headers: { accept: "text/event-stream" },
      signal: ac.signal,
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const seen: LogRecord[] = [];

    async function readOne(predicate: (records: LogRecord[]) => boolean): Promise<void> {
      let buffer = "";
      while (!predicate(seen)) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
          if (dataLine) seen.push(JSON.parse(dataLine.slice("data: ".length)) as LogRecord);
        }
      }
    }

    // since=1 means seq 0 and 1 are filtered out; a NEW record (seq 2) arrives.
    logger.info("new-2"); // seq 2
    await readOne((rs) => rs.some((r) => r.msg === "new-2"));

    const msgs = seen.map((r) => r.msg);
    expect(msgs).not.toContain("old-0");
    expect(msgs).not.toContain("old-1");
    expect(msgs).toContain("new-2");

    await reader.cancel();
  });
});
