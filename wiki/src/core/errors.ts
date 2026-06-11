/**
 * Typed error hierarchy. Every error extends {@link WikiError}, so a
 * consumer can catch the base or narrow on `code` / `instanceof`. No I/O here.
 */

export class WikiError extends Error {
  /** Stable, machine-readable discriminator. */
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = new.target.name;
    // Restore prototype chain for instanceof across transpile targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface SchemaIssue {
  readonly path: (string | number)[];
  readonly message: string;
}

export class ValidationError extends WikiError {
  readonly issues: SchemaIssue[];
  constructor(message: string, issues: SchemaIssue[]) {
    super("VALIDATION", message);
    this.issues = issues;
  }
}

export class MutationNotAllowedError extends WikiError {
  readonly pageType: string;
  readonly status: string;
  readonly command: string;
  readonly allowed: string[];
  constructor(pageType: string, status: string, command: string, allowed: string[]) {
    super(
      "MUTATION_NOT_ALLOWED",
      `Command "${command}" is not allowed on a "${pageType}" in status "${status}". Allowed: [${allowed.join(", ")}].`,
    );
    this.pageType = pageType;
    this.status = status;
    this.command = command;
    this.allowed = allowed;
  }
}

export class WorkspaceNotFoundError extends WikiError {
  readonly id: string;
  constructor(id: string) {
    super("WORKSPACE_NOT_FOUND", `Workspace "${id}" does not exist.`);
    this.id = id;
  }
}

export class WorkspaceArchivedError extends WikiError {
  readonly id: string;
  constructor(id: string) {
    super("WORKSPACE_ARCHIVED", `Workspace "${id}" is archived; mutations are blocked.`);
    this.id = id;
  }
}

export class PageNotFoundError extends WikiError {
  readonly id: string;
  constructor(id: string) {
    super("PAGE_NOT_FOUND", `Page "${id}" does not exist.`);
    this.id = id;
  }
}

export class ItemNotFoundError extends WikiError {
  readonly itemType: string;
  readonly id: string;
  constructor(itemType: string, id: string) {
    super("ITEM_NOT_FOUND", `${itemType} "${id}" does not exist.`);
    this.itemType = itemType;
    this.id = id;
  }
}

export class ParentNotFoundError extends WikiError {
  readonly parentId: string;
  constructor(parentId: string) {
    super("PARENT_NOT_FOUND", `Parent page "${parentId}" does not exist.`);
    this.parentId = parentId;
  }
}

export class CycleError extends WikiError {
  readonly pageId: string;
  readonly newParentId: string;
  constructor(pageId: string, newParentId: string) {
    super("CYCLE", `Reparenting "${pageId}" under "${newParentId}" would create a cycle.`);
    this.pageId = pageId;
    this.newParentId = newParentId;
  }
}

export class DuplicateTitleError extends WikiError {
  readonly parentId: string | null;
  readonly title: string;
  /** The id of the conflicting sibling, when known. */
  readonly conflictId?: string;
  /** Whether that conflicting sibling is archived (it still reserves its title). */
  readonly conflictArchived: boolean;
  constructor(parentId: string | null, title: string, conflictId?: string, conflictArchived = false) {
    const which = conflictId !== undefined ? ` (${conflictId}${conflictArchived ? ", archived" : ""})` : "";
    // Archived siblings still occupy the namespace (they remain in the tree, rendered with an
    // "archived" annotation), so archiving never frees a title — and an archived page cannot
    // itself be renamed (setPageTitle requires an active page). Name the safe recovery paths.
    const archivedHint = conflictArchived
      ? " That sibling is ARCHIVED but still reserves its title; archiving does not free it, and an archived" +
        " page cannot be renamed. Either rename before archiving, or unarchive → rename → re-archive."
      : "";
    super("DUPLICATE_TITLE", `A sibling under "${parentId ?? "@root"}" already has the title "${title}"${which}.${archivedHint}`);
    this.parentId = parentId;
    this.title = title;
    this.conflictId = conflictId;
    this.conflictArchived = conflictArchived;
  }
}

/**
 * Thrown when createPage is asked to create a page whose type is one of the PARENT type's
 * declared {@link IPageTypeDef.requiredChildren} and such a child already exists under that
 * parent. Those children are auto-materialized (pinned) in the parent's create commit, so a
 * manual second one would be an unmanaged duplicate. Names the existing child so the caller
 * authors into it instead.
 */
export class DuplicateRequiredChildError extends WikiError {
  readonly parentId: string;
  readonly childType: string;
  readonly existingId: string;
  constructor(parentId: string, childType: string, existingId: string) {
    super(
      "DUPLICATE_REQUIRED_CHILD",
      `Page type "${childType}" is an auto-created required child of "${parentId}" and already exists as ` +
        `${existingId}. Author into that page instead of creating another — a manual one is an unmanaged duplicate.`,
    );
    this.parentId = parentId;
    this.childType = childType;
    this.existingId = existingId;
  }
}

