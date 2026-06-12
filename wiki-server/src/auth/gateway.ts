/**
 * The auth gateway — the PUBLIC listener when `--auth github` is on. The real
 * stream host moves to an internal loopback port; this server takes its place
 * and does exactly two jobs:
 *
 *  1. **`/auth/*` routes** (served locally): the GitHub OAuth dance
 *     (`/auth/github` → GitHub → `/auth/github/callback` → signed session token,
 *     handed back in the redirect's URL FRAGMENT so it never hits a server log),
 *     `/auth/config` (does this server require auth?), `/auth/me`, and the
 *     per-workspace membership API (`/auth/workspaces/{id}/members[…]`, `/claim`).
 *
 *  2. **An authenticating reverse proxy** for everything else: verify the bearer
 *     session, authorize workspace streams by membership (the stream path embeds
 *     the workspace id: `/{ns}/workspace/{id}[…]`), then pipe the request to the
 *     internal stream host VERBATIM — bodies, status codes, OCC 409s, gzip, SSE,
 *     and long-polls all pass through untouched (both directions stream; nothing
 *     is buffered). A `PUT` that creates a workspace stream (upstream 201) records
 *     the caller as its owner — the single choke point every client (browser
 *     engine, mirror, MCP-less scripts) already goes through.
 *
 * OPTIONS preflights proxy through UNauthenticated (browsers send no credentials
 * on preflight; the stream host already answers permissive CORS). The embedded
 * wiki-mcp talks to the internal port directly and enforces the same ledger at
 * the tool layer (`McpAuth`), so identity is enforced per-surface, never trusted
 * across surfaces.
 */
import { createServer, request as httpRequest, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

import type { IConsolidatingLogger } from "../logger.js";
import { AccessError, AccessStore } from "./access.js";
import { authorizeUrl, exchangeCodeForUser, type GitHubOAuthConfig } from "./github.js";
import { bearerSession, signSession, signState, verifyState, type Session } from "./tokens.js";

export interface GatewayConfig {
  /** Bind address + port (the PUBLIC stream address clients use). */
  readonly host: string;
  readonly port: number;
  /** The internal stream host base URL to proxy to (loopback, unauthenticated). */
  readonly internalBaseUrl: string;
  /** This gateway's own external base URL (the OAuth callback host). */
  readonly publicUrl: string;
  /** Origins allowed as post-login redirect targets (the wiki-ui origins). */
  readonly uiOrigins: readonly string[];
  /**
   * GitHub logins (lowercase) allowed to SIGN IN at all. Unset → any GitHub
   * account may establish a session (membership still gates each workspace, but
   * unclaimed workspaces and the catalog are open to every signed-in user — set
   * this on any deployment that isn't intentionally public).
   */
  readonly allowedUsers?: readonly string[];
  readonly github: GitHubOAuthConfig;
  readonly sessionSecret: string;
  /** Session lifetime in seconds. */
  readonly sessionTtlSeconds: number;
  readonly store: AccessStore;
  readonly logger: IConsolidatingLogger;
  /** Unix-seconds clock (injected for token-expiry tests). */
  readonly nowSeconds?: () => number;
}

/** A running gateway. */
export interface Gateway {
  /** The bound public base URL (port read back, so `port: 0` works in tests). */
  readonly url: string;
  stop(): Promise<void>;
}

/** Hop-by-hop headers a proxy must not forward (RFC 9110 §7.6.1). */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);

/** CORS for gateway-AUTHORED responses (proxied ones carry the stream host's). */
const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, HEAD, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
};

/** The login-CSRF binding cookie: the OAuth state's nonce, set when the dance starts. */
const NONCE_COOKIE = "wiki_oauth_nonce";

/**
 * Split a pathname into decoded segments, or `undefined` when any segment holds
 * a malformed percent-escape (`%zz`…) — callers answer 400. `decodeURIComponent`
 * THROWS on those, and this runs on every request, so it must never escape.
 */
function pathSegments(pathname: string): string[] | undefined {
  try {
    return pathname.split("/").filter((s) => s.length > 0).map((s) => decodeURIComponent(s));
  } catch {
    return undefined;
  }
}

