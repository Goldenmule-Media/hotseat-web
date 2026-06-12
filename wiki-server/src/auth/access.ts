/**
 * The workspace access ledger: `workspaceId → { owner, members[] }`, persisted
 * as ONE JSON file under the server's data dir (`<dataDir>/auth/access.json`,
 * atomic temp+rename like the mirror's manifest). This is HOST state, not wiki
 * content: who may see a workspace cannot itself live inside that workspace's
 * stream, and a few-users ACL doesn't warrant a database.
 *
 * Policy (enforced here, consumed by the gateway, the control listener, and the
 * embedded MCP via the injected `McpAuth`):
 *  - the CREATOR of a workspace becomes its owner (first-wins);
 *  - the owner may add/remove members and is implicitly a member;
 *  - members may read/write content; only the owner administers;
 *  - a workspace with NO record ("unclaimed" — e.g. created before auth was
 *    enabled) is open to every signed-in user and may be `claim`ed by any of
 *    them, after which normal rules apply.
 *
 * Logins are GitHub logins, lowercased. Writes are serialized through a single
 * in-process queue — the server is the only writer (single-writer per file,
 * same trust model as the mirror).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** One workspace's access record. */
export interface AccessRecord {
  readonly owner: string;
  readonly members: readonly string[];
  /** ISO-8601 creation/claim instant (informational). */
  readonly createdAt: string;
}

/** The persisted file shape. */
interface AccessFile {
  readonly version: 1;
  readonly workspaces: Record<string, AccessRecord>;
}

/** Normalize a GitHub login for use as an ACL key. */
export function normalizeLogin(login: string): string {
  return login.trim().toLowerCase();
}

/** A GitHub login: 1–39 alphanumerics/hyphens, no leading/trailing/double hyphen. */
const LOGIN_RE = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/;

/** Is this a plausibly-valid (normalized) GitHub login? */
export function isValidLogin(login: string): boolean {
  return LOGIN_RE.test(login);
}

export class AccessStore {
  private readonly path: string;
  private workspaces = new Map<string, AccessRecord>();
  /** Serialize file writes (atomic temp+rename, last-write-wins within the queue). */
  private writeQueue: Promise<void> = Promise.resolve();

  private readonly persistToDisk: boolean;
  private readonly now: () => string;

  /**
   * @param dir   directory holding `access.json` (created if missing)
   * @param opts  `now`: ISO-8601 clock (injected for determinism in tests);
   *              `persist: false` keeps the ledger purely in memory — the
   *              `storage=memory` pairing, so ACL lifetime matches stream lifetime
   *              (a persisted claim over a vanished stream would lock its id).
   */
  constructor(dir: string, opts: { now?: () => string; persist?: boolean } = {}) {
    this.path = join(dir, "access.json");
    this.now = opts.now ?? (() => new Date().toISOString());
    this.persistToDisk = opts.persist ?? true;
    if (this.persistToDisk) this.load();
  }

  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      return; // first boot — empty ledger
    }
    const parsed = JSON.parse(raw) as AccessFile;
    if (parsed.version !== 1 || typeof parsed.workspaces !== "object" || parsed.workspaces === null) {
      throw new Error(`unrecognized access file at ${this.path} — refusing to overwrite it`);
    }
    this.workspaces = new Map(Object.entries(parsed.workspaces));
  }

  private persist(): void {
    if (!this.persistToDisk) return;
    const file: AccessFile = { version: 1, workspaces: Object.fromEntries(this.workspaces) };
    const json = JSON.stringify(file, null, 2);
    this.writeQueue = this.writeQueue.then(() => {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, json, "utf8");
      renameSync(tmp, this.path);
    });
  }

  /** Wait for queued writes to hit disk (shutdown/tests). */
  flush(): Promise<void> {
    return this.writeQueue;
  }

  /** The record for a workspace, or `undefined` when unclaimed. */
  record(workspaceId: string): AccessRecord | undefined {
    return this.workspaces.get(workspaceId);
  }

  /** May `login` read/write content in `workspaceId`? (Unclaimed → yes, for any signed-in user.) */
  canAccess(login: string, workspaceId: string): boolean {
    const rec = this.workspaces.get(workspaceId);
    if (rec === undefined) return true;
    const l = normalizeLogin(login);
    return rec.owner === l || rec.members.includes(l);
  }

  /** Is `login` the owner of `workspaceId`? (Unclaimed → no one is.) */
  isOwner(login: string, workspaceId: string): boolean {
    return this.workspaces.get(workspaceId)?.owner === normalizeLogin(login);
  }

  /**
   * Record `login` as owner of a just-created (or claimed) workspace.
   * First-wins: a no-op when the workspace already has an owner.
   * @returns true when ownership was recorded by THIS call.
   */
  claim(login: string, workspaceId: string): boolean {
    if (this.workspaces.has(workspaceId)) return false;
    this.workspaces.set(workspaceId, { owner: normalizeLogin(login), members: [], createdAt: this.now() });
    this.persist();
    return true;
  }

  /** Owner-only: add a member (idempotent). Throws on bad login / not-owner / unclaimed. */
  addMember(actor: string, workspaceId: string, login: string): AccessRecord {
    const rec = this.requireOwner(actor, workspaceId);
    const l = normalizeLogin(login);
    if (!isValidLogin(l)) throw new AccessError(400, `"${login}" is not a valid GitHub login`);
    if (rec.owner === l || rec.members.includes(l)) return rec;
    const next: AccessRecord = { ...rec, members: [...rec.members, l].sort() };
    this.workspaces.set(workspaceId, next);
    this.persist();
    return next;
  }

  /** Owner-only: remove a member (idempotent; the owner cannot be removed). */
  removeMember(actor: string, workspaceId: string, login: string): AccessRecord {
    const rec = this.requireOwner(actor, workspaceId);
    const l = normalizeLogin(login);
    if (rec.owner === l) throw new AccessError(400, "the owner cannot be removed; transfer or delete the record instead");
    if (!rec.members.includes(l)) return rec;
    const next: AccessRecord = { ...rec, members: rec.members.filter((m) => m !== l) };
    this.workspaces.set(workspaceId, next);
    this.persist();
    return next;
  }

  /** Partition every RECORDED workspace by `login`'s relationship to it. */
  membershipsOf(login: string): { owned: string[]; member: string[]; restricted: string[] } {
    const l = normalizeLogin(login);
    const owned: string[] = [];
    const member: string[] = [];
    const restricted: string[] = [];
    for (const [ws, rec] of this.workspaces) {
      if (rec.owner === l) owned.push(ws);
      else if (rec.members.includes(l)) member.push(ws);
      else restricted.push(ws);
    }
    return { owned: owned.sort(), member: member.sort(), restricted: restricted.sort() };
  }

  private requireOwner(actor: string, workspaceId: string): AccessRecord {
    const rec = this.workspaces.get(workspaceId);
    if (rec === undefined) throw new AccessError(404, `workspace ${workspaceId} has no access record (claim it first)`);
    if (rec.owner !== normalizeLogin(actor)) throw new AccessError(403, `only the owner (${rec.owner}) may manage members`);
    return rec;
  }
}

/** A policy refusal with the HTTP status the gateway should answer with. */
export class AccessError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AccessError";
  }
}
