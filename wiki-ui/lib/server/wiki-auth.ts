/**
 * Server-side auth gate for the /api/restate/* routes, keyed off the wiki server's
 * auth gateway. Deliberately differs from the browser's fail-open heuristic in
 * lib/auth.ts: a definitive HTTP answer decides required/open, but a probe that
 * gets NO response at all fails CLOSED (503) — these routes spend local compute
 * and must not run open just because the wiki server is down.
 */

export type AuthMode = "required" | "open" | "unreachable";

export type AuthDecision = { ok: true } | { ok: false; status: 401 | 503; message: string };

/**
 * The wiki server these routes probe.
 *
 * The literal `process.env.X` reads are load-bearing. Next replaces `process.env.NEXT_PUBLIC_*`
 * by TEXTUAL SUBSTITUTION at build time, which is the only way a build-time variable reaches a
 * running server on a host that does not inject env vars into its runtime (Amplify). Reading
 * the same name through a parameter (`env.NEXT_PUBLIC_…`) defeats that substitution, and the
 * deployed route then falls through to loopback and reports the wiki server unreachable when
 * nothing is wrong with the wiki. Pass `env` only from tests.
 */
export function wikiBaseUrl(env?: Record<string, string | undefined>): string {
  const raw =
    env !== undefined
      ? (env.WIKI_STREAM_BASE_URL ?? env.NEXT_PUBLIC_WIKI_STREAM_BASE_URL)
      : (process.env.WIKI_STREAM_BASE_URL ?? process.env.NEXT_PUBLIC_WIKI_STREAM_BASE_URL);
  return (raw ?? "http://127.0.0.1:4437").replace(/\/+$/, "");
}

/** A definitive HTTP answer: 2xx `{enabled:true}` = gateway on; anything else (incl.
 *  the auth-off server's 404 on its absent /auth routes) = auth off. */
export function classifyAuthConfig(status: number, body: unknown): "required" | "open" {
  if (status >= 200 && status < 300 && typeof body === "object" && body !== null) {
    if ((body as { enabled?: unknown }).enabled === true) return "required";
  }
  return "open";
}

async function probeOnce(fetchFn: typeof fetch): Promise<AuthMode | null> {
  try {
    const res = await fetchFn(`${wikiBaseUrl()}/auth/config`, { signal: AbortSignal.timeout(3_000) });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // non-JSON body — classify on status alone
    }
    return classifyAuthConfig(res.status, body);
  } catch {
    return null;
  }
}

const MODE_TTL_MS = 30_000;
// A transient blip should not lock the routes closed for the full TTL.
const UNREACHABLE_TTL_MS = 5_000;

let cache: { mode: AuthMode; expires: number } | null = null;

export function resetAuthCache(): void {
  cache = null;
}

/** Cached probe of `{base}/auth/config`; one retry before declaring unreachable. */
export async function getAuthMode(fetchFn: typeof fetch = fetch, now: () => number = Date.now): Promise<AuthMode> {
  if (cache !== null && now() < cache.expires) return cache.mode;
  const mode = (await probeOnce(fetchFn)) ?? (await probeOnce(fetchFn)) ?? "unreachable";
  cache = { mode, expires: now() + (mode === "unreachable" ? UNREACHABLE_TTL_MS : MODE_TTL_MS) };
  return mode;
}

/**
 * Gate a route request. Auth on → require a Bearer header, verified server-to-server
 * via `GET {base}/auth/me` (2xx = allowed). Auth off → open. Probe network failure →
 * fail closed with 503.
 */
export async function checkRequestAuth(
  authorization: string | null,
  fetchFn: typeof fetch = fetch,
): Promise<AuthDecision> {
  const mode = await getAuthMode(fetchFn);
  // Name the URL that was probed. The default is loopback, so a deployment missing
  // WIKI_STREAM_BASE_URL probes itself and the bare message reads like the wiki is down.
  if (mode === "unreachable") {
    return { ok: false, status: 503, message: `wiki server unreachable at ${wikiBaseUrl()}` };
  }
  if (mode === "open") return { ok: true };

  if (authorization === null || !/^bearer\s+\S/i.test(authorization)) {
    return { ok: false, status: 401, message: "missing bearer token" };
  }
  try {
    const res = await fetchFn(`${wikiBaseUrl()}/auth/me`, {
      headers: { authorization },
      signal: AbortSignal.timeout(5_000),
    });
    if (res.ok) return { ok: true };
    return { ok: false, status: 401, message: "invalid or expired token" };
  } catch {
    return { ok: false, status: 503, message: `wiki server unreachable at ${wikiBaseUrl()}` };
  }
}
