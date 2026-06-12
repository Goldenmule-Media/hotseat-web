/**
 * Auth-mode wiring smoke: `startWikiServer` with `--auth github` boots the
 * gateway as the PUBLIC stream address (the raw host hides on an internal
 * loopback port handed to wiki-mcp along with the injected `McpAuth`), the data
 * plane and control listener demand a bearer session, `/_server/health` stays
 * open for probes, and a signed session passes everywhere — including a real
 * stream round-trip through the gateway with the same client the engine uses.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { DurableStream } from "@durable-streams/client";
import type { McpAuth, WikiMcpConfig } from "wiki-mcp";

import { resolveConfig } from "../src/config";
import { startWikiServer, type RunningWikiServer } from "../src/main";
import type { McpTransport } from "wiki-mcp";
import { signSession } from "../src/auth/tokens";

const SECRET = "wiring-test-secret-wiring-test-secret";
const bearer = (login: string): Record<string, string> => ({
  authorization: `Bearer ${signSession(SECRET, { login }, 3600, Math.floor(Date.now() / 1000))}`,
});

const running: RunningWikiServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) await r.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("auth-mode wiring", () => {
  it("gates every plane behind the session and hands wiki-mcp the internal URL + McpAuth", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "wiki-authwiring-"));
    dirs.push(dataDir);

    let mcpBaseUrl: string | undefined;
    let mcpAuth: McpAuth | undefined;

    const cfg = resolveConfig(
      ["--storage", "memory", "--port", "0", "--control-port", "0", "--auth", "github", "--data-dir", dataDir],
      {
        WIKI_SERVER_GITHUB_CLIENT_ID: "cid",
        WIKI_SERVER_GITHUB_CLIENT_SECRET: "csecret",
        WIKI_SERVER_SESSION_SECRET: SECRET,
      },
    );

    let mcpTransport: McpTransport | undefined;
    const server = await startWikiServer(cfg, {
      startMcp: async (baseUrl, _logger, transport, auth) => {
        mcpBaseUrl = baseUrl;
        mcpTransport = transport;
        mcpAuth = auth;
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

    // The public baseUrl is the GATEWAY; wiki-mcp was pointed at a DIFFERENT
    // (internal) URL and given the auth hooks.
    expect(mcpBaseUrl).toBeDefined();
    expect(mcpBaseUrl).not.toBe(server.baseUrl);
    expect(mcpAuth).toBeDefined();
    expect(mcpAuth?.authenticate(bearer("alice"))?.login).toBe("alice");
    expect(mcpAuth?.authenticate({})).toBeUndefined();

    // The MCP transport carries host-injected OAuth discovery: its 401s will
    // advertise the gateway's resource-metadata URL, and its listener serves a
    // protected-resource document naming the gateway as authorization server.
    expect(mcpTransport?.kind).toBe("http");
    const discovery = mcpTransport?.kind === "http" ? mcpTransport.authDiscovery : undefined;
    expect(discovery?.resourceMetadataUrl).toBe(`${cfg.publicUrl}/.well-known/oauth-protected-resource`);
    expect(discovery?.protectedResourceDocument).toMatchObject({ authorization_servers: [cfg.publicUrl] });

    // Data plane: 401 bare (with RFC 9728 discovery), /auth/config public, full round-trip with a session.
    const bare = await fetch(`${server.baseUrl}/smoke/workspace/ws1`);
    expect(bare.status).toBe(401);
    expect(bare.headers.get("www-authenticate")).toContain("resource_metadata=");
    expect((await fetch(`${server.baseUrl}/auth/config`)).status).toBe(200);
    // The gateway serves both discovery documents publicly.
    expect((await fetch(`${server.baseUrl}/.well-known/oauth-authorization-server`)).status).toBe(200);
    expect((await fetch(`${server.baseUrl}/.well-known/oauth-protected-resource`)).status).toBe(200);

    const handle = await DurableStream.create({
      url: `${server.baseUrl}/smoke/workspace/ws1`,
      contentType: "application/json",
      headers: bearer("alice"),
    });
    await handle.append(JSON.stringify([{ ok: true }]));
    // Creation through the gateway attributed ownership → the McpAuth sees it too.
    expect(mcpAuth?.canAdmin({ login: "alice" }, "ws1")).toBe(true);
    expect(mcpAuth?.canAccess({ login: "bob" }, "ws1")).toBe(false);
    // Unclaimed workspaces stay administrable (open-until-claimed, same as content).
    expect(mcpAuth?.canAdmin({ login: "bob" }, "never-claimed")).toBe(true);

    // Control listener: health open, everything else gated.
    expect((await fetch(`${server.controlUrl}/_server/health`)).status).toBe(200);
    expect((await fetch(`${server.controlUrl}/_server/info`)).status).toBe(401);
    const info = await fetch(`${server.controlUrl}/_server/info`, { headers: bearer("alice") });
    expect(info.status).toBe(200);
    expect(((await info.json()) as { baseUrl: string }).baseUrl).toBe(server.baseUrl);
  });

  it("requires the GitHub app credentials and a valid mode", () => {
    expect(() => resolveConfig(["--auth", "github"], {})).toThrow(/WIKI_SERVER_GITHUB_CLIENT_ID/);
    expect(() => resolveConfig(["--auth", "saml"], {})).toThrow(/invalid --auth/);
  });
});
