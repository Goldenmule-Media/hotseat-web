/**
 * Typed error hierarchy (DESIGN §14). Every error extends {@link WikiError}, so a
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
  constructor(parentId: string | null, title: string) {
    super("DUPLICATE_TITLE", `A sibling under "${parentId ?? "@root"}" already has the title "${title}".`);
    this.parentId = parentId;
    this.title = title;
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
 * Thrown when a token-gated read's `waitFor` exceeds its timeout — the read model
 * hasn't applied the requested {@link ConsistencyToken} in time (DESIGN §8.6/§14).
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
