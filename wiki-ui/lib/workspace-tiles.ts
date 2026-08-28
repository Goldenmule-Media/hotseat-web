/**
 * Ordering + labelling for the landing page's workspace tiles.
 *
 * The sort key is `workspaceActivity` (the newest event in each workspace's stream), which
 * arrives a beat after the list itself — so both functions are pure and total over a
 * PARTIAL activity map: a workspace with no known last-changed time keeps a stable place
 * (alphabetical, after everything that does) instead of jumping around as data lands.
 */
import type { IWorkspaceSummary, WorkspaceId } from "wiki";

/** Most recently changed first; unknown-activity workspaces last, alphabetically. */
export function sortByActivity(
  items: readonly IWorkspaceSummary[],
  activity: Record<WorkspaceId, string>,
): readonly IWorkspaceSummary[] {
  return [...items].sort((a, b) => {
    const at = activity[a.id];
    const bt = activity[b.id];
    if (at !== undefined && bt !== undefined) return at === bt ? a.name.localeCompare(b.name) : (at < bt ? 1 : -1);
    if (at !== undefined) return -1;
    if (bt !== undefined) return 1;
    return a.name.localeCompare(b.name);
  });
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * "3h ago" / "2d ago"; an absolute date past a month, where "37d ago" stops meaning
 * anything. `undefined` for an unreadable or missing timestamp — the tile then shows no
 * changed line at all rather than a fake one.
 */
export function changedLabel(iso: string | undefined, now: number): string | undefined {
  if (iso === undefined) return undefined;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return undefined;
  const ms = now - then;
  if (ms < MINUTE) return "just now";
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m ago`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h ago`;
  if (ms < 30 * DAY) return `${Math.floor(ms / DAY)}d ago`;
  return new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