export class LinkTargetNotFoundError extends WikiError {
  readonly target: string;
  constructor(target: string) {
    super("LINK_TARGET_NOT_FOUND", `Link endpoint "${target}" does not exist.`);
    this.target = target;
  }
}

export class ConcurrencyError extends WikiError {
  readonly expected: number;
  readonly actual: number;
  constructor(expected: number, actual: number) {
    super("CONCURRENCY", `Optimistic-concurrency retries exhausted (expected head ${expected}, saw ${actual}).`);
    this.expected = expected;
    this.actual = actual;
  }
}

export class InvariantViolationError extends WikiError {
  readonly detail: string;
  constructor(detail: string) {
    super("INVARIANT_VIOLATION", detail);
    this.detail = detail;
  }
}

export class UnknownPageTypeError extends WikiError {
  readonly types: string[];
  constructor(types: string[]) {
    super("UNKNOWN_PAGE_TYPE", `History references unregistered page/event type(s): [${types.join(", ")}].`);
    this.types = types;
  }
}

export class SectionNotFoundError extends WikiError {
  readonly section: string;
  constructor(section: string) {
    super("SECTION_NOT_FOUND", `Section "${section}" does not exist on this page.`);
    this.section = section;
  }
}

export class DuplicateSectionKeyError extends WikiError {
  readonly key: string;
  constructor(key: string) {
    super("DUPLICATE_SECTION_KEY", `A sibling section already has the key "${key}".`);
    this.key = key;
  }
}

export class SectionContractError extends WikiError {
  readonly detail: string;
  constructor(detail: string) {
    super("SECTION_CONTRACT", detail);
    this.detail = detail;
  }
}

export class FieldKindError extends WikiError {
  readonly detail: string;
  constructor(detail: string) {
    super("FIELD_KIND", detail);
    this.detail = detail;
  }
}

export class RefIntegrityError extends WikiError {
  readonly detail: string;
  constructor(detail: string) {
    super("REF_INTEGRITY", detail);
    this.detail = detail;
  }
}

export class BlockNormalFormError extends WikiError {
  readonly detail: string;
  constructor(detail: string) {
    super("BLOCK_NORMAL_FORM", detail);
    this.detail = detail;
  }
}

export class PreconditionUnmetError extends WikiError {
  readonly unmet: string;
  constructor(unmet: string) {
    super("PRECONDITION_UNMET", `Transition blocked: ${unmet}`);
    this.unmet = unmet;
  }
}

/**
 * Thrown when a code edit carries a CONTENT-HASH PRECONDITION
 * that no longer holds: the target `code` field/block's CURRENT content hash differs
 * from the `expectedHash` the edits were computed against. Distinct from the
 * stream-level {@link ConcurrencyError} (OCC `Stream-Seq`): this is a *semantic* stale
 * read — the host computed `TextEdit`s against source that has since changed (e.g.
 * another writer edited the same field, or an OCC rebase advanced the head). Evaluated
 * inside the rebase-retried `decide` window, so it re-checks against the freshest state.
 */
export class StaleEditError extends WikiError {
  readonly section: string;
  readonly field: string;
  readonly block: string | undefined;
  readonly expectedHash: string;
  readonly actualHash: string;
  constructor(section: string, field: string, block: string | undefined, expectedHash: string, actualHash: string) {
    super(
      "STALE_EDIT",
      `Code edit precondition failed for "${section}.${field}"${block !== undefined ? `#${block}` : ""}: ` +
        `expected content hash "${expectedHash}" but the current source hashes to "${actualHash}". ` +
        `The edits were computed against stale source; re-read and recompute.`,
    );
    this.section = section;
    this.field = field;
    this.block = block;
    this.expectedHash = expectedHash;
    this.actualHash = actualHash;
  }
}

/**
 * Thrown when one command in an atomic batch (`IWorkspaceHandle.mutateMany`) is
 * rejected. The batch is all-or-nothing: the decision runs entirely in memory before
 * the single append, so a failure aborts the WHOLE batch with nothing committed. This
 * wraps the underlying typed `cause` (e.g. {@link MutationNotAllowedError} carrying the
 * legal set, {@link PreconditionUnmetError} carrying the reason) and pins the 0-based
 * `index` of the failing command so the caller can fix that one command and resubmit.
 * `index`/`command` reflect the FINAL rebase attempt (legality is evaluated against the
 * in-flight state after the prior commands in the same batch — a command legal alone can
 * be illegal mid-batch). The full cause message (incl. the legal set) is embedded so a
 * `WikiError`-to-text mapping surfaces it without inspecting `cause`.
 */