export async function startGateway(cfg: GatewayConfig): Promise<Gateway> {
  const log = cfg.logger.forSource("auth");
  const now = cfg.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  const internal = new URL(cfg.internalBaseUrl);

  /** Origins a post-login redirect may target: the UI origins + this gateway itself. */
  const allowedRedirectOrigins = new Set<string>([...cfg.uiOrigins, new URL(cfg.publicUrl).origin]);

  // ── small response helpers ──────────────────────────────────────────────────

  function json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { ...CORS_HEADERS, "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  function html(res: ServerResponse, status: number, body: string): void {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><body style="font-family: system-ui; max-width: 40rem; margin: 4rem auto">${body}</body></html>`);
  }

  function unauthenticated(res: ServerResponse): void {
    res.setHeader("www-authenticate", 'Bearer realm="wiki-server"');
    json(res, 401, { error: "unauthenticated" });
  }

  // ── /auth/* routes ──────────────────────────────────────────────────────────

  async function handleAuthRoute(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const method = req.method ?? "GET";
    if (method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }
    const segments = pathSegments(url.pathname);
    if (segments === undefined) {
      json(res, 400, { error: "malformed request path" });
      return;
    }
    // segments[0] === "auth"

    if (method === "GET" && url.pathname === "/auth/config") {
      json(res, 200, { enabled: true, provider: "github" });
      return;
    }

    if (method === "GET" && url.pathname === "/auth/github") {
      const redirect = url.searchParams.get("redirect") ?? undefined;
      if (redirect !== undefined && !isAllowedRedirect(redirect)) {
        json(res, 400, { error: `redirect target not in the allowed origins (${[...allowedRedirectOrigins].join(", ")})` });
        return;
      }
      // The nonce rides BOTH the signed state and a short-lived cookie; the
      // callback requires them to match, binding the round-trip to the browser
      // that started it (login-CSRF: a victim can't be handed someone else's
      // code+state, their cookie won't match). SameSite=Lax still sends the
      // cookie on the top-level GET redirect back from GitHub.
      const nonce = randomUUID();
      const state = signState(cfg.sessionSecret, redirect, nonce, now());
      res.writeHead(302, {
        location: authorizeUrl(cfg.github, state),
        "set-cookie": `${NONCE_COOKIE}=${nonce}; Max-Age=600; Path=/auth; HttpOnly; SameSite=Lax${cfg.publicUrl.startsWith("https://") ? "; Secure" : ""}`,
      });
      res.end();
      return;
    }

    if (method === "GET" && url.pathname === "/auth/github/callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const parsedState = state !== null ? verifyState(cfg.sessionSecret, state, now()) : undefined;
      if (code === null || parsedState === undefined) {
        html(res, 400, "<h1>Sign-in failed</h1><p>Missing or invalid OAuth state — start again from the app.</p>");
        return;
      }
      if (cookieValue(req.headers.cookie, NONCE_COOKIE) !== parsedState.nonce) {
        log.warn("OAuth callback nonce mismatch (possible login-CSRF)", {});
        html(res, 400, "<h1>Sign-in failed</h1><p>This sign-in did not start in this browser — start again from the app.</p>");
        return;
      }
      let token: string;
      let login: string;
      try {
        const user = await exchangeCodeForUser(cfg.github, code);
        login = user.login;
        if (cfg.allowedUsers !== undefined && !cfg.allowedUsers.includes(login)) {
          log.warn("sign-in refused: not in the allowed users", { login });
          html(res, 403, `<h1>Not authorized</h1><p><code>${login}</code> is not on this server's allowed-users list.</p>`);
          return;
        }
        token = signSession(cfg.sessionSecret, user, cfg.sessionTtlSeconds, now());
      } catch (err) {
        log.warn("GitHub code exchange failed", { error: err instanceof Error ? err.message : String(err) });
        html(res, 502, "<h1>Sign-in failed</h1><p>GitHub did not accept the sign-in. Try again.</p>");
        return;
      }
      log.info("user signed in", { login });
      // The nonce cookie is one-shot: expire it with the response that consumes it.
      res.setHeader("set-cookie", `${NONCE_COOKIE}=; Max-Age=0; Path=/auth; HttpOnly; SameSite=Lax`);
      if (parsedState.redirect !== undefined) {
        // The token rides the URL FRAGMENT: it reaches the app's JS but never a server log.
        res.writeHead(302, { location: `${parsedState.redirect}#token=${encodeURIComponent(token)}` });
        res.end();
        return;
      }
      html(
        res,
        200,
        `<h1>Signed in as ${login}</h1><p>Your API token (for <code>.mcp.json</code> / <code>WIKI_MIRROR_TOKEN</code>):</p>` +
          `<p><code style="word-break: break-all">${token}</code></p>`,
      );
      return;
    }

    // Everything below requires a valid session.
    const session = bearerSession(cfg.sessionSecret, req.headers.authorization, now());
    if (session === undefined) {
      unauthenticated(res);
      return;
    }

    if (method === "GET" && url.pathname === "/auth/me") {
      json(res, 200, {
        user: { login: session.login, name: session.name ?? null, avatarUrl: session.avatarUrl ?? null },
        exp: session.exp,
        workspaces: cfg.store.membershipsOf(session.login),
      });
      return;
    }

    // /auth/workspaces/{id}/members[/{login}] and /auth/workspaces/{id}/claim
    if (segments[1] === "workspaces" && segments.length >= 4) {
      const workspaceId = segments[2];
      try {
        await handleWorkspaceRoute(req, res, session, method, workspaceId, segments.slice(3));
        return;
      } catch (err) {
        if (err instanceof AccessError) {
          json(res, err.status, { error: err.message });
          return;
        }
        throw err;
      }
    }

    json(res, 404, { error: `unknown auth route: ${method} ${url.pathname}` });
  }

  async function handleWorkspaceRoute(
    req: IncomingMessage,
    res: ServerResponse,
    session: Session,
    method: string,
    workspaceId: string,
    rest: readonly string[],
  ): Promise<void> {
    const membersBody = (): { owner: string | null; members: readonly string[] } => {
      const rec = cfg.store.record(workspaceId);
      return { owner: rec?.owner ?? null, members: rec?.members ?? [] };
    };

    if (rest[0] === "members" && rest.length === 1 && method === "GET") {
      if (!cfg.store.canAccess(session.login, workspaceId)) {
        json(res, 403, { error: "not a member of this workspace" });
        return;
      }
      json(res, 200, membersBody());
      return;
    }

    if (rest[0] === "members" && rest.length === 1 && method === "POST") {
      const body = (await readJson(req)) as { login?: unknown } | undefined;
      if (typeof body?.login !== "string" || body.login.length === 0) {
        json(res, 400, { error: 'body must be {"login": "<github login>"}' });
        return;
      }
      const rec = cfg.store.addMember(session.login, workspaceId, body.login);
      log.info("member added", { workspace: workspaceId, by: session.login, member: body.login.toLowerCase() });
      json(res, 200, { owner: rec.owner, members: rec.members });
      return;
    }

    if (rest[0] === "members" && rest.length === 2 && method === "DELETE") {
      const rec = cfg.store.removeMember(session.login, workspaceId, rest[1]);
      log.info("member removed", { workspace: workspaceId, by: session.login, member: rest[1].toLowerCase() });
      json(res, 200, { owner: rec.owner, members: rec.members });
      return;
    }

    if (rest[0] === "claim" && rest.length === 1 && method === "POST") {
      if (!cfg.store.claim(session.login, workspaceId)) {
        json(res, 409, { error: `workspace ${workspaceId} already has an owner` });
        return;
      }
      log.info("workspace claimed", { workspace: workspaceId, owner: session.login });
      const rec = cfg.store.record(workspaceId);
      json(res, 200, { owner: rec?.owner ?? null, members: rec?.members ?? [] });
      return;
    }

    json(res, 404, { error: `unknown auth route: ${method} /auth/workspaces/…` });
  }

  function isAllowedRedirect(redirect: string): boolean {
    try {
      return allowedRedirectOrigins.has(new URL(redirect).origin);
    } catch {
      return false;
    }
  }

  // ── the authenticated reverse proxy (the data plane) ────────────────────────

  function proxy(req: IncomingMessage, res: ServerResponse, onResponse?: (status: number) => void): void {
    const headers: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (value !== undefined && !HOP_BY_HOP.has(key)) headers[key] = value;
    }
    const upstream = httpRequest(
      {
        host: internal.hostname,
        port: internal.port,
        method: req.method,
        path: req.url,
        headers,
      },
      (upstreamRes) => {
        onResponse?.(upstreamRes.statusCode ?? 0);
        const outHeaders: Record<string, string | string[]> = {};
        for (const [key, value] of Object.entries(upstreamRes.headers)) {
          if (value !== undefined && !HOP_BY_HOP.has(key)) outHeaders[key] = value;
        }
        res.writeHead(upstreamRes.statusCode ?? 502, outHeaders);
        // Pipe the body through unbuffered — SSE and long-polls stream chunk by chunk.
        upstreamRes.pipe(res);
        upstreamRes.on("error", () => res.destroy());
      },
    );
    upstream.on("error", (err) => {
      log.error("proxy upstream error", { method: req.method, path: req.url, error: err.message });
      if (!res.headersSent) json(res, 502, { error: "stream host unreachable" });
      else res.destroy();
    });
    // A client that walks away tears the upstream leg down with it (frees long-polls/SSE).
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  }

  function handleDataPlane(req: IncomingMessage, res: ServerResponse, url: URL): void {
    // Preflights carry no credentials by spec; the stream host answers them with
    // its permissive CORS (which is what lets the browser then SEND the bearer).
    if (req.method === "OPTIONS") {
      proxy(req, res);
      return;
    }

    const session = bearerSession(cfg.sessionSecret, req.headers.authorization, now());
    if (session === undefined) {
      unauthenticated(res);
      return;
    }

    const segments = pathSegments(url.pathname);
    if (segments === undefined) {
      json(res, 400, { error: "malformed request path" });
      return;
    }

    // DENY-BY-DEFAULT: the engine's clients only ever touch two path shapes —
    // `/{ns}/workspace/{id}[/snapshot]` (workspace-scoped → membership; DELETE
    // erases the stream → owner) and `/{ns}/_catalog` (the shared workspace
    // index, open to any signed-in user by design). The wrapped test server
    // exposes MORE than that (`/_test/*` fault injection, the subscription
    // plane), none of which an authenticated user may reach.
    const workspaceId = segments.length >= 3 && segments[1] === "workspace" ? segments[2] : undefined;
    if (workspaceId !== undefined) {
      if (!cfg.store.canAccess(session.login, workspaceId)) {
        json(res, 403, { error: "forbidden: not a member of this workspace", workspaceId });
        return;
      }
      const claimed = cfg.store.record(workspaceId) !== undefined;
      if (req.method === "DELETE" && claimed && !cfg.store.isOwner(session.login, workspaceId)) {
        json(res, 403, { error: "forbidden: only the owner may delete a workspace stream", workspaceId });
        return;
      }
    } else if (!(segments.length === 2 && segments[1] === "_catalog")) {
      json(res, 403, { error: "forbidden: path not allowed through the auth gateway" });
      return;
    }

    // A PUT that CREATES the workspace stream (201; an idempotent re-create answers
    // 200) makes the caller its owner — creation is the claim.
    const isWorkspaceCreate = req.method === "PUT" && workspaceId !== undefined && segments.length === 3;
    proxy(req, res, (status) => {
      if (isWorkspaceCreate && status === 201 && cfg.store.claim(session.login, workspaceId)) {
        log.info("workspace created and claimed", { workspace: workspaceId, owner: session.login });
      }
    });
  }

  // ── the listener ────────────────────────────────────────────────────────────

  const server: HttpServer = createServer((req, res) => {
    // `.then(() => …)` (NOT `Promise.resolve(handler())`) so a SYNCHRONOUS throw
    // anywhere in a handler becomes a rejection the catch below absorbs — an
    // escaped sync throw here would be an uncaught exception killing every
    // user's connection on the shared gateway.
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://gateway.local");
    } catch {
      json(res, 400, { error: "malformed request target" });
      return;
    }
    Promise.resolve()
      .then(() =>
        url.pathname === "/auth" || url.pathname.startsWith("/auth/")
          ? handleAuthRoute(req, res, url)
          : handleDataPlane(req, res, url),
      )
      .catch((err: unknown) => {
        log.error("gateway request failed", {
          method: req.method,
          path: url.pathname,
          error: err instanceof Error ? err.message : String(err),
        });
        if (!res.headersSent) json(res, 500, { error: "internal error" });
        else res.destroy();
      });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(cfg.port, cfg.host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const bound = server.address() as AddressInfo;
  const gatewayUrl = `http://${cfg.host}:${bound.port}`;
  log.info("auth gateway up", { url: gatewayUrl, internal: cfg.internalBaseUrl, provider: "github" });

  return {
    url: gatewayUrl,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        // Sever kept-alive sockets (idle clients, live SSE tails) so close() resolves.
        server.closeAllConnections();
      }),
  };
}

/** The value of one cookie on a request, or `undefined`. */
function cookieValue(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** Read a request body fully and JSON-parse it (`undefined` for an empty body). */
async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.length === 0) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new AccessError(400, "request body is not valid JSON");
  }
}
