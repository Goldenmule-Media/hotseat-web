/**
 * Wiring smoke test (DESIGN §11). Boots the REAL process wiring — `startWikiServer`,
 * the same function the `bin` entry calls — and confirms BOTH planes it stands up
 * answer: the **stream host** serves a stream round-trip, and the **control
 * listener** answers `/_server/health` and `/_server/info`.
 *
 * The hosted `wiki-mcp` is injected via the `startMcp` seam so the smoke test
 * exercises the wiring (stream host → control listener, with `wiki-mcp` pointed at
 * the live `baseUrl`) without standing up the full engine + PGlite read model — that
 * surface is covered by `wiki-mcp`'s own suite (DESIGN §11). We still assert the
 * wiring fed `wiki-mcp` THIS host's localhost `baseUrl` and the host's `mcp` logger.
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

    // ── the wiring pointed wiki-mcp at THIS host's live baseUrl + the mcp logger ──
    expect(mcpBaseUrl).toBe(server.baseUrl);
    expect(mcpLogger).toBeDefined();
    // The injected logger is the host's consolidating logger (mcp records land in the
    // same buffer the control listener reads, DESIGN §8.5).
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
});
