/**
 * Ingestion validation + normalization. Pure,
 * deterministic, engine-owned. Operates on the *resulting* state, never on meaning.
 *
 * - `contentHash` — a tiny dependency-free FNV-1a hash for `code` source.
 * - `normalizeBlocks` — block normal form: merge adjacent same-mark text,
 *   canonical-sort marks. Runs at ingestion so render is a pure identity projection.
 * - `validateSections` — field-kind grammar, no-markdown-in-text-leaf, block normal
 *   form, and ref integrity over the whole page.
 */
import type {
  DeepReadonly,
  FieldDecl,
  IBlock,
  IField,
  IInline,
  IPageNode,
  IPageTypeDef,
  IWorkspaceState,
  Mark,
  PageId,
  RefTarget,
  ISection,
} from "../api";
import { BlockNormalFormError, FieldKindError, PreconditionUnmetError, RefIntegrityError, ValidationError } from "./errors";
import type { Registry } from "./registry";

// ────────────────────────────────────────────────────────────────────────────
// Content hash (FNV-1a, 32-bit) — dependency-free, deterministic
// ────────────────────────────────────────────────────────────────────────────

export function contentHash(source: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < source.length; i++) {
    h ^= source.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// ────────────────────────────────────────────────────────────────────────────
// Mark canonicalization
// ────────────────────────────────────────────────────────────────────────────

/** Fixed total order: emphasis < strong < link(href) by href. */
function markRank(m: Mark): string {
  if (m === "emphasis") return "0";
  if (m === "strong") return "1";
  return "2\u0000" + m.href;
}

function markEqual(a: Mark, b: Mark): boolean {
  if (typeof a === "string" || typeof b === "string") return a === b;
  return a.kind === "link" && b.kind === "link" && a.href === b.href;
}

function canonicalMarks(marks: Mark[]): Mark[] {
  const out: Mark[] = [];
  for (const m of marks) {
    if (!out.some((x) => markEqual(x, m))) out.push(m);
  }
  return out.sort((a, b) => (markRank(a) < markRank(b) ? -1 : markRank(a) > markRank(b) ? 1 : 0));
}

function marksEqual(a: Mark[], b: Mark[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((m, i) => markEqual(m, b[i]!));
}

// ────────────────────────────────────────────────────────────────────────────
// Inline / block normalization — array order, merged runs, sorted marks
// ────────────────────────────────────────────────────────────────────────────

function normalizeInlines(inlines: IInline[]): IInline[] {
  const out: IInline[] = [];
  for (const run of inlines) {
    if (run.kind === "text") {
      const marks = canonicalMarks(run.marks);
      const prev = out[out.length - 1];
      if (prev !== undefined && prev.kind === "text" && marksEqual(prev.marks, marks)) {
        out[out.length - 1] = { kind: "text", value: prev.value + run.value, marks };
        continue;
      }
      out.push({ kind: "text", value: run.value, marks });
    } else {
      out.push(run);
    }
  }
  return out;
}

/** Normalize a block tree to canonical form. Mutates a structuredClone, returns it. */
export function normalizeBlock(block: IBlock): IBlock {
  switch (block.kind) {
    case "paragraph":
      return { kind: "paragraph", id: block.id, inlines: normalizeInlines(block.inlines) };
    case "heading":
      return { kind: "heading", id: block.id, level: block.level, inlines: normalizeInlines(block.inlines) };
    case "code":
      return { kind: "code", id: block.id, lang: block.lang, source: block.source, hash: contentHash(block.source) };
    case "list":
      return { kind: "list", id: block.id, ordered: block.ordered, items: block.items.map((b) => b.map(normalizeBlock)) };
    case "table":
      return {
        kind: "table",
        id: block.id,
        align: block.align,
        header: block.header.map(normalizeInlines),
        rows: block.rows.map((row) => row.map(normalizeInlines)),
      };
    case "quote":
      return { kind: "quote", id: block.id, ...(block.variant !== undefined ? { variant: block.variant } : {}), blocks: block.blocks.map(normalizeBlock) };
    case "divider":
      return { kind: "divider", id: block.id };
  }
}

export function normalizeBlocks(blocks: IBlock[]): IBlock[] {
  return blocks.map(normalizeBlock);
}

// ────────────────────────────────────────────────────────────────────────────
// no-markdown-in-text-leaf
// ────────────────────────────────────────────────────────────────────────────

const MARKDOWN_LEAF = /```|`|\*|_|\[[^\]]*\]\([^)]*\)|^#/m;

