import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { IWiki } from "../src/api";
import { featurePageTypes } from "wiki-models/feature";
import { startTestServer, wikiOn, type ITestServer } from "../src/testing";

describe("openWorkspace: concurrent opens", () => {
  let server: ITestServer;
  let writer: IWiki;
  let reader: IWiki;

  beforeEach(async () => {
    server = await startTestServer();
    writer = wikiOn(server.url, featurePageTypes);
    reader = wikiOn(server.url, featurePageTypes);
  });

  afterEach(async () => {
    await writer.close();
    await reader.close();
    await server.stop();
  });

  it("resolves concurrent opens of one workspace to a single handle", async () => {
    const ws = await writer.createWorkspace({ name: "Shared" });
    const [a, b, c] = await Promise.all([
      reader.openWorkspace(ws.id),
      reader.openWorkspace(ws.id),
      reader.openWorkspace(ws.id),
    ]);
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(await reader.openWorkspace(ws.id)).toBe(a);
  });

  it("lets a failed open be retried", async () => {
    const missing = "ws:does-not-exist" as Parameters<IWiki["openWorkspace"]>[0];
    const results = await Promise.allSettled([reader.openWorkspace(missing), reader.openWorkspace(missing)]);
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    await expect(reader.openWorkspace(missing)).rejects.toThrow();
  });
});
