/**
 * The `attachment:` ref scheme and the blob client, against a REAL http server
 * standing in for wiki-server's blob endpoint (so header resolution and the
 * upload/download wire shape are exercised, not mocked).
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AttachmentClient,
  attachmentRef,
  attachmentRefsIn,
  parseAttachmentRef,
} from "../src/attachments";

const SHA = "a".repeat(64);

describe("attachment refs", () => {
  it("round-trips an id through the ref scheme", () => {
    expect(attachmentRef(SHA)).toBe(`attachment:${SHA}`);
    expect(parseAttachmentRef(attachmentRef(SHA))).toBe(SHA);
  });

  it("passes an ordinary URL through as not-an-attachment", () => {
    expect(parseAttachmentRef("https://example.com/cat.png")).toBeUndefined();
    expect(parseAttachmentRef("attachment:not-a-sha")).toBeUndefined();
  });

  it("harvests every distinct ref from a rendered body, in order", () => {
    const b = "b".repeat(64);
    const md = `![One](attachment:${SHA})\n\n![Two](attachment:${b})\n\n![Again](attachment:${SHA})`;
    expect(attachmentRefsIn(md)).toEqual([SHA, b]);
  });
});

describe("attachment client", () => {
  let server: Server;
  let base: string;
  const seen: { authorization?: string; disposition?: string; contentType?: string } = {};
  const stored = new Map<string, Buffer>();

  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.authorization = req.headers.authorization;
      if (req.method === "POST") {
        seen.disposition = req.headers["content-disposition"];
        seen.contentType = req.headers["content-type"];
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          const bytes = Buffer.concat(chunks);
          stored.set(SHA, bytes);
          res.writeHead(201, { "content-type": "application/json" });
          res.end(JSON.stringify({ id: SHA, mime: "image/png", name: "shot.png", size: bytes.byteLength }));
        });
        return;
      }
      const id = req.url!.split("/").pop()!;
      const bytes = stored.get(id);
      if (bytes === undefined) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "no such blob" }));
        return;
      }
      res.writeHead(200, { "content-type": "image/png", "content-disposition": 'inline; filename="shot.png"' });
      res.end(bytes);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  const client = (): AttachmentClient =>
    new AttachmentClient({
      baseUrl: base,
      namespace: "test",
      // A FUNCTION value, as the live auth seam supplies: resolved per request, so a
      // refreshed token takes effect without rebuilding the client.
      headers: { authorization: () => "Bearer live-token" },
    });

  it("builds a workspace-scoped download URL", () => {
    expect(client().urlFor("ws:1", SHA)).toBe(`${base}/test/workspace/ws%3A1/blobs/${SHA}`);
  });

  it("uploads with the resolved auth header and the filename on content-disposition", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const meta = await client().upload("ws:1", bytes, "image/png", "shot.png");
    expect(meta).toEqual({ id: SHA, mime: "image/png", name: "shot.png", size: 4 });
    expect(seen.authorization).toBe("Bearer live-token");
    expect(seen.contentType).toBe("image/png");
    expect(seen.disposition).toContain("shot.png");
  });

  it("downloads bytes and metadata, and reports a miss as undefined", async () => {
    await client().upload("ws:1", new Uint8Array([9, 9]), "image/png", "shot.png");
    const got = await client().download("ws:1", SHA);
    expect(Array.from(got!.bytes)).toEqual([9, 9]);
    expect(got!.meta.mime).toBe("image/png");
    expect(got!.meta.name).toBe("shot.png");
    expect(await client().download("ws:1", "b".repeat(64))).toBeUndefined();
  });

  it("surfaces a rejection as an AttachmentError carrying the server's status and message", async () => {
    // A 413 must not look like success or like a miss: the caller needs to tell the
    // user their file was too big, which means both the status and the reason survive.
    const reject = createServer((_req, res) => {
      res.writeHead(413, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "blob exceeds the 1024-byte limit" }));
    });
    await new Promise<void>((r) => reject.listen(0, "127.0.0.1", r));
    const rejectBase = `http://127.0.0.1:${(reject.address() as AddressInfo).port}`;
    try {
      const c = new AttachmentClient({ baseUrl: rejectBase, namespace: "test" });
      await expect(c.upload("ws:1", new Uint8Array([1]), "image/png", "big.png")).rejects.toMatchObject({
        name: "AttachmentError",
        status: 413,
        message: "blob exceeds the 1024-byte limit",
      });
    } finally {
      await new Promise<void>((r) => reject.close(() => r()));
    }
  });

  it("does not swallow an unreachable server", async () => {
    const dead = new AttachmentClient({ baseUrl: "http://127.0.0.1:1", namespace: "test" });
    await expect(dead.download("ws:1", SHA)).rejects.toThrow();
  });
});
