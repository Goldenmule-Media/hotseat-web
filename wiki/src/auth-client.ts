/**
 * `wiki/auth-client` — the OAuth 2.1 client for Node CLIs (wiki-mirror,
 * wiki-mcp's migrate-workspace) against an auth-gated wiki-server. A NODE-ONLY
 * subpath export (like `wiki/testing`): it touches `node:fs`/`node:http`, so
 * the browser engine surface never imports it.
 *
 * The flow is the standard public-client dance the server's gateway exposes:
 * discover (RFC 9728 → RFC 8414) → register (RFC 7591) → authorize via a
 * loopback redirect (RFC 8252) with PKCE S256 → exchange the code → persist
 * `~/.wiki/credentials.json` (mode 0600, atomic temp+rename, keyed by server
 * origin). {@link oauthHeaders} then yields an {@link IStreamHeaders}-compatible
 * `authorization` FUNCTION — the engine evaluates header functions per request,
 * so a refresh (grant_type=refresh_token, run on demand near expiry) takes
 * effect on the very next stream request without rebuilding anything.
 *
 * The credentials file holds live tokens: never log its contents.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AddressInfo } from "node:net";

// ── credentials store ───────────────────────────────────────────────────────

/** One server's stored grant. */
export interface ServerCredentials {
  /** The `wsid1.…` client id minted by POST /auth/register. */
  readonly clientId: string;
  /** The current short-lived access token (`wsv1.…`). */
  readonly accessToken: string;
  /** Access-token expiry, unix seconds — refresh when `now >= exp - skew`. */
  readonly accessTokenExp: number;
  /** The current refresh token (`wsr1.…`, replaced on each rotation). */
  readonly refreshToken: string;
  /** Refresh-token expiry, unix seconds; once passed, a new login is required. */
  readonly refreshTokenExp: number;
  /** The token endpoint the grant came from (re-used for refresh). */
  readonly tokenEndpoint: string;
  /** The signed-in login — display only (`whoami`), never an ACL input. */
  readonly user: string;
}

/** The on-disk file shape: `{ servers: { "<origin>": ServerCredentials } }`. */
interface CredentialsFile {
  readonly servers: Record<string, ServerCredentials>;
}

/** The default credentials path: `~/.wiki/credentials.json` (HOME overridable for tests). */
export function defaultCredentialsPath(env: Record<string, string | undefined> = process.env): string {
  return join(env.HOME ?? homedir(), ".wiki", "credentials.json");
}

/**
 * Read/write `credentials.json`: atomic temp+rename writes, mode 0600 (it
 * holds live tokens), tolerant reads (a missing/corrupt file is "no
 * credentials", never a crash on a hot path).
 */
export class CredentialsStore {
  constructor(private readonly path: string = defaultCredentialsPath()) {}

  /** The stored grant for a server origin, or `undefined`. */
  get(serverUrl: string): ServerCredentials | undefined {
    return this.readFile().servers[originOf(serverUrl)];
  }

  /** Store (insert or replace) a server origin's grant. */
  set(serverUrl: string, credentials: ServerCredentials): void {
    const file = this.readFile();
    file.servers[originOf(serverUrl)] = credentials;
    this.writeFile(file);
  }

  /** Forget a server origin's grant (logout). Returns whether one existed. */
  delete(serverUrl: string): boolean {
    const file = this.readFile();
    const key = originOf(serverUrl);
    if (!(key in file.servers)) return false;
    delete file.servers[key];
    this.writeFile(file);
    return true;
  }

  private readFile(): CredentialsFile {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<CredentialsFile>;
      if (typeof parsed === "object" && parsed !== null && typeof parsed.servers === "object" && parsed.servers !== null) {
        return { servers: { ...parsed.servers } };
      }
    } catch {
      /* missing or corrupt → empty */
    }
    return { servers: {} };
  }

  private writeFile(file: CredentialsFile): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, this.path);
    // rename preserves the temp file's mode, but harden against a pre-existing
    // target created with a looser mask.
    chmodSync(this.path, 0o600);
  }
}

const originOf = (url: string): string => new URL(url).origin;

// ── discovery (RFC 9728 → RFC 8414) ─────────────────────────────────────────

/** What the client needs from the authorization-server metadata. */
export interface AuthServerMetadata {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly registrationEndpoint: string;
}

/**
 * Resolve a (possibly protected) server URL to its authorization-server
 * metadata: try the origin's protected-resource document first (its
 * `authorization_servers[0]` names the AS), falling back to treating the origin
 * AS the authorization server directly.
 */
