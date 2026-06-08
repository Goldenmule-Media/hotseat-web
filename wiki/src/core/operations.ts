/**
 * The single engine-owned reducer over section operations (§9.4). One pure, total
 * function folds a `SectionOp[]` into a page's `sections` tree — replacing every
 * author `apply`. No clock/RNG: `now` and any ids ride in via the op payload / ctx.
 */
import type {
  IBlock,
  IField,
  IItem,
  ISection,
  PageState,
  SectionId,
  SectionOp,
  TextEdit,
} from "../api";
import type { SectionDecl, ElementDecl, IPageTypeDef } from "../api";
import { FieldKindError, SectionNotFoundError } from "./errors";
import { contentHash, normalizeBlock, normalizeBlocks } from "./ingestion";
import {
  insertSection,
  moveSectionByKey,
  removeSectionByKey,
  renameSectionByKey,
  requireSectionByKey,
} from "./section-structure";

export interface ApplyOpsCtx {
  readonly now: string;
  readonly def?: IPageTypeDef;
  /** Resolve the page FSM's resulting status for an event (from the registry guard). */
  readonly pageNext?: (status: string, event: string) => string | undefined;
  /** Resolve an element FSM's resulting status for an event. */
  readonly elementNext?: (elementType: string, status: string, event: string) => string | undefined;
}

function section(page: PageState, key: string): ISection {
  return requireSectionByKey(page.sections, key);
}

function listField(sec: ISection, field: string): { kind: "list"; elementType: string; elements: IItem[] } {
  const f = sec.fields[field];
  if (f === undefined || f.kind !== "list") {
    throw new FieldKindError(`Field "${field}" on section "${sec.key}" is not a list.`);
  }
  return f;
}

function firstListField(sec: ISection): { kind: "list"; elementType: string; elements: IItem[] } | undefined {
  for (const f of Object.values(sec.fields)) if (f.kind === "list") return f;
  return undefined;
}

function blocksField(sec: ISection, field: string): { kind: "blocks"; blocks: IBlock[] } {
  const f = sec.fields[field];
  if (f === undefined || f.kind !== "blocks") {
    throw new FieldKindError(`Field "${field}" on section "${sec.key}" is not a blocks field.`);
  }
  return f;
}

/** Apply a TextEdit[] to a source string — descending by start so offsets stay valid. */
function applyTextEdits(source: string, edits: readonly TextEdit[]): string {
  const ordered = [...edits].sort((a, b) => b.start - a.start);
  let out = source;
  for (const e of ordered) {
    out = out.slice(0, e.start) + e.replacement + out.slice(e.end);
  }
  return out;
}

function declOfSection(def: IPageTypeDef | undefined, key: string): SectionDecl | undefined {
  return def?.sections[key];
}

function declOfElement(def: IPageTypeDef | undefined, elementType: string): ElementDecl | undefined {
  return def?.elements?.[elementType];
}

/** Route an op through a section/element's `reduceMeta` single-writer hook (§9.5). */
function routeMeta(meta: unknown, op: SectionOp, reduceMeta?: (m: unknown, o: SectionOp) => unknown): unknown {
  if (reduceMeta === undefined) return meta;
  return reduceMeta(meta, op);
}

/**
 * Fold an ordered op list into `page` (mutating in place). Total & pure given the
 * injected `ctx.now`. Bumps `page.updatedAt` once.
 */
