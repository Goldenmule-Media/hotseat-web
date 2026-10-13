/**
 * Content refs that leave their workspace. See {@link ICrossWorkspaceRef} for the shape; this
 * module reads it (for ingestion and render) and finds it in raw command args (for hosts that
 * validate the target and stamp the title snapshot before a write).
 */
import type { PageId, RefTarget, WorkspaceId } from "../api";

export interface ICrossWorkspaceRefTarget {
  readonly workspace: WorkspaceId;
  readonly page: PageId;
  readonly title: string;
}

/**
 * The target of a ref that leaves `current`, or `undefined` for a local ref (no `workspace`,
 * or `current` itself) and for a malformed one (no page, or an empty or multi-line title).
 */
export function crossWorkspaceRefOf(target: RefTarget, current: WorkspaceId): ICrossWorkspaceRefTarget | undefined {
  const workspace = target.workspace;
  if (workspace === undefined || workspace === current) return undefined;
  if (typeof workspace !== "string" || workspace.length === 0) return undefined;
  const page = target.kind === "page" ? target.id : target.page;
  const title = typeof target.title === "string" ? target.title.trim() : "";
  if (typeof page !== "string" || page.length === 0 || title.length === 0 || /[\r\n]/.test(title)) return undefined;
  return { workspace, page, title };
}

/** A cross-workspace ref found in command args. */
export interface ICrossWorkspaceArgRef {
  readonly workspace: WorkspaceId;
  readonly page: PageId;
  readonly kind: RefTarget["kind"];
  /** The arg object that carries the ref; a host writes the title snapshot to its `title`. */
  readonly holder: Record<string, unknown>;
}

const REF_KINDS: ReadonlySet<string> = new Set(["page", "section", "symbol", "block", "element"]);

/**
 * Every cross-workspace ref in a command's raw args, at any depth: an object with a
 * `workspace` other than `current` and a page, given as `ref` (the inline-run form
 * `{ref, workspace}`), as `id` on a `kind: "page"` target, or as `page` on any other kind.
 */
export function collectCrossWorkspaceArgRefs(args: unknown, current: WorkspaceId): ICrossWorkspaceArgRef[] {
  const found: ICrossWorkspaceArgRef[] = [];
  const seen = new Set<object>();
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const o = value as Record<string, unknown>;
    const workspace = o["workspace"];
    if (typeof workspace === "string" && workspace.length > 0 && workspace !== current) {
      const kind = o["kind"];
      if (typeof o["ref"] === "string") {
        found.push({ workspace: workspace as WorkspaceId, page: o["ref"] as PageId, kind: "page", holder: o });
      } else if (kind === "page" && typeof o["id"] === "string") {
        found.push({ workspace: workspace as WorkspaceId, page: o["id"] as PageId, kind: "page", holder: o });
      } else if (typeof kind === "string" && REF_KINDS.has(kind) && typeof o["page"] === "string") {
        found.push({ workspace: workspace as WorkspaceId, page: o["page"] as PageId, kind: kind as RefTarget["kind"], holder: o });
      }
    }
    for (const child of Object.values(o)) visit(child);
  };
  visit(args);
  return found;
}
