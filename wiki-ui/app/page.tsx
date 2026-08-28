"use client";

/** Landing: a tile per workspace, most recently changed first. */
import Link from "next/link";
import { useMemo } from "react";
import { AccountMenu } from "../components/AccountMenu";
import { BuildBadge } from "../components/BuildBadge";
import { CreateWorkspaceForm } from "../components/CreateWorkspaceForm";
import { SplashDocs } from "../components/SplashDocs";
import { useWorkspaces } from "../lib/live";
import { workspaceHref } from "../lib/routes";
import { changedLabel, sortByActivity } from "../lib/workspace-tiles";

export default function Home(): React.JSX.Element {
  const { items, activity, loading, error, refresh } = useWorkspaces();
  const tiles = useMemo(() => sortByActivity(items, activity), [items, activity]);
  // Read once per render, not per tile, so every label on the page agrees.
  const now = Date.now();

  return (
    <main className="landing">
      <header className="landing-header">
        <div className="landing-header-row">
          <h1>Hotseat Wiki</h1>
          {/* Renders nothing when auth is disabled. */}
          <AccountMenu />
        </div>
        <p className="muted">Read-only, live-updating browser for a wiki-server.</p>
        <BuildBadge />
      </header>

      <SplashDocs />

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
          <ul className="ws-tiles">
            {tiles.map((w) => {
              const changed = changedLabel(activity[w.id], now);
              return (
                <li key={w.id}>
                  <Link className="ws-tile" href={workspaceHref(w.id)}>
                    <span className="ws-tile-name">{w.name}</span>
                    {changed !== undefined && (
                      <span className="ws-tile-changed muted" title={activity[w.id]}>
                        {changed}
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
        {/* Creation is always available, not just as an empty-state bootstrap — but not while
            the server is unreachable, where a write could only fail. */}
        {error === null && !loading && (
          <div className="ws-create-row">
            <CreateWorkspaceForm />
          </div>
        )}
      </section>
    </main>
  );
}