export function applyOps(page: PageState, ops: readonly SectionOp[], ctx: ApplyOpsCtx): void {
  const def = ctx.def;
  for (const op of ops) {
    switch (op.op) {
      case "setField": {
        const sec = section(page, op.section);
        sec.fields[op.field] = normalizeFieldValue(op.value);
        applySectionReduceMeta(sec, op, def);
        break;
      }
      case "applyTextEdits": {
        const sec = section(page, op.section);
        if (op.block !== undefined) {
          const bf = blocksField(sec, op.field);
          const target = bf.blocks.find((b) => b.id === op.block);
          if (target !== undefined && target.kind === "code") {
            const source = applyTextEdits(target.source, op.edits);
            const idx = bf.blocks.indexOf(target);
            bf.blocks[idx] = { kind: "code", id: target.id, lang: target.lang, source, hash: contentHash(source) };
          }
        } else {
          const f = sec.fields[op.field];
          if (f !== undefined && f.kind === "code") {
            const source = applyTextEdits(f.source, op.edits);
            sec.fields[op.field] = { kind: "code", lang: f.lang, source, hash: contentHash(source) };
          } else {
            throw new FieldKindError(`applyTextEdits targets a code field/block; "${op.field}" is not code.`);
          }
        }
        applySectionReduceMeta(sec, op, def);
        break;
      }
      case "addElement": {
        const sec = section(page, op.section);
        const lf = listField(sec, op.field);
        const elDecl = declOfElement(def, lf.elementType);
        const status = op.status ?? elDecl?.status?.initial;
        const item: IItem = {
          id: op.id,
          ...(status !== undefined ? { status } : {}),
          fields: normalizeFields(op.fields),
          ...(op.meta !== undefined ? { meta: op.meta } : {}),
        };
        const at = op.index === undefined ? lf.elements.length : Math.max(0, Math.min(op.index, lf.elements.length));
        lf.elements.splice(at, 0, item);
        applyElementReduceMeta(item, op, elDecl);
        applySectionReduceMeta(sec, op, def);
        break;
      }
      case "removeElement": {
        const sec = section(page, op.section);
        const lf = listField(sec, op.field);
        const idx = lf.elements.findIndex((e) => e.id === op.id);
        if (idx !== -1) lf.elements.splice(idx, 1);
        applySectionReduceMeta(sec, op, def);
        break;
      }
      case "moveElement": {
        const sec = section(page, op.section);
        const lf = listField(sec, op.field);
        const idx = lf.elements.findIndex((e) => e.id === op.id);
        if (idx !== -1) {
          const [el] = lf.elements.splice(idx, 1);
          const at = Math.max(0, Math.min(op.toIndex, lf.elements.length));
          lf.elements.splice(at, 0, el!);
        }
        applySectionReduceMeta(sec, op, def);
        break;
      }
      case "setElementField": {
        const sec = section(page, op.section);
        const lf = listField(sec, op.field);
        const el = lf.elements.find((e) => e.id === op.id);
        if (el !== undefined) {
          el.fields[op.elementField] = normalizeFieldValue(op.value);
          applyElementReduceMeta(el, op, declOfElement(def, lf.elementType));
        }
        applySectionReduceMeta(sec, op, def);
        break;
      }
      case "addBlock": {
        const sec = section(page, op.section);
        const bf = blocksField(sec, op.field);
        const at = op.index === undefined ? bf.blocks.length : Math.max(0, Math.min(op.index, bf.blocks.length));
        bf.blocks.splice(at, 0, normalizeBlock(op.block));
        applySectionReduceMeta(sec, op, def);
        break;
      }
      case "removeBlock": {
        const sec = section(page, op.section);
        const bf = blocksField(sec, op.field);
        const idx = bf.blocks.findIndex((b) => b.id === op.block);
        if (idx !== -1) bf.blocks.splice(idx, 1);
        applySectionReduceMeta(sec, op, def);
        break;
      }
      case "moveBlock": {
        const sec = section(page, op.section);
        const bf = blocksField(sec, op.field);
        const idx = bf.blocks.findIndex((b) => b.id === op.block);
        if (idx !== -1) {
          const [b] = bf.blocks.splice(idx, 1);
          const at = Math.max(0, Math.min(op.toIndex, bf.blocks.length));
          bf.blocks.splice(at, 0, b!);
        }
        applySectionReduceMeta(sec, op, def);
        break;
      }
      case "setBlock": {
        const sec = section(page, op.section);
        const bf = blocksField(sec, op.field);
        const idx = bf.blocks.findIndex((b) => b.id === op.block.id);
        if (idx !== -1) bf.blocks[idx] = normalizeBlock(op.block);
        applySectionReduceMeta(sec, op, def);
        break;
      }
      case "addSection": {
        const id = (op.id ?? (`sec:${op.key}` as SectionId)) as SectionId;
        const inserted = insertSection(
          page.sections,
          {
            id,
            key: op.key,
            name: op.name,
            ...(op.description !== undefined ? { description: op.description } : {}),
            parentId: op.parentSection ?? null,
          },
          op.index,
        );
        // Materialize declared fields for this key, if a decl exists.
        const decl = declOfSection(def, op.key);
        if (decl !== undefined) materializeSectionFields(inserted, decl);
        break;
      }
      case "removeSection": {
        removeSectionByKey(page.sections, op.section);
        break;
      }
      case "moveSection": {
        moveSectionByKey(page.sections, op.section, op.parentSection, op.toIndex);
        break;
      }
      case "renameSection": {
        renameSectionByKey(page.sections, op.section, op.name);
        break;
      }
      case "setMeta": {
        const sec = section(page, op.section);
        const decl = declOfSection(def, op.section);
        if (op.element !== undefined) {
          for (const f of Object.values(sec.fields)) {
            if (f.kind === "list") {
              const el = f.elements.find((e) => e.id === op.element);
              if (el !== undefined) {
                const elDecl = declOfElement(def, f.elementType);
                if (elDecl?.reduceMeta !== undefined) {
                  el.meta = routeMeta(el.meta, op, elDecl.reduceMeta) as Record<string, unknown> | undefined;
                } else {
                  el.meta = setPath(el.meta ?? {}, op.path, op.value);
                }
              }
            }
          }
        } else if (decl?.reduceMeta !== undefined) {
          sec.meta = routeMeta(sec.meta, op, decl.reduceMeta) as Record<string, unknown> | undefined;
        } else {
          sec.meta = setPath(sec.meta ?? {}, op.path, op.value);
        }
        break;
      }
      case "transition": {
        if (op.level === "page") {
          const next = ctx.pageNext?.(page.status, op.event);
          if (next !== undefined) page.status = next;
        } else if (op.section !== undefined && op.element !== undefined) {
          const sec = section(page, op.section);
          const lf = op.field !== undefined ? listField(sec, op.field) : firstListField(sec);
          const el = lf?.elements.find((e) => e.id === op.element);
          if (el !== undefined && lf !== undefined) {
            const next = ctx.elementNext?.(lf.elementType, el.status ?? "", op.event);
            if (next !== undefined) el.status = next;
          }
        }
        break;
      }
    }
  }
  page.updatedAt = ctx.now;
}

