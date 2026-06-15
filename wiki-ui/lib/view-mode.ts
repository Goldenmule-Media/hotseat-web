"use client";

/**
 * Page-view mode (Content vs Model). The ACTIVE view lives in the URL (`?view=model`) so a
 * refresh or shared link reopens the same tab; this module only remembers the last explicit
 * toggle so opening another page keeps you in the Model view — the toggle is a global UI
 * preference (like a collapsed sidebar), not a per-page reset. PageView re-stamps the
 * remembered preference into a freshly-opened page's URL.
 */
export type ViewMode = "content" | "model";

let preferred: ViewMode = "content";

export function rememberViewMode(mode: ViewMode): void {
  preferred = mode;
}

export function preferredViewMode(): ViewMode {
  return preferred;
}
