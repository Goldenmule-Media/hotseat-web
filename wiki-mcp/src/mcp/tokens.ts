/**
 * Per-session high-water {@link ConsistencyToken} per workspace (DESIGN §6.2,
 * ADR-M4) — the bookkeeping that gives an MCP agent automatic read-your-writes.
 *
 * Each MCP **session** holds the max token from every write tool it ran (including
 * the void structural commands, DESIGN §3.2). A **write tool** records the engine's
 * returned token here; a **single-workspace read** passes that workspace's
 * high-water token as `consistentWith`, waiting for the SQL read model to catch up
 * before serving; a **cross-workspace read** fans out over every workspace the
 * session has written (DESIGN §6.2). Sessions are independent, and a reconnect
 * (new session id) starts with no marks — subsequent reads are eventually
 * consistent until the session writes again.
 *
 * Token comparison is **within a workspace only** (DESIGN §3.1): we decode each to
 * `{ workspaceId, version }` and keep the max version per workspace. No host
 * clock / RNG here — pure bookkeeping over opaque tokens.
 */
import { decodeToken, encodeToken, type ConsistencyToken, type WorkspaceId } from "wiki";

/** One session's high-water version per workspace it has written. */
class SessionMarks {
  /** workspace id → highest committed version this session has written. */
  private readonly highWater = new Map<WorkspaceId, number>();

  /**
   * Record a write's token, advancing this workspace's high-water mark (monotonic;
   * a lower/equal token is ignored, DESIGN §6.2).
   */
  record(token: ConsistencyToken): void {
    const { workspaceId, version } = decodeToken(token);
    const current = this.highWater.get(workspaceId);
    if (current === undefined || version > current) {
      this.highWater.set(workspaceId, version);
    }
  }

  /** The high-water token for one workspace, or `undefined` if never written. */
  tokenFor(workspace: WorkspaceId): ConsistencyToken | undefined {
    const version = this.highWater.get(workspace);
    return version === undefined ? undefined : encodeToken(workspace, version);
  }

  /** Every workspace this session has written, with its high-water token. */
  all(): readonly ConsistencyToken[] {
    return [...this.highWater.entries()].map(([ws, v]) => encodeToken(ws, v));
  }
}

/**
 * Tracks high-water tokens for every live session (DESIGN §6.2). The MCP server
 * keys sessions by the transport's `sessionId`; a stdio session (no id) collapses to
 * a single ambient session, which is correct for the one-agent-per-process stdio
 * case.
 */
export class SessionTokenManager {
  private readonly sessions = new Map<string, SessionMarks>();
  /** Sentinel key for a transport that exposes no session id (e.g. stdio). */
  private static readonly AMBIENT = "@ambient";

  /**
   * Record a write tool's returned token against a session's high-water marks
   * (DESIGN §6.2). Called by the write tool path after the engine commits.
   */
  recordWrite(sessionId: string | undefined, token: ConsistencyToken): void {
    this.marksFor(sessionId).record(token);
  }

  /**
   * The high-water token for `workspace` in this session — passed as
   * `consistentWith` on a single-workspace read so it waits for the read model to
   * apply the session's own writes (DESIGN §6.2). `undefined` ⇒ no write yet ⇒ an
   * eventually-consistent read.
   */
  consistentWith(sessionId: string | undefined, workspace: WorkspaceId): ConsistencyToken | undefined {
    return this.sessions.get(sessionId ?? SessionTokenManager.AMBIENT)?.tokenFor(workspace);
  }

  /**
   * Every workspace the session has written, each with its high-water token — a
   * cross-workspace read (`search`, `attention`) fans out and waits on all of
   * them so the result reflects ALL the session's writes (DESIGN §6.2).
   */
  allWritten(sessionId: string | undefined): readonly ConsistencyToken[] {
    return this.sessions.get(sessionId ?? SessionTokenManager.AMBIENT)?.all() ?? [];
  }

  /** Drop a session's marks (a reconnect resets read-your-writes, DESIGN §6.2). */
  forget(sessionId: string | undefined): void {
    this.sessions.delete(sessionId ?? SessionTokenManager.AMBIENT);
  }

  /** Get-or-create the marks bucket for a session. */
  private marksFor(sessionId: string | undefined): SessionMarks {
    const key = sessionId ?? SessionTokenManager.AMBIENT;
    let marks = this.sessions.get(key);
    if (marks === undefined) {
      marks = new SessionMarks();
      this.sessions.set(key, marks);
    }
    return marks;
  }
}