function assertNoMarkdownInText(value: string): void {
  if (MARKDOWN_LEAF.test(value)) {
    throw new BlockNormalFormError(
      `A blocks text run may not contain Markdown syntax (fence/backtick/*/_/[..](..)/leading #). Reify as a code-span, mark, or ref.`,
    );
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Block normal-form assertions
// ────────────────────────────────────────────────────────────────────────────

function assertInlineNormalForm(inlines: IInline[]): void {
  let prev: IInline | undefined;
  for (const run of inlines) {
    if (run.kind === "text") {
      assertNoMarkdownInText(run.value);
      const sorted = canonicalMarks(run.marks);
      if (!marksEqual(sorted, run.marks)) {
        throw new BlockNormalFormError("Text run marks are not canonical-sorted.");
      }
      if (prev !== undefined && prev.kind === "text" && marksEqual(prev.marks, run.marks)) {
        throw new BlockNormalFormError("Adjacent text runs with equal marks must be merged.");
      }
    }
    prev = run;
  }
}

function assertBlockNormalForm(block: IBlock): void {
  switch (block.kind) {
    case "paragraph":
    case "heading":
      assertInlineNormalForm(block.inlines);
      break;
    case "code":
      if (typeof block.lang !== "string" || block.lang.length === 0) {
        throw new FieldKindError("A code block requires a non-empty lang tag.");
      }
      if (block.hash !== contentHash(block.source)) {
        throw new BlockNormalFormError("Code block hash does not match its source.");
      }
      break;
    case "list":
      for (const item of block.items) for (const b of item) assertBlockNormalForm(b);
      break;
    case "table": {
      const width = block.align.length;
      if (block.header.length !== width) {
        throw new BlockNormalFormError("Table header width must equal the align width.");
      }
      for (const cell of block.header) assertInlineNormalForm(cell);
      for (const row of block.rows) {
        if (row.length !== width) throw new BlockNormalFormError("Table rows must be rectangular.");
        for (const cell of row) assertInlineNormalForm(cell);
      }
      break;
    }
    case "quote":
      for (const b of block.blocks) assertBlockNormalForm(b);
      break;
    case "divider":
      break;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Ref integrity — recurses into block & inline trees
// ────────────────────────────────────────────────────────────────────────────

function resolveRef(state: IWorkspaceState, page: IPageNode, target: RefTarget): boolean {
  if (target.kind === "page") return state.pages.has(target.id);
  // Non-`page` kinds resolve within an OWNER page: the cross-page `target.page` when
  // present (ref integrity now spans pages), else the page being validated.
  const owner = target.page === undefined ? page : state.pages.get(target.page);
  if (owner === undefined) return false;
  switch (target.kind) {
    case "section":
      return owner.sections.some((s) => s.id === target.id);
    case "symbol":
    case "block": {
      const sec = owner.sections.find((s) => s.id === target.section);
      if (sec === undefined) return false;
      return sec.fields[target.field] !== undefined;
    }
    case "element": {
      const sec = owner.sections.find((s) => s.id === target.section);
      const f = sec?.fields[target.field];
      return f !== undefined && f.kind === "list" && f.elements.some((e) => e.id === target.element);
    }
  }
}

function checkInlineRefs(state: IWorkspaceState, page: IPageNode, inlines: IInline[]): void {
  for (const run of inlines) {
    if (run.kind === "ref" && !resolveRef(state, page, run.target)) {
      throw new RefIntegrityError(`Inline ref target does not resolve (kind=${run.target.kind}).`);
    }
  }
}

function checkBlockRefs(state: IWorkspaceState, page: IPageNode, block: IBlock): void {
  switch (block.kind) {
    case "paragraph":
    case "heading":
      checkInlineRefs(state, page, block.inlines);
      break;
    case "list":
      for (const item of block.items) for (const b of item) checkBlockRefs(state, page, b);
      break;
    case "table":
      for (const cell of block.header) checkInlineRefs(state, page, cell);
      for (const row of block.rows) for (const cell of row) checkInlineRefs(state, page, cell);
      break;
    case "quote":
      for (const b of block.blocks) checkBlockRefs(state, page, b);
      break;
    default:
      break;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Field-kind grammar
// ────────────────────────────────────────────────────────────────────────────

function validateField(state: IWorkspaceState, page: IPageNode, field: IField): void {
  switch (field.kind) {
    case "scalar":
      if (!["string", "number", "boolean"].includes(typeof field.value)) {
        throw new FieldKindError("A scalar field must be string/number/boolean.");
      }
      break;
    case "prose":
      if (typeof field.value !== "string") throw new FieldKindError("A prose field must be a string.");
      if (/```/.test(field.value)) {
        throw new FieldKindError("A prose field rejects fenced code — use a code field.");
      }
      break;
    case "code":
      if (typeof field.lang !== "string" || field.lang.length === 0) {
        throw new FieldKindError("A code field requires a non-empty lang tag.");
      }
      if (field.hash !== contentHash(field.source)) {
        throw new FieldKindError("Code field hash does not match its source.");
      }
      break;
    case "attachment-ref":
      if (!field.ref || !field.mime || !field.name) {
        throw new FieldKindError("An attachment-ref field requires ref/mime/name.");
      }
      break;
    case "ref":
      if (!resolveRef(state, page, field.target)) {
        throw new RefIntegrityError(`Ref field target does not resolve (kind=${field.target.kind}).`);
      }
      break;
    case "blocks":
      for (const block of field.blocks) {
        assertBlockNormalForm(block);
        checkBlockRefs(state, page, block);
      }
      break;
    case "list":
      for (const el of field.elements) {
        for (const f of Object.values(el.fields)) validateField(state, page, f);
      }
      break;
    default:
      throw new FieldKindError(`Unknown field kind.`);
  }
}

function validateSection(state: IWorkspaceState, page: IPageNode, section: ISection): void {
  for (const f of Object.values(section.fields)) validateField(state, page, f);
}

// ────────────────────────────────────────────────────────────────────────────
// Declared-constraint validation — required fields + scalar field schemas
//
// The engine auto-generates structural commands (setField / setElementField / addElement)
// that pass caller values straight to the reducer; without this pass they would bypass a
// page type's declared `required` flags and scalar `schema` (e.g. an enum). Enforced here,
// on the post-op state, so EVERY write path (declarative, produces, generated) is covered
// uniformly. This runs only on the write-side dry-run — never on projection/fold — so it
// constrains new writes without rejecting already-committed history.
// ────────────────────────────────────────────────────────────────────────────

/** A scalar value must satisfy its FieldDecl's declared `schema` (e.g. an enum). An empty
 *  string on a NON-required scalar is treated as unset — required SECTIONS materialize their
 *  scalars to `""` at create (operations.materializeSectionFields), and that empty must not be
 *  rejected before a real value is set. A required scalar's `""` IS validated (and so rejected
 *  by an enum), since required element fields are never materialized — an empty there is a real,
 *  invalid caller value (e.g. a generated setElementField setting `dependency.role` to `""`).
 *  Surfaces the schema's own {@link ValidationError} (stable `VALIDATION` code) so the
 *  generated path matches the curated command's arg-validation, with the field location added. */
function validateScalarSchema(value: IField, decl: FieldDecl, where: string): void {
  if (decl.kind !== "scalar" || decl.schema === undefined) return;
  if (value.kind !== "scalar") return;
  if (value.value === "" && decl.required !== true) return;
  try {
    decl.schema.parse(value.value);
  } catch (err) {
    if (err instanceof ValidationError) throw new ValidationError(`${where} has an invalid value: ${err.message}`, err.issues);
    throw err;
  }
}

/** Every FieldDecl marked `required` must be present in the materialized field set. */
function validateRequiredPresent(
  fields: Record<string, IField>,
  decls: Readonly<Record<string, FieldDecl>>,
  where: string,
): void {
  for (const [key, decl] of Object.entries(decls)) {
    if (decl.required === true && fields[key] === undefined) {
      throw new FieldKindError(`${where} is missing required field "${key}".`);
    }
  }
}

/** Enforce a page type's DECLARED field constraints (required + scalar schema) over a
 *  section's own fields and its list elements' fields. Top-level declared sections only
 *  (ad-hoc / nested sections carry no top-level decl and are left to the grammar check). */
function validateDeclaredConstraints(section: ISection, def: IPageTypeDef, type: string): void {
  const sd = def.sections[section.key];
  if (sd === undefined) return;
  validateRequiredPresent(section.fields, sd.fields, `${type}.${section.key}`);
  for (const [fk, fd] of Object.entries(sd.fields)) {
    const f = section.fields[fk];
    if (f === undefined) continue;
    if (fd.kind === "scalar") {
      validateScalarSchema(f, fd, `${type}.${section.key}.${fk}`);
    } else if (fd.kind === "list" && f.kind === "list") {
      const elDecl = def.elements?.[fd.element];
      if (elDecl === undefined) continue;
      for (const el of f.elements) {
        const at = `${type}.${section.key}.${fk}[${el.id}]`;
        validateRequiredPresent(el.fields, elDecl.fields, at);
        for (const [efk, efd] of Object.entries(elDecl.fields)) {
          const ef = el.fields[efk];
          if (ef !== undefined && efd.kind === "scalar") validateScalarSchema(ef, efd, `${at}.${efk}`);
        }
      }
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Authored-ness — the `requiredIn` gate's notion of "carries real content"
// ────────────────────────────────────────────────────────────────────────────

/**
 * Is a field AUTHORED — i.e. does it carry real content, as opposed to the empty value a
 * required section materializes at create? Per kind: scalar/prose non-empty string (a
 * scalar holding a non-string — number/boolean — is always authored), code non-empty
 * source, blocks/list non-empty, ref always (an UNSET ref materializes as a scalar `""`,
 * so reaching the ref shape means it was set), attachment-ref always (presence is
 * content; the grammar checks its parts).
 */
function fieldAuthored(field: DeepReadonly<IField>): boolean {
  switch (field.kind) {
    case "scalar":
      return field.value !== "";
    case "prose":
      return field.value !== "";
    case "code":
      return field.source !== "";
    case "blocks":
      return field.blocks.length > 0;
    case "list":
      return field.elements.length > 0;
    default:
      return true; // ref / attachment-ref
  }
}

/**
 * The `section.field` paths of every declared field whose `requiredIn` names `status`
 * but which is currently UNAUTHORED. Top-level declared sections only (mirroring the
 * declared-constraint pass). Shared by the write-side gate below and by
 * `describeMutations`' predictive unmet on page-transition commands.
 */
export function unauthoredRequiredInFields(
  sections: readonly DeepReadonly<Pick<ISection, "key" | "fields">>[],
  def: IPageTypeDef,
  status: string,
): string[] {
  const missing: string[] = [];
  for (const [key, sd] of Object.entries(def.sections)) {
    const fields = sections.find((s) => s.key === key)?.fields;
    for (const [fk, fd] of Object.entries(sd.fields)) {
      if (fd.requiredIn === undefined || !fd.requiredIn.includes(status)) continue;
      const f = fields?.[fk];
      if (f === undefined || !fieldAuthored(f)) missing.push(`${key}.${fk}`);
    }
  }
  return missing;
}

/** The `requiredIn` gate over a post-op page state: in the page's (post-fold) status,
 *  every field declaring that status must be authored — rejecting both a transition INTO
 *  the status while content is missing and a write that would BLANK such a field while in
 *  it. {@link PreconditionUnmetError} so hosts surface it like any other unmet gate. */
function validateRequiredInAuthored(page: IPageNode, def: IPageTypeDef): void {
  const missing = unauthoredRequiredInFields(page.sections, def, page.status);
  if (missing.length > 0) {
    throw new PreconditionUnmetError(
      `author ${missing.join(", ")} — required in status "${page.status}"`,
    );
  }
}

/**
 * Engine well-formedness over a page's resulting sections: field-kind grammar,
 * no-markdown-in-text-leaf, block normal form, ref integrity (deep), PLUS the page type's
 * declared `required`/scalar-`schema` constraints and the `requiredIn` authored-ness gate
 * (so generated structural commands can't bypass them). Pure. Runs only on the write-side
 * dry-run — never on projection/fold — so already-committed history is never rejected.
 */
export function validatePage(state: IWorkspaceState, page: IPageNode, registry: Registry): void {
  for (const section of page.sections) validateSection(state, page, section);
  if (!registry.has(page.type)) return;
  const def = registry.page(page.type);
  for (const section of page.sections) validateDeclaredConstraints(section, def, page.type);
  validateRequiredInAuthored(page, def);
}
