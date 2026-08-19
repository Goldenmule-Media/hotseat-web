/**
 * Markdown → HTML: the two href rewrites, and the collision between them.
 */
import { describe, expect, it } from "vitest";

import { renderMarkdown } from "./markdown";

const SHA = "a".repeat(64);

describe("renderMarkdown", () => {
  it("points an intra-wiki page link at the in-app route", () => {
    const html = renderMarkdown("[A page](document:abc-123)", "ws:1");
    expect(html).toContain("/ws%3A1/document%3Aabc-123");
  });

  it("leaves an attachment link alone so the DOM pass can resolve it", () => {
    // `attachment:<sha>` matches PAGE_ID_RE, so without an explicit guard a PDF link
    // would navigate into the wiki instead of downloading.
    const html = renderMarkdown(`[Q3 report](attachment:${SHA})`, "ws:1");
    expect(html).toContain(`href="attachment:${SHA}"`);
    expect(html).not.toContain("/ws%3A1/attachment");
  });

  it("leaves an attachment image src alone", () => {
    const html = renderMarkdown(`![A shot](attachment:${SHA})`, "ws:1");
    expect(html).toContain(`src="attachment:${SHA}"`);
  });

  it("still renders ordinary links and images untouched", () => {
    const html = renderMarkdown("[Ext](https://example.com) ![Cat](https://example.com/c.png)", "ws:1");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('src="https://example.com/c.png"');
  });
});
