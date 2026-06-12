"use client";

/**
 * Per-workspace access management over the wiki-server auth gateway. Opened from the
 * icon-btn next to the workspace title (only rendered when auth is enabled). Three views
 * by the caller's relationship to the workspace:
 *
 *   - unclaimed (owner null) → a "Claim ownership" button (any signed-in user);
 *   - owner                  → add by GitHub login (lowercase-normalised) and remove;
 *   - member                 → a read-only owner + member list.
 *
 * The gateway is the validator — failures surface its JSON `{error}` verbatim, in the
 * same pending/error shape as usePageMutator. `/auth/me` is refreshed after every change
 * so the restricted-workspace filter tracks the new ACL.
 */
import { useEffect, useState } from "react";
import type { WorkspaceId } from "wiki";
import {
  addMember,
  AuthApiError,
  claimWorkspace,
  fetchMembers,
  notifyUnauthorized,
  removeMember,
  type WorkspaceMembers,
} from "../lib/auth";
import { useAuth } from "../lib/auth-context";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function MembersPanel({
  workspaceId,
  onClose,
}: {
  workspaceId: WorkspaceId;
  onClose: () => void;
}): React.JSX.Element {
  const { user, refreshMe } = useAuth();
  const [data, setData] = useState<WorkspaceMembers | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetchMembers(workspaceId)
      .then((m) => {
        if (!cancelled) setData(m);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        // A dead session funnels through the one 401 path (the gate falls back to the
        // login page) like every other surface — never rendered as an inline error.
        if (e instanceof AuthApiError && e.status === 401) {
          notifyUnauthorized();
          return;
        }
        setLoadError(errMsg(e));
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const login = user?.login ?? null;
  const isOwner = data !== null && data.owner !== null && data.owner === login;
  const unclaimed = data !== null && data.owner === null;

  /** Run a gateway write; the response is the updated `{owner,members}`. */
  async function act(fn: () => Promise<WorkspaceMembers>): Promise<boolean> {
    setPending(true);
    setError(null);
    try {
      setData(await fn());
      await refreshMe(); // keep me.workspaces (and the restricted filter) current
      return true;
    } catch (e) {
      // A dead session funnels through the one 401 path — no inline error.
      if (e instanceof AuthApiError && e.status === 401) {
        notifyUnauthorized();
        return false;
      }
      setError(errMsg(e));
      // A rejected write (lost claim race → 409, member already gone → 404) means this
      // view is stale — resync to the gateway's current ownership, best-effort.
      void fetchMembers(workspaceId).then(setData).catch(() => {});
      return false;
    } finally {
      setPending(false);
    }
  }

  function onAdd(e: React.FormEvent): void {
    e.preventDefault();
    const next = draft.trim().toLowerCase(); // GitHub logins are case-insensitive — normalise
    if (next === "" || pending) return;
    void act(() => addMember(workspaceId, next)).then((ok) => {
      if (ok) setDraft("");
    });
  }

  return (
    <div
      className="members-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="members-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Workspace members"
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
      >
        <header className="members-head">
          <h2>Members</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        {loadError !== null ? (
          <div className="notice error">
            <strong>Couldn&apos;t load members</strong>
            <p className="muted">{loadError}</p>
          </div>
        ) : data === null ? (
          <p className="muted">Loading…</p>
        ) : (
          <>
            {unclaimed ? (
              <>
                <p className="muted members-owner">
                  Unclaimed — every signed-in user can read and write this workspace.
                </p>
                <button
                  className="tf-btn tf-btn-primary"
                  disabled={pending}
                  onClick={() => void act(() => claimWorkspace(workspaceId))}
                >
                  {pending ? "Claiming…" : "Claim ownership"}
                </button>
              </>
            ) : (
              <p className="muted members-owner">
                Owner: <strong>{data.owner}</strong>
                {data.owner === login ? " (you)" : ""}
              </p>
            )}

            <ul className="members-list">
              {data.members.length === 0 ? (
                <li className="muted members-empty">No members{unclaimed ? "" : " besides the owner"}.</li>
              ) : (
                data.members.map((m) => (
                  <li key={m}>
                    <span>
                      {m}
                      {m === login ? " (you)" : ""}
                    </span>
                    {isOwner && (
                      <button
                        className="icon-btn"
                        disabled={pending}
                        title={`Remove ${m}`}
                        aria-label={`Remove ${m}`}
                        onClick={() => void act(() => removeMember(workspaceId, m))}
                      >
                        ✕
                      </button>
                    )}
                  </li>
                ))
              )}
            </ul>

            {isOwner && (
              <form className="members-add" onSubmit={onAdd}>
                <input
                  type="text"
                  value={draft}
                  placeholder="github-login"
                  aria-label="GitHub login to add"
                  spellCheck={false}
                  disabled={pending}
                  onChange={(e) => setDraft(e.target.value)}
                />
                <button type="submit" className="tf-btn tf-btn-primary" disabled={pending || draft.trim() === ""}>
                  Add
                </button>
              </form>
            )}

            {error !== null && <div className="notice error members-error">{error}</div>}
          </>
        )}
      </div>
    </div>
  );
}
