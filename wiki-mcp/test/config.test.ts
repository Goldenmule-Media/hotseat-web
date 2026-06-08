/**
 * Config resolution (`flags → env → defaults`). The static Markdown-disk mirror surface
 * (`--md*` / `WIKI_MCP_MD*`) was REMOVED in favor of the runtime emitter registry
 * (feature: "Runtime-configurable Markdown emitters"); these tests pin that the old surface
 * is gone — passing the dead flags/env neither errors nor enables anything.
 */
import { describe, expect, it } from "vitest";

import { resolveConfig } from "../src/config.js";

describe("resolveConfig — static Markdown surface removed", () => {
  it("has no `markdown` field on the resolved config", () => {
    const cfg = resolveConfig([], {});
    expect("markdown" in cfg).toBe(false);
  });

  it("ignores the dead --md* flags (no error, nothing enabled)", () => {
    const cfg = resolveConfig(
      ["--md", "--md-root", "/out", "--md-workspaces", "ws:a", "--md-archive", "mirror"],
      {},
    );
    expect("markdown" in cfg).toBe(false);
    // The live knobs still resolve normally alongside the ignored flags.
    expect(cfg.namespace).toBe("default");
  });

  it("ignores the dead WIKI_MCP_MD* env (no error, nothing enabled)", () => {
    const cfg = resolveConfig([], {
      WIKI_MCP_MD: "true",
      WIKI_MCP_MD_ROOT: "/out",
      WIKI_MCP_MD_ARCHIVE: "bogus", // previously threw — now just ignored
    });
    expect("markdown" in cfg).toBe(false);
  });

  it("still resolves the live config (namespace / streamBaseUrl / db / timeouts)", () => {
    const cfg = resolveConfig(["--namespace", "proj", "--stream-url", "http://h:1/"], {});
    expect(cfg.namespace).toBe("proj");
    expect(cfg.streamBaseUrl).toBe("http://h:1/");
    expect(cfg.db).toEqual({ kind: "pglite" });
    expect(cfg.readConsistencyTimeoutMs).toBe(5000);
    expect(cfg.waitForPollMs).toBe(50);
  });
});
