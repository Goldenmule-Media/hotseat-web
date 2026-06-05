/**
 * Config resolution (`flags → env → defaults`). Focuses on the Markdown-disk mirror knobs,
 * which `wiki-server` inherits verbatim (it resolves the embedded `wiki-mcp`'s config from the
 * same flags/env), so this is the passthrough contract for the on-disk-mirror feature.
 */
import { describe, expect, it } from "vitest";

import { resolveConfig } from "../src/config.js";

describe("resolveConfig — Markdown-disk mirror knobs", () => {
  it("is off by default (no flag → no markdown config)", () => {
    expect(resolveConfig([], {}).markdown).toBeUndefined();
  });

  it("enables with --md and defaults the root to docs/", () => {
    expect(resolveConfig(["--md"], {}).markdown).toEqual({
      enabled: true,
      root: "docs",
      workspaces: "all",
      layout: "tree",
      archive: "drop",
    });
    // env form
    expect(resolveConfig([], { WIKI_MCP_MD: "true" }).markdown?.root).toBe("docs");
  });

  it("an explicit --md false forces it off even with a root set", () => {
    expect(resolveConfig(["--md", "false", "--md-root", "/out"], {}).markdown).toBeUndefined();
    expect(resolveConfig([], { WIKI_MCP_MD: "false" }).markdown).toBeUndefined();
  });

  it("an explicit root implicitly enables it (and overrides the docs/ default)", () => {
    const cfg = resolveConfig([], {
      WIKI_MCP_MD_ROOT: "/out",
      WIKI_MCP_MD_WORKSPACES: "ws:a, ws:b",
      WIKI_MCP_MD_ARCHIVE: "mirror",
    });
    expect(cfg.markdown).toEqual({
      enabled: true,
      root: "/out",
      workspaces: ["ws:a", "ws:b"],
      layout: "tree",
      archive: "mirror",
    });
  });

  it("flags win over env (flags → env → defaults)", () => {
    const cfg = resolveConfig(["--md-root", "/flag"], { WIKI_MCP_MD_ROOT: "/env", WIKI_MCP_MD_ARCHIVE: "mirror" });
    expect(cfg.markdown?.root).toBe("/flag");
    expect(cfg.markdown?.archive).toBe("mirror"); // archive still picked up from env
  });

  it("rejects an invalid archive policy", () => {
    expect(() => resolveConfig(["--md"], { WIKI_MCP_MD_ARCHIVE: "bogus" })).toThrow(/md-archive/);
  });
});
