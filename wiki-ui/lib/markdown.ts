/**
 * Markdown → HTML (plan step 7 / Q5). The page body is the engine's deterministic
 * Markdown (constraint #5) — we do NOT re-implement page-type presentation, only
 * convert it to HTML for display. Two requirements:
 *   1. Intra-wiki links: any link whose href is a page id (`<type>:<id>`) is rewritten
 *      to a client route so it navigates in-app (the actual click interception that
 *      keeps it an SPA navigation lives in PageView).
 *   2. GitHub-style checklists: `marked` with GFM renders `- [ ]` / `- [x]` as
 *      disabled checkboxes, preserving the `as: checklist` look.
 */
import { Marked } from "marked";
import { isPageId, pageHref } from "./routes";

export function renderMarkdown(md: string, workspaceId: string): string {
  const m = new Marked({ gfm: true, breaks: false });
  m.use({
    walkTokens(token) {
      if (token.type === "link" && typeof token.href === "string" && isPageId(token.href)) {
        // Mutating the href before render preserves all default rendering (incl. GFM
        // task lists) while pointing intra-wiki links at the in-app route.
        token.href = pageHref(workspaceId, token.href);
      }
    },
  });
  return m.parse(md, { async: false }) as string;
}
