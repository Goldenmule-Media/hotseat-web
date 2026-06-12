/**
 * wiki-mirror config resolution: flags → env (WIKI_MIRROR_*) → file → defaults, with the
 * default file at the per-machine `~/.wiki/wiki-mirror.config.json` (HOME-redirectable),
 * roots resolved to absolute (file roots against the config dir, flag/env roots against cwd),
 * and fail-fast validation.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_NAMESPACE, DEFAULT_STREAM_BASE_URL, defaultConfigPath, resolveConfig } from "../src/config.js";

describe("wiki-mirror config resolution", () => {
  let dir: string;
  // Every call pins HOME to the temp dir so resolution never touches the real ~/.wiki.
  let env: Record<string, string | undefined>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wiki-mirror-cfg-"));
    env = { HOME: dir };
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const writeConfig = (obj: unknown): string => {
    const p = join(dir, ".wiki", "wiki-mirror.config.json");
    mkdirSync(join(dir, ".wiki"), { recursive: true });
    writeFileSync(p, JSON.stringify(obj), "utf8");
    return p;
  };

  it("defaults the config path to ~/.wiki/wiki-mirror.config.json", () => {
    expect(defaultConfigPath(env)).toBe(join(dir, ".wiki", "wiki-mirror.config.json"));
  });

  it("applies defaults with no file, env, or flags (empty emitters)", () => {
    const cfg = resolveConfig([], env, dir);
    expect(cfg.streamBaseUrl).toBe(DEFAULT_STREAM_BASE_URL);
    expect(cfg.namespace).toBe(DEFAULT_NAMESPACE);
    expect(cfg.models).toEqual([]);
    expect(cfg.emitters).toEqual([]);
  });

  it("reads the shared default config file under $HOME/.wiki and resolves a relative root against it", () => {
    writeConfig({
      namespace: "hotseat",
      models: ["wiki-models/feature"],
      emitters: [{ workspaceId: "ws:a", root: "docs" }],
    });
    const cfg = resolveConfig([], env, dir);
    expect(cfg.namespace).toBe("hotseat");
    expect(cfg.models).toEqual(["wiki-models/feature"]);
    expect(cfg.emitters).toEqual([{ workspaceId: "ws:a", root: join(dir, ".wiki", "docs") }]);
  });

  it("an explicit --config beats the shared default file", () => {
    writeConfig({ namespace: "shared" });
    const p = join(dir, "project.config.json");
    writeFileSync(p, JSON.stringify({ namespace: "project" }), "utf8");
    expect(resolveConfig(["--config", p], env, dir).namespace).toBe("project");
  });

  it("keeps an absolute file root verbatim", () => {
    const abs = join(dir, "out");
    writeConfig({ emitters: [{ workspaceId: "ws:a", root: abs }] });
    expect(resolveConfig([], env, dir).emitters[0].root).toBe(abs);
  });

  it("env overrides the file; a flag overrides env", () => {
    writeConfig({ namespace: "fromfile", emitters: [{ workspaceId: "ws:a", root: "/x" }] });
    const env2 = { ...env, WIKI_MIRROR_NAMESPACE: "fromenv", WIKI_MIRROR_STREAM_URL: "http://env:1" };
    expect(resolveConfig([], env2, dir).namespace).toBe("fromenv");
    expect(resolveConfig([], env2, dir).streamBaseUrl).toBe("http://env:1");
    expect(resolveConfig(["--namespace", "fromflag"], env2, dir).namespace).toBe("fromflag");
  });

  it("resolves token as flag → env → file; absent everywhere → undefined", () => {
    expect(resolveConfig([], env, dir).token).toBeUndefined();
    writeConfig({ token: "from-file", emitters: [] });
    expect(resolveConfig([], env, dir).token).toBe("from-file");
    const env2 = { ...env, WIKI_MIRROR_TOKEN: "from-env" };
    expect(resolveConfig([], env2, dir).token).toBe("from-env");
    expect(resolveConfig(["--token", "from-flag"], env2, dir).token).toBe("from-flag");
  });

  it("parses --models as a comma list, overriding the file", () => {
    writeConfig({ models: ["a"], emitters: [] });
    expect(resolveConfig(["--models", "x, y ,z"], env, dir).models).toEqual(["x", "y", "z"]);
  });

  it("adds a flag emitter, resolving a relative root against cwd", () => {
    expect(resolveConfig(["--workspace", "ws:b", "--root", "out"], env, dir).emitters).toEqual([
      { workspaceId: "ws:b", root: join(dir, "out") },
    ]);
  });

  it("throws on --workspace without --root", () => {
    expect(() => resolveConfig(["--workspace", "ws:b"], env, dir)).toThrow(/must be set together/);
  });

  it("throws on a duplicate workspace across file + flag", () => {
    writeConfig({ emitters: [{ workspaceId: "ws:a", root: "/x" }] });
    expect(() => resolveConfig(["--workspace", "ws:a", "--root", "/y"], env, dir)).toThrow(/duplicate emitter/);
  });

  it("throws on two emitters sharing a root (single-writer-per-root)", () => {
    writeConfig({ emitters: [{ workspaceId: "ws:a", root: "/x" }, { workspaceId: "ws:b", root: "/x" }] });
    expect(() => resolveConfig([], env, dir)).toThrow(/same root/);
  });

  it("throws on an empty root", () => {
    writeConfig({ emitters: [{ workspaceId: "ws:a", root: "" }] });
    expect(() => resolveConfig([], env, dir)).toThrow(/non-empty root/);
  });

  it("throws when an explicitly-requested config file is missing", () => {
    expect(() => resolveConfig(["--config", join(dir, "nope.json")], env, dir)).toThrow(/cannot read config file/);
  });
});
