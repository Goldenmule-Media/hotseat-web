/**
 * Write-time validation for references that cross into another workspace. The engine can't
 * read another stream, so the host checks access, confirms the target in the SQL read model,
 * and supplies the title snapshot the reference renders with.
 */
import { LinkTargetNotFoundError, WikiError, type WorkspaceId } from "wiki";

import type { WikiToolContext } from "./tools.js";

export class AccessDeniedError extends WikiError {
  readonly workspaceId: string;
  constructor(login: string, workspaceId: string) {
    super("ACCESS_DENIED", `${login} is not a member of workspace ${workspaceId}.`);
    this.workspaceId = workspaceId;
  }
}

export interface ICrossWorkspaceTarget {
  readonly title: string;
  readonly archived: boolean;
}

export function requireAccess(ctx: WikiToolContext, workspace: WorkspaceId): void {
  if (ctx.access !== undefined && !ctx.access.canAccess(workspace)) {
    throw new AccessDeniedError(ctx.access.user.login, workspace);
  }
}

/** Gate, wait for the session's own writes there, and read the target's current title. */
export async function resolveCrossWorkspaceTarget(
  ctx: WikiToolContext,
  workspace: WorkspaceId,
  pageId: string,
): Promise<ICrossWorkspaceTarget> {
  requireAccess(ctx, workspace);
  const token = ctx.tokens.consistentWith(ctx.sessionId, workspace);
  if (token !== undefined) await ctx.readModel.waitFor(token);
  const row = await ctx.readModel.getPage(workspace, pageId);
  if (row === undefined) throw new LinkTargetNotFoundError(`${workspace}/${pageId}`);
  return { title: row.title, archived: row.archived };
}
