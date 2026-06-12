"use client";

/**
 * The signed-in account affordance (sidebar foot / landing header): avatar + login, a
 * copy-API-token button — the raw bearer token, for pointing other clients of the same
 * gated server at it (`.mcp.json`, `wiki-mirror`) — and sign-out. Renders nothing when
 * auth is disabled, so the no-auth chrome is byte-identical to before.
 */
import { useState } from "react";
import { useAuth } from "../lib/auth-context";

export function AccountMenu({ className }: { className?: string }): React.JSX.Element | null {
  const { status, user, token, signOut } = useAuth();
  const [copied, setCopied] = useState(false);

  if (status !== "authenticated" || user === null) return null;

  return (
    <div className={className === undefined ? "account-menu" : `account-menu ${className}`}>
      {user.avatarUrl !== null ? (
        // A plain <img>: the avatar is a tiny, externally-hosted GitHub asset — Next's
        // image optimizer would need remotePatterns config for zero gain here.
        // eslint-disable-next-line @next/next/no-img-element
        <img className="account-avatar" src={user.avatarUrl} alt="" />
      ) : (
        <span className="account-avatar account-avatar-fallback" aria-hidden="true">
          {user.login.slice(0, 1).toUpperCase()}
        </span>
      )}
      <span className="account-login" title={user.name ?? user.login}>
        {user.login}
      </span>
      {token !== null && (
        <button
          className="icon-btn"
          title="Copy API token (for .mcp.json / wiki-mirror)"
          aria-label="Copy API token"
          onClick={() => {
            void navigator.clipboard.writeText(token).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? "✓" : "⧉"}
        </button>
      )}
      <button className="icon-btn" title="Sign out" onClick={signOut}>
        Sign out
      </button>
    </div>
  );
}
