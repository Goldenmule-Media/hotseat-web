/**
 * Config resolution (`flags → env → defaults`). Focuses on the Markdown-disk mirror knobs,
 * which `wiki-server` inherits verbatim (it resolves the embedded `wiki-mcp`'s config from the
 * same flags/env), so this is the passthrough contract for the on-disk-mirror feature.
 */
import { describe, expect, it } from "vitest";

import { resolveConfig } from "../src/config.js";

describe("resolveConfig — Markdown-disk mirror knobs", () => {
  it("is off by default (no md-root → no markdown config)", () => {
    expect(resolveConfig([], {}).markdown).toBeUndefined();
  });

  it("enables from env with workspace allowlist + archive policy", () => {
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

  it("enables from a flag with defaults (all workspaces, drop)", () => {
    expect(resolveConfig(["--md-root", "/out"], {}).markdown).toEqual({
      enabled: true,
      root: "/out",
      workspaces: "all",
      layout: "tree",
      archive: "drop",
    });
  });

  it("flags win over env (flags → env → defaults)", () => {
    const cfg = resolveConfig(["--md-root", "/flag"], { WIKI_MCP_MD_ROOT: "/env", WIKI_MCP_MD_ARCHIVE: "mirror" });
    expect(cfg.markdown?.root).toBe("/flag");
    expect(cfg.markdown?.archive).toBe("mirror"); // archive still picked up from env
  });

  it("rejects an invalid archive policy", () => {
    expect(() => resolveConfig([], { WIKI_MCP_MD_ROOT: "/out", WIKI_MCP_MD_ARCHIVE: "bogus" })).toThrow(/md-archive/);
  });
});