export async function discoverAuthServer(serverUrl: string, fetchImpl: typeof fetch = fetch): Promise<AuthServerMetadata> {
  const origin = originOf(serverUrl);
  let asBase = origin;
  try {
    const res = await fetchImpl(`${origin}/.well-known/oauth-protected-resource`);
    if (res.ok) {
      const doc = (await res.json()) as { authorization_servers?: unknown };
      if (Array.isArray(doc.authorization_servers) && typeof doc.authorization_servers[0] === "string") {
        asBase = doc.authorization_servers[0].replace(/\/+$/, "");
      }
    }
  } catch {
    /* fall back to the origin */
  }
  const res = await fetchImpl(`${asBase}/.well-known/oauth-authorization-server`);
  if (!res.ok) {
    throw new Error(`auth-server discovery failed: ${asBase}/.well-known/oauth-authorization-server answered HTTP ${res.status}`);
  }
  const meta = (await res.json()) as Record<string, unknown>;
  const str = (key: string): string => {
    const v = meta[key];
    if (typeof v !== "string" || v.length === 0) throw new Error(`auth-server metadata is missing "${key}"`);
    return v;
  };
  return {
    issuer: str("issuer"),
    authorizationEndpoint: str("authorization_endpoint"),
    tokenEndpoint: str("token_endpoint"),
    registrationEndpoint: str("registration_endpoint"),
  };
}

/** Register this CLI as a public client (RFC 7591) → the minted client_id. */
export async function registerClient(
  registrationEndpoint: string,
  redirectUris: readonly string[],
  clientName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchImpl(registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: redirectUris, client_name: clientName, token_endpoint_auth_method: "none" }),
  });
  const body = (await res.json()) as { client_id?: unknown; error_description?: unknown };
  if (!res.ok || typeof body.client_id !== "string") {
    throw new Error(`client registration failed: HTTP ${res.status}${typeof body.error_description === "string" ? ` — ${body.error_description}` : ""}`);
  }
  return body.client_id;
}

// ── the loopback login (RFC 8252) ───────────────────────────────────────────

export interface LoginOptions {
  /** The wiki-server base URL (any URL on the gateway origin works). */
  readonly serverUrl: string;
  /** Shown on the server's consent/registration records. @default "wiki-cli" */
  readonly clientName?: string;
  /** Where to persist the grant. @default the real `~/.wiki/credentials.json` */
  readonly store?: CredentialsStore;
  readonly fetchImpl?: typeof fetch;
  /**
   * Receives the URL the user must visit. The default prints it to stderr and
   * asks the OS to open a browser; tests drive the URL themselves.
   */
  readonly onAuthorizeUrl?: (url: string) => void;
  /** Abort the login if no redirect arrives in time. @default 300_000 (5 min) */
  readonly timeoutMs?: number;
}

/** RFC 7636 §4.1: 32 random bytes, base64url — the code_verifier. */
const newCodeVerifier = (): string => randomBytes(32).toString("base64url");

/** The S256 challenge for a verifier. */
const s256 = (verifier: string): string => createHash("sha256").update(verifier, "utf8").digest("base64url");

/** Best-effort decode of a signed blob's payload expiry (our own token shape). */
function tokenExp(token: string, fallback: number): number {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { exp?: unknown };
    return typeof payload.exp === "number" ? payload.exp : fallback;
  } catch {
    return fallback;
  }
}

/** Default `onAuthorizeUrl`: print the URL and ask the OS to open it (best-effort). */
function openInBrowser(url: string): void {
  console.error(`\nOpen this URL to sign in:\n\n  ${url}\n`);
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(cmd, [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {
    /* printing the URL is the contract; the browser launch is a courtesy */
  }
}

/**
 * Sign in to a server: bind a loopback listener, send the user through
 * `/auth/authorize` (PKCE S256), exchange the redirected code, persist and
 * return the grant. Resolves once tokens are stored; rejects on timeout,
 * an OAuth `error` redirect, or a failed exchange.
 */
export async function loginLoopback(opts: LoginOptions): Promise<ServerCredentials> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const store = opts.store ?? new CredentialsStore();
  const meta = await discoverAuthServer(opts.serverUrl, fetchImpl);

  // The loopback listener: an OS-assigned port on 127.0.0.1, one redirect.
  const server: Server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  try {
    const clientId = await registerClient(meta.registrationEndpoint, [redirectUri], opts.clientName ?? "wiki-cli", fetchImpl);

    const verifier = newCodeVerifier();
    const state = randomBytes(16).toString("base64url");
    const authorizeUrl = new URL(meta.authorizationEndpoint);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("code_challenge", s256(verifier));
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("state", state);

    // Await the redirect BEFORE announcing the URL — no race with a fast client.
    const codePromise = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`login timed out after ${(opts.timeoutMs ?? 300_000) / 1000}s waiting for the browser redirect`)),
        opts.timeoutMs ?? 300_000,
      );
      timer.unref();
      server.on("request", (req, res) => {
        const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
        if (url.pathname !== "/callback") {
          res.statusCode = 404;
          res.end("Not Found");
          return;
        }
        const fail = (message: string): void => {
          res.writeHead(400, { "content-type": "text/plain" });
          res.end(`Sign-in failed: ${message}`);
          clearTimeout(timer);
          reject(new Error(message));
        };
        const err = url.searchParams.get("error");
        if (err !== null) {
          fail(`${err}: ${url.searchParams.get("error_description") ?? ""}`);
          return;
        }
        if (url.searchParams.get("state") !== state) {
          fail("state mismatch (the redirect did not come from this login attempt)");
          return;
        }
        const code = url.searchParams.get("code");
        if (code === null) {
          fail("redirect carried no code");
          return;
        }
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<!doctype html><body style=\"font-family: system-ui\"><h1>Signed in</h1><p>You can close this tab and return to the terminal.</p></body>");
        clearTimeout(timer);
        resolve(code);
      });
    });

    (opts.onAuthorizeUrl ?? openInBrowser)(authorizeUrl.toString());
    const code = await codePromise;

    const tokens = await exchangeToken(meta.tokenEndpoint, fetchImpl, {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: redirectUri,
    });
    const nowSeconds = Math.floor(Date.now() / 1000);
    const credentials: ServerCredentials = {
      clientId,
      accessToken: tokens.access_token,
      accessTokenExp: nowSeconds + tokens.expires_in,
      refreshToken: tokens.refresh_token,
      refreshTokenExp: tokenExp(tokens.refresh_token, nowSeconds),
      tokenEndpoint: meta.tokenEndpoint,
      user: tokenUser(tokens.access_token),
    };
    store.set(opts.serverUrl, credentials);
    return credentials;
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
}

