"use client";

/** Workspace shell: sidebar (switcher + live tree) and a header live indicator.
 *  The tree + indicator are driven by the shared live session (plan step 4-5). */
import Link from "next/link";
import { useParams } from "next/navigation";
import type { ReactNode } from "react";
import type { WorkspaceId } from "wiki";
import { LiveIndicator } from "../../components/LiveIndicator";
import { TreeNav } from "../../components/TreeNav";
import { WorkspaceSwitcher } from "../../components/WorkspaceSwitcher";
import { useLiveWorkspace } from "../../lib/live";

export default function WorkspaceLayout({ children }: { children: ReactNode }): React.JSX.Element {
  const params = useParams<{ workspaceId: string }>();
  // Next returns the raw (still-encoded) path segment; decode before the engine
  // re-encodes it, or ids with a colon get double-encoded (ws%3A → ws%253A → 404).
  const workspaceId = decodeURIComponent(params.workspaceId) as WorkspaceId;
  const ws = useLiveWorkspace(workspaceId);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar-head">
          <Link href="/" className="home-link">
            ← Workspaces
          </Link>
          <LiveIndicator connection={ws.connection} lastEventAt={ws.lastEventAt} />
        </div>
        <WorkspaceSwitcher current={workspaceId} />
        <nav className="tree-nav" aria-label="Pages">
          <TreeNav tree={ws.tree} workspaceId={workspaceId} />
        </nav>
      </aside>
      <main className="content">{children}</main>
    </div>
  );
}
