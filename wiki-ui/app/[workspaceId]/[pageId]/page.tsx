"use client";

/** Page route: render one page, live. */
import { useParams } from "next/navigation";
import type { PageId, WorkspaceId } from "wiki";
import { PageView } from "../../../components/PageView";

export default function PageRoute(): React.JSX.Element {
  const params = useParams<{ workspaceId: string; pageId: string }>();
  // Decode the raw path segments before they reach the engine (which re-encodes).
  const workspaceId = decodeURIComponent(params.workspaceId) as WorkspaceId;
  const pageId = decodeURIComponent(params.pageId) as PageId;
  return <PageView workspaceId={workspaceId} pageId={pageId} />;
}
