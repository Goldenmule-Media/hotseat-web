import { describe, expect, it } from "vitest";
import { decodeTokenPayload } from "./auth";
import { classifyError } from "./wiki-host-api";

function b64url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("decodeTokenPayload", () => {
  it("decodes the wsv1 payload segment", () => {
    const payload = { sub: "octocat", name: "The Octocat", avatarUrl: "https://example.test/a.png", exp: 1750000000 };
    const token = `wsv1.${b64url(JSON.stringify(payload))}.sig`;
    expect(decodeTokenPayload(token)).toEqual(payload);
  });

  it("fills absent display fields with null", () => {
    const token = `wsv1.${b64url(JSON.stringify({ sub: "octocat", exp: 1 }))}.sig`;
    expect(decodeTokenPayload(token)).toEqual({ sub: "octocat", name: null, avatarUrl: null, exp: 1 });
  });

  it.each([
    ["a non-token string", "garbage"],
    ["a wrong prefix", `jwt.${b64url(JSON.stringify({ sub: "x", exp: 1 }))}.sig`],
    ["a non-JSON payload", "wsv1.!!!.sig"],
    ["a payload missing exp", `wsv1.${b64url(JSON.stringify({ sub: "x" }))}.sig`],
    ["a payload missing sub", `wsv1.${b64url(JSON.stringify({ exp: 1 }))}.sig`],
  ])("returns null for %s", (_label, token) => {
    expect(decodeTokenPayload(token)).toBeNull();
  });
});

describe("classifyError — unauthorized", () => {
  it("maps a transport status 401 (FetchError shape) to unauthorized", () => {
    expect(classifyError({ status: 401, message: "Unauthorized" }).kind).toBe("unauthorized");
  });

  it('maps code "UNAUTHORIZED" (DurableStreamError shape) to unauthorized', () => {
    expect(classifyError({ code: "UNAUTHORIZED", message: "Unauthorized" }).kind).toBe("unauthorized");
  });

  it("keeps a plain fetch rejection classified as connection", () => {
    expect(classifyError(new TypeError("Failed to fetch")).kind).toBe("connection");
  });

  it("keeps other coded engine errors classified as engine", () => {
    expect(classifyError({ code: "VALIDATION", message: "bad args" }).kind).toBe("engine");
  });
});

describe("classifyError — forbidden", () => {
  it("maps a transport status 403 (FetchError shape) to forbidden", () => {
    expect(classifyError({ status: 403, message: "forbidden: not a member" }).kind).toBe("forbidden");
  });

  it('maps code "FORBIDDEN" (DurableStreamError shape) to forbidden, not engine', () => {
    expect(classifyError({ code: "FORBIDDEN", message: "forbidden: not a member" }).kind).toBe("forbidden");
  });
});
