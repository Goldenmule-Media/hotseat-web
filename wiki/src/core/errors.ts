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
