"use client";

/**
 * GitHub-auth plumbing (tab side): bearer-token storage, the wiki-server auth-gateway
 * client, and the token decoder. The server is the security boundary — the UI holds no
 * secrets, only the opaque bearer token the gateway minted after the GitHub OAuth
 * redirect. React state lives in lib/auth-context.tsx; this module stays React-free so
 * lib/host-client.ts can import it without a cycle.
 *
 * Auth is OPTIONAL and server-driven: `GET {base}/auth/config` answers `{enabled:true}`
 * only when the gateway is on. When auth is off the server has no `/auth` routes at all,
 * so ANY failure (404, network error) classifies as auth-disabled and the app renders
 * exactly as it did before this feature existed.
 */

const TOKEN_KEY = "wiki.authToken";

/** Window event dispatched when any stream/RPC call surfaces a 401 — the AuthProvider
 *  listens, clears the dead token, and falls back to the login page. */
export const AUTH_UNAUTHORIZED_EVENT = "wiki-auth:unauthorized";

// ── token storage (localStorage; SSR-safe) ──────────────────────────────────────

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null; // storage blocked (private mode etc.) — behave as signed out
  }
}

export function setToken(token: string): void {
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // storage blocked — sign-in won't persist, but the page still redirects home
  }
}

export function clearToken(): void {
  try {
    window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    // nothing to clear if storage is blocked
  }
}

/** Broadcast a 401 to the AuthProvider (host-client and the live store call this). */
export function notifyUnauthorized(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(AUTH_UNAUTHORIZED_EVENT));
}

// ── token payload (display + client-side expiry pre-check ONLY) ─────────────────
// The token is opaque except its `wsv1.<base64url(json)>.<sig>` shape; /auth/me stays
// the validity authority at gate time.

export interface TokenPayload {
  /** GitHub login. */
  readonly sub: string;
  readonly name: string | null;
  readonly avatarUrl: string | null;
  /** Expiry, unix seconds. */
  readonly exp: number;
}

/** Decode the middle segment of `wsv1.<base64url(json)>.<sig>`; null on anything malformed. */
export function decodeTokenPayload(token: string): TokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "wsv1") return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    const json: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const p = json as { sub?: unknown; name?: unknown; avatarUrl?: unknown; exp?: unknown };
    if (typeof p.sub !== "string" || typeof p.exp !== "number") return null;
    return {
      sub: p.sub,
      name: typeof p.name === "string" ? p.name : null,
      avatarUrl: typeof p.avatarUrl === "string" ? p.avatarUrl : null,
      exp: p.exp,
    };
  } catch {
    return null;
  }
}

// ── the auth gateway (same origin as the Durable Stream base URL) ───────────────

/** Mirrors lib/config.ts's base-url resolution — kept separate so the TAB bundle doesn't
 *  pull the page-type bundles in just to learn the server origin (config.ts imports the
 *  models, which only the worker should carry). */
function authBase(): string {
  return (process.env.NEXT_PUBLIC_WIKI_STREAM_BASE_URL ?? "http://127.0.0.1:4437").replace(/\/+$/, "");
}

/** The wiki-server origin this tab talks to (the Durable Stream + auth gateway share it).
 *  Exported so views can name the URL in a "couldn't connect" message. */
export function serverBaseUrl(): string {
  return authBase();
}

export interface AuthConfig {
  readonly enabled: boolean;
  readonly provider?: string;
  /** False when BOTH config probes got no HTTP response at all — the server is unreachable
   *  (not merely "auth off"). Lets the workspace view show "couldn't connect" instead of
   *  spinning, since a down server makes every later stream call hang too. */
  readonly reachable: boolean;
}

let configP: Promise<AuthConfig> | null = null;

/** Drop the cached `/auth/config` verdict so the next {@link fetchAuthConfig} asks the
 *  server again. Used when a `disabled` verdict may have been a transient network failure
 *  — a later 401 proves a gateway exists (see the AuthProvider's unauthorized handler). */
export function resetAuthConfigCache(): void {
  configP = null;
}

/** One bounded attempt at `/auth/config`: a definitive server answer (any HTTP response —
 *  the auth-off server 404s its absent /auth routes) resolves to a config; a network
 *  failure or timeout resolves `null` so the caller can retry. */
