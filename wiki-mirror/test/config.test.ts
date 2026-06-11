/**
 * wiki-mirror config resolution: flags → env (WIKI_MIRROR_*) → file → defaults, with roots
 * resolved to absolute (file roots against the config dir, flag/env roots against cwd) and
 * fail-fast validation.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_NAMESPACE, DEFAULT_STREAM_BASE_URL, resolveConfig } from "../src/config.js";

describe("wiki-mirror config resolution", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wiki-mirror-cfg-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const writeConfig = (obj: unknown): string => {
    const p = join(dir, "wiki-mirror.config.json");
    writeFileSync(p, JSON.stringify(obj), "utf8");
    return p;
  };

  it("applies defaults with no file, env, or flags (empty emitters)", () => {
    const cfg = resolveConfig([], {}, dir);
    expect(cfg.streamBaseUrl).toBe(DEFAULT_STREAM_BASE_URL);
    expect(cfg.namespace).toBe(DEFAULT_NAMESPACE);
    expect(cfg.models).toEqual([]);
    expect(cfg.emitters).toEqual([]);
  });

  it("reads the default config file in cwd and resolves a relative root against it", () => {
    writeConfig({
      namespace: "hotseat",
      models: ["wiki-models/feature"],
      emitters: [{ workspaceId: "ws:a", root: "docs" }],
    });
    const cfg = resolveConfig([], {}, dir);
    expect(cfg.namespace).toBe("hotseat");
    expect(cfg.models).toEqual(["wiki-models/feature"]);
    expect(cfg.emitters).toEqual([{ workspaceId: "ws:a", root: join(dir, "docs") }]);
  });

  it("keeps an absolute file root verbatim", () => {
    const abs = join(dir, "out");
    writeConfig({ emitters: [{ workspaceId: "ws:a", root: abs }] });
    expect(resolveConfig([], {}, dir).emitters[0].root).toBe(abs);
  });

  it("env overrides the file; a flag overrides env", () => {
    writeConfig({ namespace: "fromfile", emitters: [{ workspaceId: "ws:a", root: "/x" }] });
    const env = { WIKI_MIRROR_NAMESPACE: "fromenv", WIKI_MIRROR_STREAM_URL: "http://env:1" };
    expect(resolveConfig([], env, dir).namespace).toBe("fromenv");
    expect(resolveConfig([], env, dir).streamBaseUrl).toBe("http://env:1");
    expect(resolveConfig(["--namespace", "fromflag"], env, dir).namespace).toBe("fromflag");
  });

  it("parses --models as a comma list, overriding the file", () => {
    writeConfig({ models: ["a"], emitters: [] });
    expect(resolveConfig(["--models", "x, y ,z"], {}, dir).models).toEqual(["x", "y", "z"]);
  });

  it("adds a flag emitter, resolving a relative root against cwd", () => {
    expect(resolveConfig(["--workspace", "ws:b", "--root", "out"], {}, dir).emitters).toEqual([
      { workspaceId: "ws:b", root: join(dir, "out") },
    ]);
  });

  it("throws on --workspace without --root", () => {
    expect(() => resolveConfig(["--workspace", "ws:b"], {}, dir)).toThrow(/must be set together/);
  });

  it("throws on a duplicate workspace across file + flag", () => {
    writeConfig({ emitters: [{ workspaceId: "ws:a", root: "/x" }] });
    expect(() => resolveConfig(["--workspace", "ws:a", "--root", "/y"], {}, dir)).toThrow(/duplicate emitter/);
  });

  it("throws on an empty root", () => {
    writeConfig({ emitters: [{ workspaceId: "ws:a", root: "" }] });
    expect(() => resolveConfig([], {}, dir)).toThrow(/non-empty root/);
  });

  it("throws when an explicitly-requested config file is missing", () => {
    expect(() => resolveConfig(["--config", join(dir, "nope.json")], {}, dir)).toThrow(/cannot read config file/);
  });
});