/** Best-effort decode of the access token's `sub` for display. */
function tokenUser(accessToken: string): string {
  try {
    const payload = JSON.parse(Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString("utf8")) as { sub?: unknown };
    return typeof payload.sub === "string" ? payload.sub : "unknown";
  } catch {
    return "unknown";
  }
}

interface TokenResponseBody {
  readonly access_token: string;
  readonly expires_in: number;
  readonly refresh_token: string;
}

async function exchangeToken(
  tokenEndpoint: string,
  fetchImpl: typeof fetch,
  form: Record<string, string>,
): Promise<TokenResponseBody> {
  const res = await fetchImpl(tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  const body = (await res.json()) as Partial<TokenResponseBody> & { error?: unknown; error_description?: unknown };
  if (!res.ok || typeof body.access_token !== "string" || typeof body.refresh_token !== "string" || typeof body.expires_in !== "number") {
    const detail = typeof body.error_description === "string" ? body.error_description : typeof body.error === "string" ? body.error : `HTTP ${res.status}`;
    throw new Error(`token request failed: ${detail}`);
  }
  return { access_token: body.access_token, expires_in: body.expires_in, refresh_token: body.refresh_token };
}

// ── the refreshing header factory ───────────────────────────────────────────

export interface OAuthHeadersOptions {
  readonly store?: CredentialsStore;
  readonly fetchImpl?: typeof fetch;
  /** Refresh this many seconds BEFORE the access token expires. @default 60 */
  readonly skewSeconds?: number;
  /** Unix-seconds clock (injected for tests). */
  readonly nowSeconds?: () => number;
}

/**
 * An `IStreamHeaders`-compatible `authorization` value for a server with stored
 * credentials: returns the cached access token while fresh, refreshing through
 * the token endpoint (rotating the stored refresh token) when within
 * `skewSeconds` of expiry. Concurrent callers share one in-flight refresh.
 * Throws (failing the stream request, not the process) when no credentials
 * exist or the refresh grant itself has expired — both mean "run login again".
 */
export function oauthHeaders(
  serverUrl: string,
  opts: OAuthHeadersOptions = {},
): { readonly authorization: () => Promise<string> } {
  const store = opts.store ?? new CredentialsStore();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const skew = opts.skewSeconds ?? 60;
  const now = opts.nowSeconds ?? ((): number => Math.floor(Date.now() / 1000));
  let inFlight: Promise<string> | undefined;

  async function refresh(stale: ServerCredentials): Promise<string> {
    const tokens = await exchangeToken(stale.tokenEndpoint, fetchImpl, {
      grant_type: "refresh_token",
      refresh_token: stale.refreshToken,
      client_id: stale.clientId,
    });
    const nowSeconds = now();
    store.set(serverUrl, {
      ...stale,
      accessToken: tokens.access_token,
      accessTokenExp: nowSeconds + tokens.expires_in,
      refreshToken: tokens.refresh_token,
      refreshTokenExp: tokenExp(tokens.refresh_token, stale.refreshTokenExp),
    });
    return tokens.access_token;
  }

  return {
    authorization: async (): Promise<string> => {
      const credentials = store.get(serverUrl);
      if (credentials === undefined) {
        throw new Error(`no stored credentials for ${originOf(serverUrl)} — sign in first (wiki-mirror login)`);
      }
      if (now() < credentials.accessTokenExp - skew) {
        return `Bearer ${credentials.accessToken}`;
      }
      inFlight ??= refresh(credentials).finally(() => {
        inFlight = undefined;
      });
      return `Bearer ${await inFlight}`;
    },
  };
}
