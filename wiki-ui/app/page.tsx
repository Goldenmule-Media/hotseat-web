"use client";

/** Landing: list all workspaces (Q4) and link into them. */
import Link from "next/link";
import { useWorkspaces } from "../lib/live";
import { workspaceHref } from "../lib/routes";

export default function Home(): React.JSX.Element {
  const { items, loading, error, refresh } = useWorkspaces();

  return (
    <main className="landing">
      <header className="landing-header">
        <h1>wiki-ui</h1>
        <p className="muted">Read-only, live-updating browser for a wiki-server.</p>
      </header>

      <section>
        <div className="switcher-row">
          <h2>Workspaces</h2>
          <button className="icon-btn" onClick={refresh} title="Refresh" aria-label="Refresh">
            ↻
          </button>
        </div>
        {error !== null ? (
          <div className="notice error">
            <strong>Cannot reach the wiki-server.</strong>
            <p className="muted">{error}</p>
            <p className="muted">
              Check that a wiki-server is running and that <code>NEXT_PUBLIC_WIKI_STREAM_BASE_URL</code> /{" "}
              <code>NEXT_PUBLIC_WIKI_NAMESPACE</code> match it.
            </p>
          </div>
        ) : loading ? (
          <p className="muted">Loading…</p>
        ) : items.length === 0 ? (
          <p className="muted">No workspaces found in this namespace.</p>
        ) : (
          <ul className="ws-list">
            {items.map((w) => (
              <li key={w.id}>
                <Link href={workspaceHref(w.id)}>{w.name}</Link>
                <span className="muted"> · {w.status}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
