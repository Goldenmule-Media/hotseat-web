/**
 * AccessStore semantics: first-wins ownership, owner-only membership management,
 * the unclaimed-is-open policy, login normalization/validation, and that the
 * ledger survives a restart (atomic JSON persistence).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AccessError, AccessStore, isValidLogin, normalizeLogin } from "../src/auth/access";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wiki-auth-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("AccessStore", () => {
  it("claim is first-wins and the creator becomes owner", () => {
    const store = new AccessStore(dir);
    expect(store.claim("Alice", "ws1")).toBe(true);
    expect(store.claim("bob", "ws1")).toBe(false);
    expect(store.record("ws1")?.owner).toBe("alice"); // normalized
    expect(store.isOwner("ALICE", "ws1")).toBe(true);
    expect(store.isOwner("bob", "ws1")).toBe(false);
  });

  it("unclaimed workspaces are open to any signed-in user; claimed ones gate by membership", () => {
    const store = new AccessStore(dir);
    expect(store.canAccess("anyone", "unclaimed-ws")).toBe(true);
    store.claim("alice", "ws1");
    expect(store.canAccess("alice", "ws1")).toBe(true);
    expect(store.canAccess("bob", "ws1")).toBe(false);
    store.addMember("alice", "ws1", "Bob");
    expect(store.canAccess("bob", "ws1")).toBe(true);
  });

  it("only the owner manages members; the owner cannot be removed; logins validate", () => {
    const store = new AccessStore(dir);
    store.claim("alice", "ws1");
    expect(() => store.addMember("bob", "ws1", "carol")).toThrow(AccessError);
    expect(() => store.addMember("alice", "ws1", "not a login!")).toThrow(/not a valid GitHub login/);
    expect(() => store.removeMember("alice", "ws1", "alice")).toThrow(/owner cannot be removed/);
    expect(() => store.addMember("alice", "nope", "bob")).toThrow(/no access record/);

    store.addMember("alice", "ws1", "bob");
    store.addMember("alice", "ws1", "bob"); // idempotent
    expect(store.record("ws1")?.members).toEqual(["bob"]);
    store.removeMember("alice", "ws1", "bob");
    expect(store.record("ws1")?.members).toEqual([]);
  });

  it("membershipsOf partitions every recorded workspace", () => {
    const store = new AccessStore(dir);
    store.claim("alice", "ws-owned");
    store.claim("bob", "ws-member");
    store.addMember("bob", "ws-member", "alice");
    store.claim("bob", "ws-restricted");
    expect(store.membershipsOf("alice")).toEqual({
      owned: ["ws-owned"],
      member: ["ws-member"],
      restricted: ["ws-restricted"],
    });
  });

  it("persists across a restart", async () => {
    const store = new AccessStore(dir);
    store.claim("alice", "ws1");
    store.addMember("alice", "ws1", "bob");
    await store.flush();

    const reopened = new AccessStore(dir);
    expect(reopened.record("ws1")).toMatchObject({ owner: "alice", members: ["bob"] });
    expect(reopened.canAccess("bob", "ws1")).toBe(true);
  });
});

describe("login helpers", () => {
  it("normalizes and validates GitHub logins", () => {
    expect(normalizeLogin("  MixedCase ")).toBe("mixedcase");
    expect(isValidLogin("octo-cat123")).toBe(true);
    expect(isValidLogin("-leading")).toBe(false);
    expect(isValidLogin("double--hyphen")).toBe(false);
    expect(isValidLogin("")).toBe(false);
    expect(isValidLogin("a".repeat(40))).toBe(false);
  });
});