export class BatchCommandError extends WikiError {
  readonly index: number;
  readonly command: string;
  /**
   * How many earlier commands (indices `[0..index-1]`) validated and would have applied before
   * this one failed — equal to `index`. The whole batch is atomic, so NOTHING was committed; this
   * tells a caller the failure is isolated to `command`, so it can fix just that command and resend
   * rather than re-reasoning the entire payload.
   */
  readonly validatedCount: number;
  /** The underlying typed rejection (narrows the standard `Error.cause`). */
  override readonly cause: WikiError;
  constructor(index: number, command: string, cause: WikiError) {
    const validated =
      index === 0 ? "no earlier commands ran" : `commands [0..${index - 1}] validated; only this one failed`;
    super(
      "BATCH_COMMAND_FAILED",
      `Batch aborted at command [${index}] "${command}" (${validated}; nothing was committed): ${cause.message}`,
    );
    this.index = index;
    this.command = command;
    this.validatedCount = index;
    this.cause = cause;
  }
}

/** One command's rejection within a batch — the 0-based `index`, the `command` name, and
 *  the underlying typed `cause`. Carried in bulk by {@link BatchCommandsError}. */
export interface BatchFailure {
  readonly index: number;
  readonly command: string;
  readonly cause: WikiError;
}

/**
 * Thrown when MORE THAN ONE command in a batch fails — the batch's failures collected in a
 * single pass so the caller can fix them all at once instead of resubmitting to discover the
 * next one. Shares the `BATCH_COMMAND_FAILED` code with {@link BatchCommandError} (the
 * single-failure case still throws that), so a `code`-based handler treats both alike. The
 * batch stays atomic — NOTHING was committed. Each command is decided against the state left
 * by the prior commands that PASSED (a failed command's effects are not folded), so a failure
 * AFTER an earlier one may be a downstream effect of it; fix the earliest first. `failures` is
 * in ascending `index` order; the full enumerated list (each cause's message) rides in the
 * `message` so a `WikiError`-to-text mapping surfaces it without inspecting `failures`.
 */
export class BatchCommandsError extends WikiError {
  readonly failures: readonly BatchFailure[];
  constructor(failures: readonly BatchFailure[]) {
    const total = failures.length;
    const lines = failures.map((f) => `  [${f.index}] "${f.command}": ${f.cause.message}`).join("\n");
    super(
      "BATCH_COMMAND_FAILED",
      `Batch aborted: ${total} commands failed (nothing was committed). Fix each and resubmit:\n${lines}\n` +
        `Each command is checked against the state left by the prior commands that passed, so a later ` +
        `failure may be downstream of an earlier one — fix the earliest first.`,
    );
    this.failures = failures;
  }
}

/**
 * Thrown when a token-gated read's `waitFor` exceeds its timeout — the read model
 * hasn't applied the requested {@link ConsistencyToken} in time.
 * Carries the awaited `token` + `timeoutMs` so a caller can retry or fall back to an
 * eventually-consistent read (omit the token). `token` is a `ConsistencyToken`
 * (an opaque `string`, declared in `api.ts`); kept as `string` here to keep this
 * module dependency-free.
 */
export class ConsistencyTimeoutError extends WikiError {
  readonly token: string;
  readonly timeoutMs: number;
  constructor(token: string, timeoutMs: number) {
    super(
      "CONSISTENCY_TIMEOUT",
      `Read model did not apply token "${token}" within ${timeoutMs} ms.`,
    );
    this.token = token;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Thrown to a parked `waitFor` when its workspace is forgotten (handle teardown /
 * `wiki.close()`) while the wait is still pending — a token-gated read can never be
 * satisfied once its read model is gone, so it fails fast instead of hanging until the
 * timeout. Distinct from {@link ConsistencyTimeoutError} (the wait elapsed): this is a
 * deliberate teardown. `workspace` is a `WorkspaceId` (opaque `string`); kept as
 * `string` here to keep this module dependency-free.
 */
export class ReadModelClosedError extends WikiError {
  readonly workspace: string;
  constructor(workspace: string) {
    super(
      "READ_MODEL_CLOSED",
      `Read model forgot workspace "${workspace}" while a consistency wait was pending.`,
    );
    this.workspace = workspace;
  }
}

/**
 * Thrown to a token-gated search when the best-effort search-index reindex for that
 * workspace FAILED to reach the awaited version. The durable
 * write itself succeeded; only the derived full-text index could not apply, so the
 * caller should retry the search or read without a consistency token (an
 * eventually-consistent, token-less search still works). Distinct from
 * {@link ConsistencyTimeoutError}: search fails FAST with the underlying `cause` rather
 * than hanging until the timeout. Wraps the raw DB/Kysely error so the MCP boundary maps
 * it by `code` instead of emitting an opaque internal error.
 */
export class SearchIndexUnavailableError extends WikiError {
  override readonly cause: unknown;
  readonly workspace: string;
  readonly version: number;
  constructor(workspace: string, version: number, cause: unknown) {
    super(
      "SEARCH_INDEX_UNAVAILABLE",
      `Search index could not apply workspace "${workspace}" to version ${version}: ` +
        `${cause instanceof Error ? cause.message : String(cause)}. ` +
        `The durable write succeeded; retry the search or read without a consistency token.`,
    );
    this.cause = cause;
    this.workspace = workspace;
    this.version = version;
  }
}
