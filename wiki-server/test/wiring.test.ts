/**
 * Wiring smoke test. Boots the REAL process wiring — `startWikiServer`,
 * the same function the `bin` entry calls — and confirms BOTH planes it stands up
 * answer: the **stream host** serves a stream round-trip, and the **control
 * listener** answers `/_server/health` and `/_server/info`.
 *
 * The hosted `wiki-mcp` is injected via the `startMcp` seam so the smoke test
 * exercises the wiring (stream host → control listener, with `wiki-mcp` pointed at
 * the live `baseUrl`) without standing up the full engine + PGlite read model — that
 * surface is covered by `wiki-mcp`'s own suite. We still assert the wiring fed
 * `wiki-mcp` the INTERNAL stream URL — in-process consumers bypass the front door
 * rather than loop back through it — and the host's `mcp` logger.
 *
 * The public `baseUrl` is the front door in every auth mode, so the stream round-trip
 * below is also the proof that streams still work through the proxy leg.
 */
import { afterEach, describe, expect, it } from "vitest";

import { DurableStream, stream } from "@durable-streams/client";
import type { WikiMcpConfig } from "wiki-mcp";

import { resolveConfig } from "../src/config";
import { startWikiServer, type RunningWikiServer } from "../src/main";
import type { IConsolidatingLogger } from "../src/logger";

const JSON_CT = "application/json";
/** OCC seq: zero-padded so lexicographic == numeric (mirrors EventLog). */
const pad = (n: number): string => String(n).padStart(20, "0");

const running: RunningWikiServer[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) await r.stop();
});

describe("wiring smoke", () => {
  it("boots the wiring: the stream host serves and the control listener answers", async () => {
    // Capture what the wiring hands `wiki-mcp`, and stub the heavy module out.
    let mcpBaseUrl: string | undefined;
    let mcpLogger: IConsolidatingLogger | undefined;

    const cfg = resolveConfig(
      // Ephemeral ports for BOTH the stream host and the control listener so the
      // smoke test never collides with a real instance or another test run.
      ["--storage", "memory", "--port", "0", "--control-port", "0"],
      {},
    );

    const server = await startWikiServer(cfg, {
      startMcp: async (baseUrl, logger) => {
        mcpBaseUrl = baseUrl;
        mcpLogger = logger;
        // No real engine/read model; report the wire config the host would resolve,
        // pointed (as production does) at THIS host's live baseUrl.
        const config: WikiMcpConfig = {
          namespace: "smoke",
          streamBaseUrl: baseUrl,
          db: { kind: "pglite" },
          readConsistencyTimeoutMs: 5000,
          waitForPollMs: 50,
        };
        return { config };
      },
    });
    running.push(server);

    // ── the wiring pointed wiki-mcp at the INTERNAL stream host + the mcp logger ──
    // Not the public baseUrl: the front door owns that, and an in-process consumer
    // has no reason to take a proxy hop back to the host it is already beside.
    expect(mcpBaseUrl).toBeDefined();
    expect(mcpBaseUrl).not.toBe(server.baseUrl);
    expect(mcpLogger).toBeDefined();
    // The injected logger is the host's consolidating logger (mcp records land in the
    // same buffer the control listener reads).
    mcpLogger!.info("hello from mcp");
    expect(server.logger.history({ source: "mcp" }).records.map((r) => r.msg)).toContain("hello from mcp");

    // ── the stream host serves: create → append → read back as one message ──
    const url = `${server.baseUrl}/smoke/stream`;
    const handle = await DurableStream.create({ url, contentType: JSON_CT });
    await handle.append(JSON.stringify([{ ok: true }]), { seq: pad(0) });
    const res = await stream<unknown[]>({ url, offset: "-1", live: false });
    expect((await res.json()).flat()).toEqual([{ ok: true }]);

    // ── the control listener answers: health + info reflect the live wiring ──
    const health = await fetch(`${server.controlUrl}/_server/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });

    const info = await fetch(`${server.controlUrl}/_server/info`);
    expect(info.status).toBe(200);
    const facts = (await info.json()) as { storage: string; baseUrl: string; boot: string };
    expect(facts.storage).toBe("memory");
    expect(facts.baseUrl).toBe(server.baseUrl); // info reports the SAME live baseUrl
    expect(facts.boot).toBe(server.logger.boot);
  });

  it("serves attachments from the same public address as streams, with auth off", async () => {
    const cfg = resolveConfig(["--storage", "memory", "--port", "0", "--control-port", "0"], {});
    const server = await startWikiServer(cfg, {
      startMcp: async (baseUrl) => ({
        config: {
          namespace: "smoke",
          streamBaseUrl: baseUrl,
          db: { kind: "pglite" },
          readConsistencyTimeoutMs: 5000,
          waitForPollMs: 50,
        } satisfies WikiMcpConfig,
      }),
    });
    running.push(server);

    const png = Buffer.from("89504e470d0a1a0a", "hex");
    const blobs = `${server.baseUrl}/smoke/workspace/ws%3A1/blobs`;
    const up = await fetch(blobs, {
      method: "POST",
      headers: { "content-type": "image/png", "content-disposition": 'attachment; filename="shot.png"' },
      body: new Uint8Array(png),
    });
    expect(up.status).toBe(201);
    const { id } = (await up.json()) as { id: string };

    const down = await fetch(`${blobs}/${id}`);
    expect(down.status).toBe(200);
    expect(down.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await down.arrayBuffer()).equals(png)).toBe(true);
  });
});
