"use client";

/** Workspace landing: prompt to pick a page, or auto-open the first one. */
import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";
import type { WorkspaceId } from "wiki";
import { useLiveWorkspace } from "../../lib/live";
import { pageHref } from "../../lib/routes";
import { WorkspaceError } from "../../components/WorkspaceError";

export default function WorkspaceHome(): React.JSX.Element {
  const params = useParams<{ workspaceId: string }>();
  const workspaceId = decodeURIComponent(params.workspaceId) as WorkspaceId;
  const router = useRouter();
  const ws = useLiveWorkspace(workspaceId);

  const firstPageId = ws.tree?.children[0]?.id ?? null;
  useEffect(() => {
    if (firstPageId !== null) router.replace(pageHref(workspaceId, firstPageId));
  }, [firstPageId, workspaceId, router]);

  // No tree to show and a failure to explain → surface the real reason (which is often
  // NOT a connection problem, despite the live indicator).
  if (ws.tree === null && ws.error !== null) {
    return (
      <div className="page">
        <WorkspaceError error={ws.error} />
      </div>
    );
  }

  return (
    <div className="page">
      <p className="muted">
        {firstPageId === null ? "This workspace has no pages yet." : "Opening…"}
      </p>
    </div>
  );
}
