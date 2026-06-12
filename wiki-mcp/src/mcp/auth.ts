/**
 * The host-injected auth seam. `wiki-mcp` is auth-MECHANISM-agnostic: it never
 * parses tokens or talks to an identity provider. A host (`wiki-server`) that
 * gates its surfaces injects an {@link McpAuth} via `createWikiMcp({ auth })`;
 * when absent (stdio/standalone/local dev), every request is anonymous-trusted
 * and behavior is unchanged.
 *
 * Enforcement is GENERIC over the engine's workspace concept (never over model
 * concepts): the server gates any tool whose args carry a `workspaceId` — at
 * `member` level by default, `owner` level where the tool declares it — and
 * threads a user-bound {@link AccessView} into tool/resource contexts so
 * workspace-enumerating reads (`listWorkspaces`, resource lists) can filter and
 * `createWorkspace` can attribute ownership.
 */
import type { IncomingHttpHeaders } from "node:http";

/** An authenticated principal (the `sub` of the host's session — e.g. a GitHub login). */
export interface AuthUser {
  readonly login: string;
  /** Display name, when the provider supplies one. */
  readonly name?: string;
}

/** Host-injected authentication + per-workspace access control. All hooks must not throw. */
export interface McpAuth {
  /** Authenticate one HTTP request from its headers; `undefined` → 401. */
  authenticate(headers: IncomingHttpHeaders): AuthUser | undefined;
  /** May `user` read/write content in `workspaceId`? (Owner, member, or host policy for unclaimed.) */
  canAccess(user: AuthUser, workspaceId: string): boolean;
  /** May `user` administer `workspaceId` (rename/archive/unarchive, membership)? */
  canAdmin(user: AuthUser, workspaceId: string): boolean;
  /** Attribute a just-created workspace to `user` (host records first-wins ownership). */
  onWorkspaceCreated(user: AuthUser, workspaceId: string): void;
}

/**
 * An {@link McpAuth} pre-bound to one authenticated user — what a tool/resource
 * context carries. `undefined` on a context means "no auth configured" (trusted).
 */
export interface AccessView {
  readonly user: AuthUser;
  canAccess(workspaceId: string): boolean;
  canAdmin(workspaceId: string): boolean;
  onWorkspaceCreated(workspaceId: string): void;
}

/** Bind an {@link McpAuth} to one user, yielding the per-call {@link AccessView}. */
export function bindAccess(auth: McpAuth, user: AuthUser): AccessView {
  return {
    user,
    canAccess: (workspaceId) => auth.canAccess(user, workspaceId),
    canAdmin: (workspaceId) => auth.canAdmin(user, workspaceId),
    onWorkspaceCreated: (workspaceId) => auth.onWorkspaceCreated(user, workspaceId),
  };
}