function applySectionReduceMeta(sec: ISection, op: SectionOp, def: IPageTypeDef | undefined): void {
  const key = sec.key;
  const decl = def?.sections[key];
  if (decl?.reduceMeta !== undefined && op.op !== "setMeta") {
    sec.meta = routeMeta(sec.meta, op, decl.reduceMeta) as Record<string, unknown> | undefined;
  }
}

function applyElementReduceMeta(el: IItem, op: SectionOp, decl: ElementDecl | undefined): void {
  if (decl?.reduceMeta !== undefined && op.op !== "setMeta") {
    el.meta = routeMeta(el.meta, op, decl.reduceMeta) as Record<string, unknown> | undefined;
  }
}

/** Normalize a field value at ingestion (block normal form for `blocks`, hash for `code`). */
export function normalizeFieldValue(value: IField): IField {
  if (value.kind === "blocks") return { kind: "blocks", blocks: normalizeBlocks(value.blocks) };
  if (value.kind === "code") return { kind: "code", lang: value.lang, source: value.source, hash: contentHash(value.source) };
  return value;
}

function normalizeFields(fields: Record<string, IField>): Record<string, IField> {
  const out: Record<string, IField> = {};
  for (const [k, v] of Object.entries(fields)) out[k] = normalizeFieldValue(v);
  return out;
}

/** Materialize empty fields for a section from its declaration (§6). */
export function materializeSectionFields(sec: ISection, decl: SectionDecl): void {
  for (const [fieldKey, fd] of Object.entries(decl.fields)) {
    if (sec.fields[fieldKey] !== undefined) continue;
    sec.fields[fieldKey] = emptyFieldFor(fd);
  }
}

function emptyFieldFor(fd: { kind: string; element?: string }): IField {
  switch (fd.kind) {
    case "scalar":
      return { kind: "scalar", value: "" };
    case "prose":
      return { kind: "prose", value: "" };
    case "code":
      return { kind: "code", lang: "text", source: "", hash: contentHash("") };
    case "blocks":
      return { kind: "blocks", blocks: [] };
    case "list":
      return { kind: "list", elementType: fd.element ?? "", elements: [] };
    case "attachment-ref":
      // attachment-ref has no canonical "empty"; defer materialization until set.
      return { kind: "scalar", value: "" };
    case "serial":
      // Engine-assigned at create: a placeholder 0 that PageCreated.serials overwrites in
      // the same fold. Stored as a scalar number (like ref/attachment-ref start as scalars).
      return { kind: "scalar", value: 0 };
    default:
      return { kind: "scalar", value: "" };
  }
}

function setPath(obj: Record<string, unknown>, path: (string | number)[], value: unknown): Record<string, unknown> {
  if (path.length === 0) return obj;
  const root: Record<string, unknown> = { ...obj };
  let cur: Record<string, unknown> = root;
  for (let i = 0; i < path.length - 1; i++) {
    const key = String(path[i]);
    const next = cur[key];
    cur[key] = typeof next === "object" && next !== null ? { ...(next as Record<string, unknown>) } : {};
    cur = cur[key] as Record<string, unknown>;
  }
  cur[String(path[path.length - 1])] = value;
  return root;
}

export { SectionNotFoundError };
