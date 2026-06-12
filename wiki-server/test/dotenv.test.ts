/**
 * `.env` seeding: KEY=VALUE lines fill UNSET env keys only (real environment
 * wins), comments/blanks/quotes handled, missing file a no-op.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyDotEnv } from "../src/config";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wiki-dotenv-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("applyDotEnv", () => {
  it("seeds unset keys, never overrides the real environment, strips quotes and comments", () => {
    const path = join(dir, ".env");
    writeFileSync(
      path,
      [
        "# wiki-server auth",
        "WIKI_SERVER_AUTH=github",
        'WIKI_SERVER_GITHUB_CLIENT_ID="quoted-id"',
        "WIKI_SERVER_GITHUB_CLIENT_SECRET='single-quoted'",
        "",
        "ALREADY_SET=from-file",
        "NOT=KEY=VALUE=ish",
      ].join("\n"),
    );
    const env: Record<string, string | undefined> = { ALREADY_SET: "from-environment" };
    applyDotEnv(env, path);
    expect(env.WIKI_SERVER_AUTH).toBe("github");
    expect(env.WIKI_SERVER_GITHUB_CLIENT_ID).toBe("quoted-id");
    expect(env.WIKI_SERVER_GITHUB_CLIENT_SECRET).toBe("single-quoted");
    expect(env.ALREADY_SET).toBe("from-environment");
    expect(env.NOT).toBe("KEY=VALUE=ish");
  });

  it("tolerates shell-style `export KEY=VALUE` lines", () => {
    const path = join(dir, ".env");
    writeFileSync(path, "export WIKI_SERVER_AUTH=github\n");
    const env: Record<string, string | undefined> = {};
    applyDotEnv(env, path);
    expect(env.WIKI_SERVER_AUTH).toBe("github");
    expect(env["export WIKI_SERVER_AUTH"]).toBeUndefined();
  });

  it("is a no-op when the file is missing", () => {
    const env: Record<string, string | undefined> = {};
    applyDotEnv(env, join(dir, "does-not-exist.env"));
    expect(Object.keys(env)).toHaveLength(0);
  });
});
