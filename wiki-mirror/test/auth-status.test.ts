/**
 * The credentials snapshot published over the health endpoint. An expired grant is the mirror's
 * quietest failure, so this is the field a status icon reads — and it must never carry a token.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CredentialsStore } from "wiki/auth-client";

import { readAuthStatus } from "../src/auth-status.js";

const SERVER = "https://wiki.example.com";

describe("wiki-mirror — auth status", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wiki-mirror-auth-"));
    path = join(dir, "credentials.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeGrant(overrides: Record<string, unknown> = {}): CredentialsStore {
    writeFileSync(
      path,
      JSON.stringify({
        servers: {
          [SERVER]: {
            clientId: "wsid1.x",
            accessToken: "wsv1.secret-access",
            accessTokenExp: 2_000,
            refreshToken: "wsr1.secret-refresh",
            refreshTokenExp: 10_000,
            tokenEndpoint: `${SERVER}/auth/token`,
            user: "thegoldenmule",
            ...overrides,
          },
        },
      }),
    );
    return new CredentialsStore(path);
  }

  it("reports 'none' when there are no credentials for this server", () => {
    const status = readAuthStatus(SERVER, { store: new CredentialsStore(path) });
    expect(status).toEqual({ mode: "none", server: SERVER, expired: false });
  });

  it("reports 'token' for an explicit static token, without reading the store", () => {
    writeGrant();
    const status = readAuthStatus(SERVER, { hasExplicitToken: true, store: new CredentialsStore(path) });
    expect(status).toEqual({ mode: "token", server: SERVER, expired: false });
  });

  it("reports a live grant with its user and expiries in epoch MILLIseconds", () => {
    const store = writeGrant();
    const status = readAuthStatus(SERVER, { store, now: () => 1_000_000 });
    expect(status).toMatchObject({
      mode: "oauth",
      server: SERVER,
      user: "thegoldenmule",
      accessTokenExpiresAt: 2_000_000,
      refreshTokenExpiresAt: 10_000_000,
      expired: false,
    });
  });

  it("marks the grant expired once the REFRESH token is past due (an access token self-renews)", () => {
    const store = writeGrant();
    expect(readAuthStatus(SERVER, { store, now: () => 5_000_000 }).expired).toBe(false); // access stale, refresh fine
    expect(readAuthStatus(SERVER, { store, now: () => 10_000_000 }).expired).toBe(true);
  });

  it("skips the expiry check when the refresh expiry is unknown (0 = the blob didn't decode)", () => {
    const store = writeGrant({ refreshTokenExp: 0 });
    expect(readAuthStatus(SERVER, { store, now: () => 9_999_999_999 }).expired).toBe(false);
  });

  it("never includes a token value", () => {
    const store = writeGrant();
    const json = JSON.stringify(readAuthStatus(SERVER, { store }));
    expect(json).not.toMatch(/secret-access|secret-refresh|wsid1/);
  });

  it("matches by ORIGIN, so a path-bearing stream URL still finds the grant", () => {
    const store = writeGrant();
    expect(readAuthStatus(`${SERVER}/some/path`, { store }).mode).toBe("oauth");
  });
});
