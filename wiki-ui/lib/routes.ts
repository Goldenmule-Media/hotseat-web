/**
 * Client route helpers (Q5 / plan step 6-7). Routes are `/[workspaceId]/[pageId]`;
 * ids contain a colon (`feature-brief:abc`) which is a legal path-segment character,
 * but we still encode to be safe against reserved characters.
 */
import type { PageId, WorkspaceId } from "wiki";

/** A page id has the shape `<type>:<id>` (e.g. "feature-brief:mpyh…"). */
export const PAGE_ID_RE = /^[a-z][a-z0-9-]*:[A-Za-z0-9._-]+$/;

export function isPageId(s: string): boolean {
  return PAGE_ID_RE.test(s);
}

export function workspaceHref(workspaceId: WorkspaceId | string): string {
  return `/${encodeURIComponent(workspaceId)}`;
}

export function pageHref(workspaceId: WorkspaceId | string, pageId: PageId | string): string {
  return `/${encodeURIComponent(workspaceId)}/${encodeURIComponent(pageId)}`;
}
