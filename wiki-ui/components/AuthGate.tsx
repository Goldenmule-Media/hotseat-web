"use client";

/**
 * App-wide auth gate (companion to HostGate). When the server's auth gateway is enabled
 * and there is no valid session, it renders ONLY a login page — no nav, no sidebar, and
 * crucially no children, so nothing calls `getHost()` and the SharedWorker never connects
 * (or sends a tokenless request) before sign-in. When auth is disabled or the session is
 * valid, the app renders exactly as before.
 *
 * `/auth/complete` is exempt: that page is what STORES the token after the OAuth
 * redirect, so it must mount while still unauthenticated.
 *
 * SSR + first paint render the "loading" state (auth resolution needs localStorage +
 * a fetch), so there is no hydration mismatch — just a brief, minimal loading screen.
 */
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useAuth } from "../lib/auth-context";

export function AuthGate({ children }: { children: ReactNode }): React.JSX.Element {
  const { status, signIn } = useAuth();
  const pathname = usePathname();

  // The OAuth landing page must mount BEFORE auth resolves — it stores the token.
  if (pathname.startsWith("/auth/complete")) return <>{children}</>;

  if (status === "loading") {
    return (
      <main className="login-screen">
        <p className="muted">Loading…</p>
      </main>
    );
  }

  if (status === "unauthenticated") {
    return (
      <main className="login-screen">
        <div className="login-card">
          <h1>wiki-ui</h1>
          <p className="muted">Sign in to browse this wiki-server.</p>
          <button className="login-btn" onClick={signIn}>
            Sign in with GitHub
          </button>
        </div>
      </main>
    );
  }

  // disabled | authenticated → the app, exactly as before.
  return <>{children}</>;
}