async function tryFetchConfig(): Promise<AuthConfig | null> {
  try {
    const res = await fetch(`${authBase()}/auth/config`, { signal: AbortSignal.timeout(3000) });
    // Any HTTP response means the server is reachable — even the auth-off server's 404.
    if (!res.ok) return { enabled: false, reachable: true };
    const body = (await res.json()) as { enabled?: unknown; provider?: unknown };
    return {
      enabled: body.enabled === true,
      reachable: true,
      ...(typeof body.provider === "string" ? { provider: body.provider } : {}),
    };
  } catch {
    return null;
  }
}

/** The gateway's on/off switch, cached per page load. A definitive failure (the auth-off
 *  server has no /auth routes) → `{enabled:false}` → the app renders exactly as today. A
 *  TRANSIENT failure gets one retry before settling on disabled; if that verdict was still
 *  wrong, a later 401 resets the cache ({@link resetAuthConfigCache}) and re-asks. */
export function fetchAuthConfig(): Promise<AuthConfig> {
  if (configP === null) {
    configP = (async (): Promise<AuthConfig> => {
      // Two network failures in a row → the server is unreachable (reachable:false), distinct
      // from a definitive "auth off" answer (reachable:true, enabled:false).
      return (await tryFetchConfig()) ?? (await tryFetchConfig()) ?? { enabled: false, reachable: false };
    })();
  }
  return configP;
}

/** The full-page login redirect; the gateway 302s back to `/auth/complete#token=…`
 *  (token in the URL FRAGMENT, never sent to any server). */
export function signInUrl(): string {
  const redirect = encodeURIComponent(`${window.location.origin}/auth/complete`);
  return `${authBase()}/auth/github?redirect=${redirect}`;
}

/** `fetch` against the gateway with the current bearer token attached (when present). */
export function authFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = getToken();
  const headers = new Headers(init?.headers);
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  return fetch(`${authBase()}${path}`, { ...init, headers });
}

/** A 4xx/5xx gateway reply: the JSON `{error}` message plus the HTTP status. */
export class AuthApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AuthApiError";
  }
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await authFetch(path, init);
  if (!res.ok) {
    let message = `Auth request failed (HTTP ${res.status}).`;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === "string") message = body.error;
    } catch {
      // non-JSON error body — keep the status message
    }
    throw new AuthApiError(message, res.status);
  }
  return (await res.json()) as T;
}

export interface AuthUser {
  readonly login: string;
  readonly name: string | null;
  readonly avatarUrl: string | null;
}

export interface AuthMe {
  readonly user: AuthUser;
  /** Token expiry, unix seconds. */
  readonly exp: number;
  /** `restricted` = workspaces owned by someone else that don't include the caller —
   *  hidden from the workspace list. Ids absent from all three arrays are unclaimed
   *  (open to all signed-in users). */
  readonly workspaces: {
    readonly owned: readonly string[];
    readonly member: readonly string[];
    readonly restricted: readonly string[];
  };
}

/** The validity authority: 200 = the session stands, 401 ({@link AuthApiError}) = it doesn't. */
export function fetchMe(): Promise<AuthMe> {
  return requestJson<AuthMe>("/auth/me");
}

export interface WorkspaceMembers {
  /** GitHub login of the owner; `null` = unclaimed. */
  readonly owner: string | null;
  readonly members: readonly string[];
}

export function fetchMembers(workspaceId: string): Promise<WorkspaceMembers> {
  return requestJson<WorkspaceMembers>(`/auth/workspaces/${encodeURIComponent(workspaceId)}/members`);
}

export function addMember(workspaceId: string, login: string): Promise<WorkspaceMembers> {
  return requestJson<WorkspaceMembers>(`/auth/workspaces/${encodeURIComponent(workspaceId)}/members`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ login }),
  });
}

export function removeMember(workspaceId: string, login: string): Promise<WorkspaceMembers> {
  return requestJson<WorkspaceMembers>(
    `/auth/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(login)}`,
    { method: "DELETE" },
  );
}

export function claimWorkspace(workspaceId: string): Promise<WorkspaceMembers> {
  return requestJson<WorkspaceMembers>(`/auth/workspaces/${encodeURIComponent(workspaceId)}/claim`, {
    method: "POST",
  });
}
