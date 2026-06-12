"use client";

/**
 * Auth React context (the state over lib/auth.ts's plumbing). Resolves the gate ONCE per
 * page load:
 *
 *   loading → disabled                        auth off (`/auth/config` failed/false) —
 *                                             the app renders exactly as before
 *           → unauthenticated                 auth on, no/expired/rejected token —
 *                                             AuthGate shows only the login page
 *           → authenticated                   `/auth/me` accepted the stored token
 *
 * `/auth/me` is the validity AUTHORITY at gate time; the decoded token payload is used
 * only for the client-side expiry pre-check and as a display fallback when the gateway
 * is transiently unreachable (the stream's own 401 path corrects an optimistic session).
 * A 401 surfaced anywhere later (worker RPC or live-tail push) arrives as the
 * {@link AUTH_UNAUTHORIZED_EVENT} window event: the token is cleared and the gate falls
 * back to login. One recovery edge re-opens the gate: a 401 reaching a `disabled` app
 * proves a gateway exists (the verdict was a transient `/auth/config` failure), so the
 * config cache is reset and re-fetched — `enabled` flips the gate to the login page.
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import {
  AUTH_UNAUTHORIZED_EVENT,
  AuthApiError,
  clearToken,
  decodeTokenPayload,
  fetchAuthConfig,
  fetchMe,
  getToken,
  notifyUnauthorized,
  resetAuthConfigCache,
  signInUrl,
  type AuthMe,
  type AuthUser,
} from "./auth";
import { pushAuthToken } from "./host-client";

export type AuthStatus = "loading" | "disabled" | "unauthenticated" | "authenticated";

export interface AuthContextValue {
  readonly status: AuthStatus;
  /** The signed-in GitHub user (display); `null` unless authenticated. */
  readonly user: AuthUser | null;
  /** The raw bearer token (for "Copy API token"); `null` unless authenticated. */
  readonly token: string | null;
  /** The last `/auth/me` payload (workspace ACLs); `null` when unavailable. */
  readonly me: AuthMe | null;
  /** Full-page redirect into the server's GitHub OAuth flow. */
  signIn(): void;
  /** Clear the token and reload to the login page. */
  signOut(): void;
  /** Re-read `/auth/me` (after membership changes) so ACL-driven views track. */
  refreshMe(): Promise<void>;
}

interface AuthSnapshot {
  readonly status: AuthStatus;
  readonly user: AuthUser | null;
  readonly token: string | null;
  readonly me: AuthMe | null;
}

const SIGNED_OUT: AuthSnapshot = { status: "unauthenticated", user: null, token: null, me: null };

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [snap, setSnap] = useState<AuthSnapshot>({ status: "loading", user: null, token: null, me: null });

  // Resolve the gate once on mount (client-only — localStorage and fetch).
  useEffect(() => {
    let cancelled = false;
    void (async (): Promise<void> => {
      const cfg = await fetchAuthConfig();
      if (cancelled) return;
      if (!cfg.enabled) {
        setSnap({ status: "disabled", user: null, token: null, me: null });
        return;
      }
      const token = getToken();
      const payload = token !== null ? decodeTokenPayload(token) : null;
      // Cheap client-side expiry pre-check; /auth/me below remains the authority.
      if (token === null || (payload !== null && payload.exp * 1000 <= Date.now())) {
        if (token !== null) clearToken();
        setSnap(SIGNED_OUT);
        return;
      }
      try {
        const me = await fetchMe();
        if (cancelled) return;
        pushAuthToken(token); // refresh a worker another tab may have booted already
        setSnap({ status: "authenticated", user: me.user, token, me });
      } catch (e) {
        if (cancelled) return;
        if (e instanceof AuthApiError && e.status === 401) {
          clearToken();
          setSnap(SIGNED_OUT);
        } else {
          // Gateway transiently unreachable: stay optimistic on the decoded payload —
          // if the token is actually dead, the stream's 401 path signs us out below.
          const user: AuthUser | null =
            payload === null ? null : { login: payload.sub, name: payload.name, avatarUrl: payload.avatarUrl };
          setSnap({ status: "authenticated", user, token, me: null });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Any 401 surfaced by the worker/stream (host-client's guard or a live-tail push):
  // the token is dead — clear it and fall back to the login page. If the gate settled
  // on "disabled", the 401 proves a gateway exists (the verdict was a transient
  // /auth/config failure): reset the config cache and re-ask — if it now answers
  // enabled, fall back to the login page instead of leaving a broken, sign-in-less app.
  useEffect(() => {
    const onUnauthorized = (): void => {
      clearToken();
      pushAuthToken(null);
      if (snap.status === "disabled") {
        resetAuthConfigCache();
        void fetchAuthConfig().then((cfg) => {
          if (cfg.enabled) setSnap((s) => (s.status === "disabled" ? SIGNED_OUT : s));
        });
        return;
      }
      setSnap((s) => (s.status === "authenticated" ? SIGNED_OUT : s));
    };
    window.addEventListener(AUTH_UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(AUTH_UNAUTHORIZED_EVENT, onUnauthorized);
  }, [snap.status]);

  const signIn = useCallback((): void => {
    window.location.assign(signInUrl());
  }, []);

  const signOut = useCallback((): void => {
    clearToken();
    pushAuthToken(null);
    // Full reload: the gate re-resolves to the login page on a clean slate.
    window.location.replace("/");
  }, []);

  const refreshMe = useCallback(async (): Promise<void> => {
    try {
      const me = await fetchMe();
      setSnap((s) => (s.status === "authenticated" ? { ...s, user: me.user, me } : s));
    } catch (e) {
      // Funnel a revoked session through the one 401 path; ignore transient failures.
      if (e instanceof AuthApiError && e.status === 401) notifyUnauthorized();
    }
  }, []);

  const value: AuthContextValue = { ...snap, signIn, signOut, refreshMe };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (ctx === null) throw new Error("useAuth must be used inside <AuthProvider>.");
  return ctx;
}
