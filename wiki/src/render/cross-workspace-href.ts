import type { PageId, WorkspaceId } from "../api";

const SCHEME = "wiki://";

/** The href a cross-workspace link renders to: `wiki://<workspaceId>/<pageId>`. */
export function crossWorkspaceHref(workspace: WorkspaceId, page: PageId): string {
  return `${SCHEME}${workspace}/${page}`;
}

/** The inverse of {@link crossWorkspaceHref}; `undefined` for any other href. */
export function parseCrossWorkspaceHref(href: string): { workspace: WorkspaceId; page: PageId } | undefined {
  if (!href.startsWith(SCHEME)) return undefined;
  const rest = href.slice(SCHEME.length);
  const slash = rest.indexOf("/");
  if (slash <= 0 || slash === rest.length - 1) return undefined;
  return { workspace: rest.slice(0, slash) as WorkspaceId, page: rest.slice(slash + 1) as PageId };
}
