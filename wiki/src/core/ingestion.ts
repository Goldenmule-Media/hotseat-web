/**
 * Ingestion validation + normalization (structured-content §7, §10). Pure,
 * deterministic, engine-owned. Operates on the *resulting* state, never on meaning.
 *
 * - `contentHash` — a tiny dependency-free FNV-1a hash for `code` source (§10/§13).
 * - `normalizeBlocks` — block normal form (§10): merge adjacent same-mark text,
 *   canonical-sort marks. Runs at ingestion so render is a pure identity projection.
 * - `validateSections` — field-kind grammar, no-markdown-in-text-leaf, block normal
 *   form, and ref integrity over the whole page (§7).
 */
import type {
  IBlock,
  IField,
  IInline,
  IPageNode,
  IWorkspaceState,
  Mark,
  PageId,
  RefTarget,
  ISection,
} from "../api";
import { BlockNormalFormError, FieldKindError, RefIntegrityError } from "./errors";
import type { Registry } from "./registry";

// ────────────────────────────────────────────────────────────────────────────
// Content hash (FNV-1a, 32-bit) — dependency-free, deterministic (§10)
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
// Mark canonicalization (§3.2 / §10)
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
// Inline / block normalization (§10) — array order, merged runs, sorted marks
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
// no-markdown-in-text-leaf (§3.3 / §7)
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
// Block normal-form assertions (§10)
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
// Ref integrity (§7) — recurses into block & inline trees
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
// Field-kind grammar (§7)
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

/**
 * Engine well-formedness over a page's resulting sections (§7): field-kind grammar,
 * no-markdown-in-text-leaf, block normal form, and ref integrity (deep). Pure.
 */
export function validatePage(state: IWorkspaceState, page: IPageNode, _registry: Registry): void {
  for (const section of page.sections) validateSection(state, page, section);
}
