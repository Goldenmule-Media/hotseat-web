"use client";

/**
 * OAuth landing. The server's auth gateway 302s here with `#token=<bearer>` in the URL
 * FRAGMENT (fragments never travel to any server). Store it, scrub it from the address
 * bar/history, and hard-navigate home so the AuthProvider re-resolves the gate from a
 * clean slate with the new token. AuthGate exempts this route — it must mount while the
 * session is still unauthenticated.
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { setToken } from "../../../lib/auth";

export default function AuthCompletePage(): React.JSX.Element {
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    const token = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("token");
    if (token === null || token === "") {
      setMissing(true);
      return;
    }
    setToken(token);
    // Strip the fragment so the token never lingers in the URL or history…
    window.history.replaceState(null, "", window.location.pathname);
    // …then hard-navigate home: a full load re-runs the auth gate with the stored token.
    window.location.replace("/");
  }, []);

  if (missing) {
    return (
      <main className="login-screen">
        <div className="notice error">
          <strong>Sign-in didn&apos;t complete</strong>
          <p className="muted">
            The redirect from the server carried no token. <Link href="/">Back to the app</Link> to try again.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="login-screen">
      <p className="muted">Completing sign-in…</p>
    </main>
  );
}
