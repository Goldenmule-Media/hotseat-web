/**
 * `wiki-mirror logout`. Sign-out has to live HERE rather than in the menu-bar app: credentials
 * belong to the mirror, and an app that rewrote ~/.wiki/credentials.json would be a second writer
 * of a file it does not own.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { main } from "../src/main.js";

const SERVER = "https://wiki.example.com";

describe("wiki-mirror — logout", () => {
  let home: string;
  let env: Record<string, string | undefined>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "wiki-mirror-logout-"));
    env = { HOME: home };
    mkdirSync(join(home, ".wiki"), { recursive: true });
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const credentialsPath = (): string => join(home, ".wiki", "credentials.json");

  function writeCredentials(servers: string[]): void {
    writeFileSync(
      credentialsPath(),
      JSON.stringify({
        servers: Object.fromEntries(
          servers.map((s) => [
            s,
            {
              clientId: "wsid1.x",
              accessToken: "wsv1.secret",
              accessTokenExp: 9_999_999_999,
              refreshToken: "wsr1.secret",
              refreshTokenExp: 9_999_999_999,
              tokenEndpoint: `${s}/auth/token`,
              user: "someone",
            },
          ]),
        ),
      }),
    );
  }

  const read = (): Record<string, unknown> =>
    JSON.parse(readFileSync(credentialsPath(), "utf8")).servers as Record<string, unknown>;

  it("forgets the grant for the resolved server", async () => {
    writeCredentials([SERVER]);
    await main(["logout", "--stream-url", SERVER], env);
    expect(Object.keys(read())).toEqual([]);
  });

  it("leaves every OTHER server's grant alone", async () => {
    // One credentials file serves every server this machine talks to.
    writeCredentials([SERVER, "https://other.example.com"]);
    await main(["logout", "--stream-url", SERVER], env);
    expect(Object.keys(read())).toEqual(["https://other.example.com"]);
  });

  it("matches by origin, so a path-bearing stream URL still signs out", async () => {
    writeCredentials([SERVER]);
    await main(["logout", "--stream-url", `${SERVER}/some/path`], env);
    expect(Object.keys(read())).toEqual([]);
  });

  it("is a no-op, not a crash, when there is nothing to sign out of", async () => {
    writeCredentials(["https://other.example.com"]);
    await expect(main(["logout", "--stream-url", SERVER], env)).resolves.toBeUndefined();
    expect(Object.keys(read())).toEqual(["https://other.example.com"]);
  });

  it("never starts a mirror — it exits before any tail loop or listener", async () => {
    writeCredentials([SERVER]);
    // A logout that booted the service would bind :4440 and fight the running one.
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await main(["logout", "--stream-url", SERVER], env);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
