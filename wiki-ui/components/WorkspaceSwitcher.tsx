"use client";

/** Multi-workspace switcher (plan step 5 / Q4). Lists all workspaces and navigates
 *  to the selected one. */
import { useRouter } from "next/navigation";
import { useWorkspaces } from "../lib/live";
import { workspaceHref } from "../lib/routes";

export function WorkspaceSwitcher({ current }: { current?: string }): React.JSX.Element {
  const router = useRouter();
  const { items, loading, error, refresh } = useWorkspaces();

  return (
    <div className="switcher">
      <div className="switcher-row">
        <label htmlFor="ws-select">Workspace</label>
        <button className="icon-btn" onClick={refresh} title="Refresh workspace list" aria-label="Refresh">
          ↻
        </button>
      </div>
      {error !== null ? (
        <p className="muted error">{error}</p>
      ) : (
        <select
          id="ws-select"
          value={current ?? ""}
          disabled={loading || items.length === 0}
          onChange={(e) => {
            if (e.target.value !== "") router.push(workspaceHref(e.target.value));
          }}
        >
          {current === undefined && <option value="">{loading ? "Loading…" : "Select a workspace…"}</option>}
          {items.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name} {w.status !== "active" ? `(${w.status})` : ""}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
