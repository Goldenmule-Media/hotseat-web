import { afterEach, describe, expect, it } from "vitest";
import { checkRequestAuth, classifyAuthConfig, getAuthMode, resetAuthCache, wikiBaseUrl } from "./wiki-auth";

afterEach(() => resetAuthCache());

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A typeof-fetch stub routed by URL; throwing entries simulate network failure. */
function fetchStub(handler: (url: string, init?: RequestInit) => Response | Error): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const out = handler(String(input), init);
    if (out instanceof Error) throw out;
    return out;
  }) as typeof fetch;
}

const authOn = (url: string): Response | Error =>
  url.endsWith("/auth/config") ? jsonRes(200, { enabled: true, provider: "github" }) : jsonRes(401, { error: "no" });

describe("wikiBaseUrl", () => {
  it("prefers WIKI_STREAM_BASE_URL, then the NEXT_PUBLIC fallback, then the default", () => {
    expect(wikiBaseUrl({ WIKI_STREAM_BASE_URL: "http://a:1/", NEXT_PUBLIC_WIKI_STREAM_BASE_URL: "http://b:2" })).toBe("http://a:1");
    expect(wikiBaseUrl({ NEXT_PUBLIC_WIKI_STREAM_BASE_URL: "http://b:2" })).toBe("http://b:2");
    expect(wikiBaseUrl({})).toBe("http://127.0.0.1:4437");
  });
});

describe("classifyAuthConfig", () => {
  it("a 2xx {enabled:true} means auth is required", () => {
    expect(classifyAuthConfig(200, { enabled: true, provider: "github" })).toBe("required");
  });

  it.each([
    ["the auth-off server's 404", 404, { error: "not found" }],
    ["a 2xx with enabled:false", 200, { enabled: false }],
    ["a 2xx with no usable body", 200, null],
    ["a 5xx", 500, {}],
  ])("%s means open", (_label, status, body) => {
    expect(classifyAuthConfig(status, body)).toBe("open");
  });
});

describe("getAuthMode", () => {
  it("classifies a network failure (both attempts) as unreachable", async () => {
    expect(await getAuthMode(fetchStub(() => new TypeError("fetch failed")))).toBe("unreachable");
  });

  it("retries once: a transient first failure still resolves", async () => {
    let calls = 0;
    const stub = fetchStub(() => (++calls === 1 ? new TypeError("blip") : jsonRes(200, { enabled: true })));
    expect(await getAuthMode(stub)).toBe("required");
    expect(calls).toBe(2);
  });

  it("caches the verdict so later calls skip the probe", async () => {
    let calls = 0;
    const stub = fetchStub(() => {
      calls++;
      return jsonRes(404, {});
    });
    expect(await getAuthMode(stub)).toBe("open");
    expect(await getAuthMode(stub)).toBe("open");
    expect(calls).toBe(1);
  });
});

describe("checkRequestAuth", () => {
  it("is open when the server says auth is off", async () => {
    expect(await checkRequestAuth(null, fetchStub(() => jsonRes(404, {})))).toEqual({ ok: true });
  });

  it("fails closed with 503 when the wiki server is unreachable", async () => {
    const out = await checkRequestAuth("Bearer tok", fetchStub(() => new TypeError("down")));
    expect(out).toEqual({ ok: false, status: 503, message: expect.stringContaining("wiki server unreachable") });
  });

  it("requires a bearer header when auth is on", async () => {
    expect(await checkRequestAuth(null, fetchStub(authOn))).toMatchObject({ ok: false, status: 401 });
    expect(await checkRequestAuth("Basic abc", fetchStub(authOn))).toMatchObject({ ok: false, status: 401 });
  });

  it("allows a token /auth/me accepts, forwarding the header verbatim", async () => {
    let sawAuth: string | undefined;
    const stub = fetchStub((url, init) => {
      if (url.endsWith("/auth/config")) return jsonRes(200, { enabled: true });
      sawAuth = new Headers(init?.headers).get("authorization") ?? undefined;
      return jsonRes(200, { user: { login: "octocat" } });
    });
    expect(await checkRequestAuth("Bearer wsv1.x.y", stub)).toEqual({ ok: true });
    expect(sawAuth).toBe("Bearer wsv1.x.y");
  });

  it("rejects a token /auth/me refuses", async () => {
    const out = await checkRequestAuth("Bearer stale", fetchStub(authOn));
    expect(out).toMatchObject({ ok: false, status: 401 });
  });

  it("fails closed when /auth/me itself is unreachable", async () => {
    const stub = fetchStub((url) =>
      url.endsWith("/auth/config") ? jsonRes(200, { enabled: true }) : new TypeError("down"),
    );
    expect(await checkRequestAuth("Bearer tok", stub)).toMatchObject({ ok: false, status: 503 });
  });
});
