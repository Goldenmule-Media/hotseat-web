/**
 * The GitHub OAuth web-application flow, hand-rolled on `fetch` (three
 * requests; a client library would be heavier than the protocol). The gateway
 * drives it: build the authorize redirect → exchange the callback `code` for an
 * access token → read the user's public profile. The GitHub access token is
 * used ONCE for that profile read and discarded — our own signed session is the
 * credential from then on, so no GitHub token is ever stored.
 *
 * `fetchImpl` is injectable so tests stub GitHub without network.
 */

/** What the gateway needs to know about the signed-in GitHub account. */
export interface GitHubUser {
  /** GitHub login, LOWERCASED (logins are case-insensitive; ACL keys must be too). */
  readonly login: string;
  readonly name?: string;
  readonly avatarUrl?: string;
}

export interface GitHubOAuthConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  /** Absolute callback URL registered on the OAuth app (`{publicUrl}/auth/github/callback`). */
  readonly callbackUrl: string;
  readonly fetchImpl?: typeof fetch;
}

const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";

/** The GitHub authorize redirect for one login attempt (no scopes: public profile only). */
export function authorizeUrl(cfg: GitHubOAuthConfig, state: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("redirect_uri", cfg.callbackUrl);
  url.searchParams.set("state", state);
  return url.toString();
}

/**
 * Exchange the callback `code` for the signed-in user's profile. Throws a
 * descriptive error on any refusal (the gateway maps it to a 502 page).
 */
export async function exchangeCodeForUser(cfg: GitHubOAuthConfig, code: string): Promise<GitHubUser> {
  const fetchImpl = cfg.fetchImpl ?? fetch;

  const tokenRes = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code,
      redirect_uri: cfg.callbackUrl,
    }),
  });
  if (!tokenRes.ok) throw new Error(`GitHub token exchange failed: HTTP ${tokenRes.status}`);
  const tokenBody = (await tokenRes.json()) as { access_token?: string; error?: string; error_description?: string };
  if (typeof tokenBody.access_token !== "string") {
    throw new Error(`GitHub token exchange refused: ${tokenBody.error_description ?? tokenBody.error ?? "no access_token"}`);
  }

  const userRes = await fetchImpl(USER_URL, {
    headers: {
      authorization: `Bearer ${tokenBody.access_token}`,
      accept: "application/vnd.github+json",
      "user-agent": "wiki-server",
    },
  });
  if (!userRes.ok) throw new Error(`GitHub user fetch failed: HTTP ${userRes.status}`);
  const user = (await userRes.json()) as { login?: string; name?: string | null; avatar_url?: string | null };
  if (typeof user.login !== "string" || user.login.length === 0) {
    throw new Error("GitHub user fetch returned no login");
  }
  return {
    login: user.login.toLowerCase(),
    ...(typeof user.name === "string" && user.name.length > 0 ? { name: user.name } : {}),
    ...(typeof user.avatar_url === "string" && user.avatar_url.length > 0 ? { avatarUrl: user.avatar_url } : {}),
  };
}
