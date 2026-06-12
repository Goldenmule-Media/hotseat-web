"use client";

/** Sidebar workspace title: the current workspace's name plus a copy-id button — and,
 *  when auth is enabled, a members button opening the access-management panel.
 *  The name itself is the rename affordance: click it to edit in place — Enter or
 *  leaving the field saves (the worker-side engine appends `WorkspaceRenamed` and
 *  syncs the catalog), Escape cancels. An empty draft reverts without saving. */
import { useRef, useState } from "react";
import type { WorkspaceId } from "wiki";
import { useAuth } from "../lib/auth-context";
import { getHost } from "../lib/host-client";
import { useWorkspaces } from "../lib/live";
import { classifyError } from "../lib/wiki-host-api";
import { MembersPanel } from "./MembersPanel";

export function WorkspaceTitle({ id }: { id: WorkspaceId }): React.JSX.Element {
  const { items, refresh } = useWorkspaces();
  const { status: authStatus } = useAuth();
  const name = items.find((w) => w.id === id)?.name ?? id;
  const [copied, setCopied] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [membersOpen, setMembersOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Enter commits AND blurs (disabling the input mid-commit drops focus), so guard
  // against the blur handler double-committing the same draft.
  const busy = useRef(false);

  const stop = (): void => {
    setDraft(null);
    setError(null);
  };

  const commit = async (): Promise<void> => {
    if (busy.current) return;
    const next = (draft ?? "").trim();
    if (next === "" || next === name) {
      stop();
      return;
    }
    busy.current = true;
    setPending(true);
    try {
      const h = await getHost();
      await h.renameWorkspace(id, next);
      stop();
      refresh();
    } catch (e) {
      setError(classifyError(e).message);
    } finally {
      busy.current = false;
      setPending(false);
    }
  };

  if (draft !== null) {
    return (
      <div className="ws-title">
        <input
          className="ws-rename-input"
          value={draft}
          autoFocus
          disabled={pending}
          aria-label="Workspace name"
          aria-invalid={error !== null}
          title={error ?? "Enter or click away to rename, Escape to cancel"}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void commit();
            if (e.key === "Escape") stop();
          }}
          onBlur={() => void commit()}
        />
      </div>
    );
  }

  return (
    <div className="ws-title">
      <span
        className="ws-name"
        title={`${id} — click to rename`}
        role="button"
        tabIndex={0}
        onClick={() => setDraft(name)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") setDraft(name);
        }}
      >
        {name}
      </span>
      <button
        className="icon-btn"
        title="Copy workspace id"
        aria-label="Copy workspace id"
        onClick={() => {
          void navigator.clipboard.writeText(id).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? "✓" : "⧉"}
      </button>
      {/* Members are an auth-gateway concept — the button only exists when signed in. */}
      {authStatus === "authenticated" && (
        <button
          className="icon-btn"
          title="Workspace members"
          aria-label="Workspace members"
          onClick={() => setMembersOpen(true)}
        >
          ⚙
        </button>
      )}
      {membersOpen && <MembersPanel workspaceId={id} onClose={() => setMembersOpen(false)} />}
    </div>
  );
}
