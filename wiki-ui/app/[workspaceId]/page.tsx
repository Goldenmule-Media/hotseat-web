"use client";

/** Workspace landing: prompt to pick a page, or auto-open the first one. */
import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";
import type { WorkspaceId } from "wiki";
import { useLiveWorkspace } from "../../lib/live";
import { pageHref } from "../../lib/routes";

export default function WorkspaceHome(): React.JSX.Element {
  const params = useParams<{ workspaceId: string }>();
  const workspaceId = decodeURIComponent(params.workspaceId) as WorkspaceId;
  const router = useRouter();
  const ws = useLiveWorkspace(workspaceId);

  const firstPageId = ws.tree?.children[0]?.id ?? null;
  useEffect(() => {
    if (firstPageId !== null) router.replace(pageHref(workspaceId, firstPageId));
  }, [firstPageId, workspaceId, router]);

  return (
    <div className="page">
      <p className="muted">
        {ws.connection === "error"
          ? "Could not connect to this workspace."
          : firstPageId === null
            ? "This workspace has no pages yet."
            : "Opening…"}
      </p>
    </div>
  );
}
