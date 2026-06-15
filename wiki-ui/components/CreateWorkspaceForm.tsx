"use client";

/**
 * Bootstrap affordance shown in the landing page's empty state: create the first workspace from
 * the browser. The engine assigns the id and appends the catalog event; when auth is on we then
 * CLAIM the workspace (the engine's direct stream write doesn't run the gateway's owner hook the
 * MCP tool does), making the creator its owner. Navigates into the new workspace on success.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";
import { claimWorkspace } from "../lib/auth";
import { useAuth } from "../lib/auth-context";
import { getHost } from "../lib/host-client";
import { classifyError } from "../lib/wiki-host-api";
import { workspaceHref } from "../lib/routes";

export function CreateWorkspaceForm(): React.JSX.Element {
  const router = useRouter();
  const { status, refreshMe } = useAuth();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button type="button" className="create-ws-btn" onClick={() => setOpen(true)}>
        + Create workspace
      </button>
    );
  }

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const trimmed = name.trim();
    if (trimmed === "" || pending) return;
    setPending(true);
    setError(null);
    try {
      const host = await getHost();
      const { workspaceId } = await host.createWorkspace(trimmed);
      if (status === "authenticated") {
        // Best-effort: claim ownership, then refresh ACLs. A claim failure shouldn't block entry.
        try {
          await claimWorkspace(workspaceId);
          await refreshMe();
        } catch {
          // leave unclaimed — still navigable by any signed-in user
        }
      }
      router.push(workspaceHref(workspaceId));
    } catch (err) {
      setError(classifyError(err).message);
      setPending(false);
    }
  }

  return (
    <form className="create-ws" onSubmit={submit}>
      <input
        type="text"
        className="create-ws-input"
        placeholder="Workspace name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        autoFocus
        disabled={pending}
      />
      <button type="submit" className="create-ws-btn" disabled={pending || name.trim() === ""}>
        {pending ? "Creating…" : "Create"}
      </button>
      <button
        type="button"
        className="icon-btn"
        onClick={() => {
          setOpen(false);
          setName("");
          setError(null);
        }}
        disabled={pending}
      >
        Cancel
      </button>
      {error !== null && <div className="notice error create-ws-error">{error}</div>}
    </form>
  );
}
