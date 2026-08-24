/**
 * How the mirror is authenticating, as a JSON-safe snapshot for the health endpoint.
 *
 * An expired OAuth grant is this service's quietest failure: every stream request starts
 * failing, each workspace drops out of the tail, and the only symptom is Markdown that stops
 * changing. Publishing the grant's state (and its expiry) turns that into something a status
 * icon can shout about. Read fresh from disk per call — cheap, and it picks up a `wiki-mirror
 * login` from another process with no restart. NEVER carries a token value.
 */
import { CredentialsStore } from "wiki/auth-client";

/** The authentication snapshot published at `GET /_mirror/status`. */
export interface AuthStatus {
  /** `token` = a static bearer from flags/env/file; `oauth` = a stored grant; `none` = an open server. */
  readonly mode: "token" | "oauth" | "none";
  /** Origin the credentials belong to. */
  readonly server: string;
  /** The signed-in login (oauth only) — display only. */
  readonly user?: string;
  /** Access-token expiry, epoch ms (oauth only). Passing it is normal — it self-refreshes. */
  readonly accessTokenExpiresAt?: number;
  /** Refresh-grant expiry, epoch ms (oauth only); 0/absent when the blob didn't decode. */
  readonly refreshTokenExpiresAt?: number;
  /** True when the refresh grant itself has expired: only a new `wiki-mirror login` fixes it. */
  readonly expired: boolean;
}

export interface AuthStatusOptions {
  /** An explicit static token, if one was configured (its VALUE is never read here — only its presence). */
  readonly hasExplicitToken?: boolean;
  readonly store?: CredentialsStore;
  /** Epoch-ms clock (injected for tests). */
  readonly now?: () => number;
}

/** Snapshot the credentials the mirror would use for `streamBaseUrl` right now. */
export function readAuthStatus(streamBaseUrl: string, opts: AuthStatusOptions = {}): AuthStatus {
  const server = originOf(streamBaseUrl);
  if (opts.hasExplicitToken === true) return { mode: "token", server, expired: false };

  const store = opts.store ?? new CredentialsStore();
  const credentials = store.get(streamBaseUrl);
  if (credentials === undefined) return { mode: "none", server, expired: false };

  const nowSeconds = Math.floor((opts.now ?? Date.now)() / 1000);
  return {
    mode: "oauth",
    server,
    user: credentials.user,
    accessTokenExpiresAt: credentials.accessTokenExp * 1000,
    refreshTokenExpiresAt: credentials.refreshTokenExp * 1000,
    expired: credentials.refreshTokenExp > 0 && nowSeconds >= credentials.refreshTokenExp,
  };
}

/** The origin of a URL, or the input verbatim when it isn't parseable. */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}
