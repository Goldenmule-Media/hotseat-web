/**
 * The content-addressed blob store and its HTTP surface, exercised WITHOUT the rest
 * of the server: a real `http.createServer` in front of `handleBlobRequest`, standing
 * in for whatever authenticates the request upstream.
 *
 * The store is meant to be file-type-agnostic, so the round-trip is asserted for a PNG
 * AND a PDF rather than assumed from the image case.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BlobStore, blobId, isBlobId, mimeAllowed, sanitizeName } from "../src/blobs/store";
import { filenameFrom, handleBlobRequest, matchBlobRoute } from "../src/blobs/routes";

const MAX = 1024 * 64;
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"); // a PNG signature + header start
const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n", "utf8");

describe("blob store", () => {
  let dir: string;
  let store: BlobStore;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "wiki-blobs-"));
    store = new BlobStore({ dir, maxBytes: MAX, mimeAllow: ["image/*", "application/pdf"] });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("addresses a blob by the sha256 of its content", async () => {
    const meta = await store.put("ws:1", PNG, "image/png", "shot.png");
    expect(meta.id).toBe(createHash("sha256").update(PNG).digest("hex"));
    expect(meta).toMatchObject({ mime: "image/png", name: "shot.png", size: PNG.byteLength });
  });

  it("is idempotent — identical bytes yield the identical id", async () => {
    const a = await store.put("ws:1", PDF, "application/pdf", "report.pdf");
    const b = await store.put("ws:1", PDF, "application/pdf", "report.pdf");
    expect(b.id).toBe(a.id);
  });

  it("round-trips a PDF as faithfully as an image", async () => {
    const { id } = await store.put("ws:2", PDF, "application/pdf", "Q3-report.pdf");
    const found = await store.get("ws:2", id);
    expect(found?.bytes.equals(PDF)).toBe(true);
    expect(found?.meta.mime).toBe("application/pdf");
    expect(found?.meta.name).toBe("Q3-report.pdf");
  });

  it("keeps the first name when identical bytes are re-uploaded under another", async () => {
    // Identity is the content hash, so this is one blob. The name a reader sees belongs
    // to the REFERENCE (an attachment-ref's `name`, an image block's `alt`), not here.
    const first = await store.put("ws:3", PDF, "application/pdf", "first.pdf");
    const second = await store.put("ws:3", PDF, "application/pdf", "second.pdf");
    expect(second.id).toBe(first.id);
    expect(second.name).toBe("first.pdf");
  });

  it("scopes blobs to a workspace", async () => {
    const { id } = await store.put("ws:1", PNG, "image/png", "shot.png");
    expect(await store.get("ws:other", id)).toBeUndefined();
  });

  it("rejects an oversized blob and a disallowed mime", async () => {
    await expect(store.put("ws:1", Buffer.alloc(MAX + 1, 7), "image/png", "big.png")).rejects.toThrow(/limit/);
    await expect(store.put("ws:1", PNG, "application/zip", "x.zip")).rejects.toThrow(/not an allowed/);
  });

  it("rejects an empty body", async () => {
    await expect(store.put("ws:1", Buffer.alloc(0), "image/png", "empty.png")).rejects.toThrow(/nothing to store/);
  });
});

describe("blob helpers", () => {
  it("matches only the workspace-scoped blob path shape", () => {
    expect(matchBlobRoute(["default", "workspace", "ws:1", "blobs"])).toEqual({ workspaceId: "ws:1" });
    expect(matchBlobRoute(["default", "workspace", "ws:1", "blobs", "abc"])).toEqual({ workspaceId: "ws:1", id: "abc" });
    expect(matchBlobRoute(["default", "workspace", "ws:1"])).toBeUndefined();
    expect(matchBlobRoute(["default", "_catalog"])).toBeUndefined();
    expect(matchBlobRoute(["default", "workspace", "ws:1", "blobs", "a", "b"])).toBeUndefined();
  });

  it("honours exact and wildcard mime allowlist entries", () => {
    expect(mimeAllowed("image/png", ["image/*"])).toBe(true);
    expect(mimeAllowed("application/pdf", ["image/*", "application/pdf"])).toBe(true);
    expect(mimeAllowed("application/zip", ["image/*", "application/pdf"])).toBe(false);
    expect(mimeAllowed("image/png; charset=binary", ["image/*"])).toBe(true);
  });

  it("reads a filename from either content-disposition form", () => {
    expect(filenameFrom('attachment; filename="a.pdf"')).toBe("a.pdf");
    expect(filenameFrom("attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf")).toBe("résumé.pdf");
    expect(filenameFrom(undefined)).toBeUndefined();
  });

  it("never lets a supplied filename carry a path or a header break", () => {
    expect(sanitizeName("../../etc/passwd", "fallback")).toBe("passwd");
    expect(sanitizeName('a"b\nc', "fallback")).toBe("abc");
    expect(sanitizeName("", "fallback")).toBe("fallback");
  });

  it("recognises a blob id", () => {
    expect(isBlobId(blobId(PNG))).toBe(true);
    expect(isBlobId("nope")).toBe(false);
    expect(isBlobId("../../etc/passwd")).toBe(false);
  });
});

describe("blob routes", () => {
  let dir: string;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "wiki-blob-routes-"));
    const store = new BlobStore({ dir, maxBytes: MAX, mimeAllow: ["image/*", "application/pdf"] });
    server = createServer((req, res) => {
      const segments = new URL(req.url ?? "/", "http://x").pathname.split("/").filter((s) => s.length > 0).map(decodeURIComponent);
      const route = matchBlobRoute(segments);
      if (route === undefined) {
        res.writeHead(404).end();
        return;
      }
      void handleBlobRequest(req, res, route, { store, maxBytes: MAX });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/default/workspace/ws%3A1/blobs`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  const upload = (body: Buffer, mime: string, name: string): Promise<Response> =>
    fetch(base, {
      method: "POST",
      headers: { "content-type": mime, "content-disposition": `attachment; filename="${name}"` },
      body: new Uint8Array(body),
    });

  it("uploads and downloads a PNG", async () => {
    const res = await upload(PNG, "image/png", "shot.png");
    expect(res.status).toBe(201);
    const meta = (await res.json()) as { id: string; mime: string; name: string; size: number };
    expect(meta.id).toBe(blobId(PNG));

    const got = await fetch(`${base}/${meta.id}`);
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("image/png");
    expect(got.headers.get("cache-control")).toContain("immutable");
    expect(Buffer.from(await got.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it("uploads and downloads a PDF under its original filename", async () => {
    const res = await upload(PDF, "application/pdf", "Q3-report.pdf");
    const meta = (await res.json()) as { id: string };
    const got = await fetch(`${base}/${meta.id}`);
    expect(got.headers.get("content-type")).toBe("application/pdf");
    expect(got.headers.get("content-disposition")).toContain("Q3-report.pdf");
    expect(Buffer.from(await got.arrayBuffer()).equals(PDF)).toBe(true);
  });

  it("returns the same id for a re-upload of identical bytes", async () => {
    const a = (await (await upload(PDF, "application/pdf", "one.pdf")).json()) as { id: string };
    const b = (await (await upload(PDF, "application/pdf", "two.pdf")).json()) as { id: string };
    expect(b.id).toBe(a.id);
  });

  it("HEADs a blob without a body, and 404s an unknown one", async () => {
    const { id } = (await (await upload(PNG, "image/png", "shot.png")).json()) as { id: string };
    const head = await fetch(`${base}/${id}`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(PNG.byteLength));
    expect((await fetch(`${base}/${"0".repeat(64)}`)).status).toBe(404);
  });

  it("rejects an oversized upload and a disallowed mime", async () => {
    expect((await upload(Buffer.alloc(MAX + 1, 7), "image/png", "big.png")).status).toBe(413);
    expect((await upload(PNG, "application/zip", "x.zip")).status).toBe(415);
  });

  it("requires a declared content-type", async () => {
    const res = await fetch(base, { method: "POST", body: new Uint8Array(PNG), headers: { "content-type": "" } });
    expect(res.status).toBe(400);
  });
});
