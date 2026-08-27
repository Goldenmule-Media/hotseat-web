/**
 * The configurable Markdown render READ MODEL. Walks a
 * page's section tree in render-config order and dispatches on each target field's
 * field-kind to a per-kind default renderer. Pure over folded state + static config,
 * so equal state renders byte-identically. The per-type `render` is retired.
 */
import type {
  DeepReadonly,
  DerivedItem,
  IField,
  IItem,
  IPageNode,
  IRenderCtx,
  ISection,
  IWorkspaceState,
  PageId,
  PageState,
  RefTarget,
  RenderConfig,
  SectionRender,
  RootId,
} from "../api";
import { ROOT } from "../api";
import { ItemNotFoundError, PageNotFoundError, SectionNotFoundError } from "../core/errors";
import { pageStateView } from "../core/workspace";
import type { Registry } from "../core/registry";
import { renderBlocks, type LabelResolver } from "./blocks";
import { bulletList, heading, joinBlocks, numbered, placeholder, section, statusBadge } from "./determinism";

// ────────────────────────────────────────────────────────────────────────────
// Render context (cross-page label resolution)
// ────────────────────────────────────────────────────────────────────────────

export function buildRenderCtx(state: IWorkspaceState, _registry: Registry): IRenderCtx {
  const nodeOf = (id: PageId): IPageNode | undefined => state.pages.get(id);
  return {
    titleOf: (id) => nodeOf(id)?.title,
    typeOf: (id) => nodeOf(id)?.type,
    statusOf: (id) => nodeOf(id)?.status,
    archivedOf: (id) => nodeOf(id)?.archived === true,
    childrenOf: (id) => [...(state.children.get(id) ?? [])],
    linksOf: (id) => state.links.filter((l) => l.from === id).map((l) => ({ to: l.to, role: l.role })),
    backlinksOf: (id) => state.links.filter((l) => l.to === id).map((l) => ({ from: l.from, role: l.role })),
    pageState: (id) => {
      const n = nodeOf(id);
      return n !== undefined ? (pageStateView(n) as DeepReadonly<PageState>) : undefined;
    },
  };
}

/** Key into the per-render ordinal index: section id + list field + element id. */
function ordinalKey(section: string, field: string, element: string): string {
  return JSON.stringify([section, field, element]);
}

/**
 * Precompute, once per page render, the 1-based ordinal of every element in a `numbered` or
 * `as: "sections"` list — replaying the SAME per-group status filter and stored order that
 * {@link renderListField} renders with, so an `$ordinal` element-ref resolves to exactly the
 * number the reader sees. Pure over folded state; an element filtered out of every rendered
 * group simply has no entry (its refs then fall back to a stable label). The two reads of the
 * filter/order rule must stay in lockstep with {@link renderListField}.
 */
function buildOrdinalIndex(node: IPageNode, config: RenderConfig): Map<string, number> {
  const index = new Map<string, number>();
  for (const sr of config.sections) {
    const sectionKey = sr.section;
    const field = sr.field;
    if (sectionKey === undefined || field === undefined) continue;
    if (sr.as !== "numbered" && sr.as !== "sections") continue;
    const sec = node.sections.find((s) => s.key === sectionKey);
    const f = sec === undefined ? undefined : sec.fields[field];
    if (sec === undefined || f === undefined || f.kind !== "list") continue;
    if (sr.groupBy !== undefined && sr.groups !== undefined) {
      for (const g of sr.groups) {
        f.elements
          .filter((el) => (el.status ?? "") === g.when)
          .forEach((el, i) => index.set(ordinalKey(sec.id, field, el.id), i + 1));
      }
    } else {
      f.elements.forEach((el, i) => index.set(ordinalKey(sec.id, field, el.id), i + 1));
    }
  }
  return index;
}

/** Resolve a ref target to its render-derived label. Workspace-scoped: a
 * cross-page ref (`target.page` set) resolves against that page; same-page otherwise. */
function makeLabelResolver(
  state: IWorkspaceState,
  page: IPageNode,
  ctx: IRenderCtx,
  ordinals: ReadonlyMap<string, number>,
): LabelResolver {
  const ownerOf = (p: PageId | undefined): IPageNode | undefined =>
    p === undefined ? page : state.pages.get(p);
  return (target: RefTarget): string => {
    switch (target.kind) {
      case "page":
        return ctx.titleOf(target.id) ?? String(target.id);
      case "section": {
        const sec = ownerOf(target.page)?.sections.find((s) => s.id === target.id);
        return sec?.name ?? String(target.id);
      }
      case "symbol":
        return target.name;
      case "block":
        return String(target.block);
      case "element": {
        // The label is the named `labelField` of the target element (explicit, so it
        // is a pure projection and never depends on object-key order). Falls back to
        // the element id when the field is absent or non-textual.
        const f = ownerOf(target.page)?.sections.find((s) => s.id === target.section)?.fields[target.field];
        const el = f !== undefined && f.kind === "list" ? f.elements.find((e) => e.id === target.element) : undefined;
        const lf = target.labelField;
        // `$ordinal` (optionally `$ordinal:<fallbackField>`): render the element's CURRENT
        // render-time ordinal — same-page only, since a page's ordinals depend on its own
        // render config — falling back to the named field then the element id when it has
        // none (target filtered out of every rendered group, or a cross-page ref).
        if (lf !== undefined && (lf === "$ordinal" || lf.startsWith("$ordinal:"))) {
          if (target.page === undefined) {
            const ord = ordinals.get(ordinalKey(target.section, target.field, target.element));
            if (ord !== undefined) return String(ord);
          }
          const fb = lf.startsWith("$ordinal:") ? lf.slice("$ordinal:".length) : undefined;
          if (el !== undefined && fb !== undefined) {
            const fv = el.fields[fb];
            if (fv !== undefined && (fv.kind === "prose" || fv.kind === "scalar")) return String(fv.value);
          }
          return String(target.element);
        }
        if (el !== undefined && lf !== undefined) {
          const fv = el.fields[lf];
          if (fv !== undefined && (fv.kind === "prose" || fv.kind === "scalar")) return String(fv.value);
        }
        return String(target.element);
      }
    }
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Field-kind rendering
// ────────────────────────────────────────────────────────────────────────────

function scalarToString(f: IField): string {
  if (f.kind === "scalar") return String(f.value);
  if (f.kind === "prose") return f.value;
  return "";
}

/** Substitute `{field}` / `{field?}` against an element's fields. */
function fillTemplate(template: string, el: IItem, label: LabelResolver): string {
  return template.replace(/\{(\w+)(\?)?\}/g, (_m, key: string, optional: string) => {
    const f = el.fields[key];
    if (f === undefined) return optional === "?" ? "" : "";
    return fieldInlineValue(f, label);
  });
}

function fieldInlineValue(f: IField, label: LabelResolver): string {
  switch (f.kind) {
    case "scalar":
      return String(f.value);
    case "prose":
      return f.value;
    case "code":
      return f.source;
    case "attachment-ref":
      return f.name;
    case "ref":
      return label(f.target);
    case "blocks":
      return renderBlocks(f.blocks, label);
    case "list":
      return "";
  }
}

/**
 * A page's DISPLAY title: its `render.title` template filled with `{title}` and
 * `{section.field}` tokens (e.g. `"ADR-{meta.number}: {title}"` → `"ADR-7: …"`). Falls back to
 * the raw `title` when the type is unregistered or declares no template. Pure over folded
 * state; used for the rendered H1 and surfaced on `ITreeNode.displayTitle` for sidebars.
 */
export function displayTitle(node: IPageNode, registry: Registry): string {
  if (!registry.has(node.type)) return node.title;
  const template = registry.page(node.type).render.title;
  if (template === undefined) return node.title;
  return fillTitleTemplate(template, node);
}

/** Resolve `{title}` and `{section.field}` tokens in a title template against a page node. */
function fillTitleTemplate(template: string, node: IPageNode): string {
  return template.replace(/\{([\w.]+)\}/g, (_m, token: string) => {
    if (token === "title") return node.title;
    const dot = token.indexOf(".");
    if (dot <= 0) return "";
    const f = node.sections.find((s) => s.key === token.slice(0, dot))?.fields[token.slice(dot + 1)];
    if (f === undefined) return "";
    if (f.kind === "scalar") return String(f.value);
    if (f.kind === "prose") return f.value;
    return "";
  });
}

function renderListField(
  f: { kind: "list"; elementType: string; elements: IItem[] },
  sr: SectionRender,
  label: LabelResolver,
): string {
  // `as: "numbered"` → ordered list (`1.`), so items stay referenceable; bullets otherwise.
  // Applies to grouped and flat lists alike (the checklist path below stays unordered).
  const asList = (rows: string[]): string => (sr.as === "numbered" ? numbered(rows) : bulletList(rows));
  if (sr.groupBy !== undefined && sr.groups !== undefined) {
    const blocks: string[] = [];
    for (const g of sr.groups) {
      const matched = f.elements.filter((el) => (el.status ?? "") === g.when);
      const body =
        matched.length === 0
          ? placeholder()
          : sr.as === "sections"
            ? matched.map((el, i) => renderElementSection(el, i + 1, sr, label)).join("\n\n")
            : sr.as === "stack"
              ? matched.map((el) => renderElementStack(el, sr, label)).filter((b) => b.length > 0).join("\n\n")
              : asList(matched.map((el) => fillTemplate(g.item ?? "", el, label)));
      blocks.push(section(heading(2, g.heading ?? g.when), body));
    }
    return blocks.join("\n\n");
  }
  if (f.elements.length === 0) return sr.placeholder ?? placeholder();
  if (sr.as === "sections") {
    return f.elements.map((el, i) => renderElementSection(el, i + 1, sr, label)).join("\n\n");
  }
  if (sr.as === "stack") {
    // An element whose body parts are all empty contributes nothing rather than a
    // blank run — joinBlocks would collapse it anyway, and the placeholder above
    // already covers the "no elements at all" case.
    const bodies = f.elements.map((el) => renderElementStack(el, sr, label)).filter((b) => b.length > 0);
    return bodies.length === 0 ? (sr.placeholder ?? placeholder()) : bodies.join("\n\n");
  }
  const template = sr.item ?? "{text}";
  if (sr.as === "checklist") {
    // A box is checked when the element status === checkedWhen.
    return bulletList(
      f.elements.map((el) => `[${el.status === sr.checkedWhen ? "x" : " "}] ${fillTemplate(template, el, label)}`),
    );
  }
  return asList(f.elements.map((el) => fillTemplate(template, el, label)));
}

/**
 * Render one list element as a STACK entry (`as: "stack"`): its declared body parts and
 * nothing else — no heading, no ordinal. The companion of {@link renderElementSection}
 * for lists whose items are rich text rather than titled subsections.
 */
function renderElementStack(el: IItem, sr: SectionRender, label: LabelResolver): string {
  const parts: string[] = [];
  for (const part of sr.element?.body ?? []) {
    const rendered = renderElementBodyPart(el, part, label);
    if (rendered.length > 0) parts.push(rendered);
  }
  return parts.join("\n\n");
}

/**
 * Render one list element as a subsection (the `as: "sections"` mode): a heading template
 * filled from the element's fields, then each non-empty declared body part. The ordinal is
 * supplied by the caller from the element's position in its rendered group, so it matches
 * what an `$ordinal` element-ref resolves to; `numbered: false` omits it from the heading
 * (the index — and `$ordinal` resolution — is unaffected). The level is H3 unless
 * `depthField` names an element field carrying a nesting depth (see {@link elementDepth}).
 */
function renderElementSection(el: IItem, ordinal: number, sr: SectionRender, label: LabelResolver): string {
  const spec = sr.element;
  const headingText = spec?.heading !== undefined ? fillTemplate(spec.heading, el, label) : "";
  const parts: string[] = [];
  for (const part of spec?.body ?? []) {
    const rendered = renderElementBodyPart(el, part, label);
    if (rendered.length > 0) parts.push(rendered);
  }
  const level = Math.min(6, 3 + elementDepth(el, sr.depthField)) as 1 | 2 | 3 | 4 | 5 | 6;
  return section(heading(level, sr.numbered === false ? headingText : `${ordinal}. ${headingText}`), parts.join("\n\n"));
}

/** A `depthField` element's 0-based nesting depth. Anything not a non-negative integer —
 *  absent field, wrong kind, a string that doesn't parse — reads as 0, so a malformed
 *  value degrades to a flat render instead of failing it. */
function elementDepth(el: IItem, depthField: string | undefined): number {
  if (depthField === undefined) return 0;
  const f = el.fields[depthField];
  if (f === undefined || f.kind !== "scalar") return 0;
  const n = typeof f.value === "number" ? f.value : Number(f.value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** One body part of an `as: "sections"` element: its field body, optionally prefixed
 *  `**label:** `. An absent or empty field yields "" so the part is skipped. */
function renderElementBodyPart(
  el: IItem,
  part: { readonly label?: string; readonly field: string },
  label: LabelResolver,
): string {
  const f = el.fields[part.field];
  if (f === undefined) return "";
  const body = elementFieldBody(f, label);
  if (body.length === 0) return "";
  if (part.label === undefined) return body;
  // An inline-ish body (a scalar, a prose run) reads best with the label as a prefix. A
  // BLOCK body is a document — a list, a fence, several paragraphs — and prefixing it
  // swallows its first line into the label (`**Prep:** - first bullet`), breaking the
  // construct. Those take the label as its own line.
  const inline = f.kind === "scalar" || f.kind === "prose";
  return inline ? `**${part.label}:** ${body}` : `**${part.label}:**\n\n${body}`;
}

/** Block-level rendering of one element field (fenced code, full blocks tree). */
function elementFieldBody(f: IField, label: LabelResolver): string {
  switch (f.kind) {
    case "scalar":
      return String(f.value);
    case "prose":
      return f.value;
    case "code":
      return "```" + f.lang + "\n" + f.source + "\n```";
    case "attachment-ref":
      return `[${f.name}](${f.ref})`;
    case "ref":
      return label(f.target);
    case "blocks":
      return renderBlocks(f.blocks, label);
    case "list":
      return "";
  }
}

/**
 * Render a field's body. A present-but-EMPTY field falls back to the model-declared
 * `sr.placeholder` (or the engine default) — the same contract the caller applies to a
 * MISSING field — so a declared placeholder applies uniformly. (Grouped lists render a
 * per-group engine-default placeholder instead; see {@link renderListField}.)
 */
function renderFieldBody(
  f: IField,
  sr: SectionRender,
  label: LabelResolver,
): string {
  const empty = (): string => sr.placeholder ?? placeholder();
  switch (f.kind) {
    case "scalar":
      return String(f.value).length === 0 ? empty() : String(f.value);
    case "prose":
      return f.value.length === 0 ? empty() : f.value;
    case "code":
      return "```" + f.lang + "\n" + f.source + "\n```";
    case "attachment-ref":
      return `[${f.name}](${f.ref})`;
    case "ref":
      return label(f.target);
    case "blocks":
      return f.blocks.length === 0 ? empty() : renderBlocks(f.blocks, label);
    case "list":
      return renderListField(f, sr, label);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Page rendering
// ────────────────────────────────────────────────────────────────────────────

export function renderPage(
  state: IWorkspaceState,
  pageId: PageId,
  registry: Registry,
  depth = 0,
  inlined = false,
): string {
  const node = state.pages.get(pageId);
  if (node === undefined) {
    return joinBlocks([heading(1, "Unknown page"), placeholder("_Page not found._")]);
  }
  const ctx = buildRenderCtx(state, registry);
  const def = registry.page(node.type);
  const config: RenderConfig = def.render;
  // Built before label resolution so an `$ordinal` ref (even a forward one) sees every
  // element's render-time number.
  const ordinals = buildOrdinalIndex(node, config);
  const label = makeLabelResolver(state, node, ctx, ordinals);
  const pageView = pageStateView(node) as DeepReadonly<PageState>;

  const blocks: string[] = [];
  blocks.push(heading(1, displayTitle(node, registry)));
  // An INLINED child is content inside someone else's page: its status badge and its empty
  // graph sections are chrome that repeats once per entry, and a feed of hundreds drowns in
  // it. The page still shows both when opened on its own.
  if (!inlined) blocks.push(statusBadge(node.status));
  const contentStart = blocks.length;

  for (const sr of config.sections) {
    // A stored display mode can select between two configs naming the same content.
    if (sr.when !== undefined && !whenMatches(node, sr.when)) continue;
    // Child pages inlined in full, newest first — a feed rather than an index.
    if (sr.section === "@children-content") {
      blocks.push(
        section(heading(2, sr.heading ?? "Contents"), renderChildContent(node.id, state, registry, ctx, sr.placeholder, depth)),
      );
      continue;
    }
    // A DERIVED checklist: a model projection of folded state (e.g. the plan's steps +
    // local progress), not a page field. Rendered byte-stably.
    if (sr.derived !== undefined) {
      const items = def.derived?.[sr.derived]?.(pageView, ctx) ?? [];
      const body = items.length === 0 ? (sr.placeholder ?? placeholder()) : renderDerivedList(items);
      blocks.push(section(heading(2, sr.heading ?? sr.derived), body));
      continue;
    }
    // Engine-derived sections (links / tree), positionable in render order.
    if (sr.section === "@references") {
      blocks.push(section(heading(2, sr.heading ?? "References"), renderReferences(node.id, ctx)));
      continue;
    }
    if (sr.section === "@children") {
      blocks.push(section(heading(2, sr.heading ?? "Child pages"), renderChildList(node.id, ctx)));
      continue;
    }
    const sec: ISection | undefined = node.sections.find((s) => s.key === sr.section);
    const headingText = sr.heading ?? sec?.name ?? sr.section ?? "";

    // grouped list → emit each group as its own H2 section (no parent heading).
    if (sr.groupBy !== undefined && sr.groups !== undefined && sec !== undefined && sr.field !== undefined) {
      const f = sec.fields[sr.field];
      if (f !== undefined && f.kind === "list") {
        blocks.push(renderListField(f, sr, label));
        continue;
      }
    }

    let body: string;
    if (sec === undefined) {
      body = sr.placeholder ?? placeholder();
    } else {
      const fieldKey = sr.field ?? Object.keys(sec.fields)[0];
      const f = fieldKey !== undefined ? sec.fields[fieldKey] : undefined;
      body = f === undefined ? (sr.placeholder ?? placeholder()) : renderFieldBody(f, sr, label);
      if (body.length === 0) body = sr.placeholder ?? placeholder();
    }
    blocks.push(section(heading(2, headingText), body));
  }

  if (config.graphSections !== false && !inlined) {
    blocks.push(section(heading(2, "References"), renderReferences(node.id, ctx)));
    blocks.push(section(heading(2, "Child pages"), renderChildList(node.id, ctx)));
  }

  if (inlined) {
    const kept = blocks.slice(contentStart).filter((b) => !isPlaceholderSection(b));
    blocks.length = contentStart;
    blocks.push(...(kept.length === 1 ? [stripSectionHeading(kept[0]!)] : kept));
  }

  return joinBlocks(blocks);
}

function renderReferences(id: PageId, ctx: IRenderCtx): string {
  const links = ctx.linksOf(id);
  if (links.length === 0) return placeholder();
  // The link target is a page → render it as a Markdown link (href = its stable page id;
  // label render-derived). Consistent with how page references render everywhere else.
  return bulletList(links.map((l) => `${l.role} → [${ctx.titleOf(l.to) ?? l.to}](${l.to})`));
}

function renderChildList(id: PageId, ctx: IRenderCtx): string {
  const children = ctx.childrenOf(id);
  if (children.length === 0) return placeholder();
  // Each child is a page → render its title as a Markdown link (href = its stable page id).
  return bulletList(children.map((childId) => `[${ctx.titleOf(childId) ?? childId}](${childId})`));
}

/**
 * Render a model-declared {@link DerivedList} as a (possibly nested) bullet list. A row
 * carrying a boolean `checked` renders a checkbox (a derived CHECKLIST, e.g. the plan's
 * steps); a row without one renders a plain bullet (a table-of-contents entry / group row).
 * `level` indents nested rows two spaces per level. Pure + deterministic — the order and
 * shape are exactly the projection's, so equal state renders byte-identically.
 */
function renderDerivedList(items: readonly DerivedItem[]): string {
  return items
    .map((it) => {
      const indent = "  ".repeat(Math.max(0, Math.trunc(it.level ?? 0)));
      const box = it.checked === undefined ? "" : `[${it.checked ? "x" : " "}] `;
      // Right-trim so an empty-text row collapses to "-" (or "- [ ]") rather than leaving
      // trailing whitespace — the canonical Markdown contract forbids trailing whitespace,
      // and joinBlocks only trims the whole block's tail, never interior lines.
      return `${indent}- ${box}${it.text}`.replace(/\s+$/, "");
    })
    .join("\n");
}

/**
 * Render ONE list element exactly as {@link renderPage} presents it inside its section:
 * for an `as: "sections"` config the `### {ordinal}. {heading}` subsection (heading only
 * under `numbered: false`; deeper under `depthField`) plus the
 * declared body parts (ordinal from the same per-group index the full render uses); for
 * an `as: "stack"` config its body parts alone, with no heading; for
 * bullets/numbered/checklist the single rendered item line. An element filtered out of
 * every rendered group still renders — via the group whose `when` matches its status,
 * else the base config — with its stored-order position as the ordinal fallback. Throws
 * {@link SectionNotFoundError} / {@link ItemNotFoundError} for a missing target.
 */
export function renderPageElement(
  state: IWorkspaceState,
  pageId: PageId,
  sectionKey: string,
  elementId: string,
  registry: Registry,
): string {
  const node = state.pages.get(pageId);
  if (node === undefined) throw new PageNotFoundError(pageId);
  const sec = node.sections.find((s) => s.key === sectionKey);
  if (sec === undefined) throw new SectionNotFoundError(sectionKey);
  let fieldKey: string | undefined;
  let list: { kind: "list"; elementType: string; elements: IItem[] } | undefined;
  for (const [k, f] of Object.entries(sec.fields)) {
    if (f.kind === "list" && f.elements.some((e) => e.id === elementId)) {
      fieldKey = k;
      list = f;
      break;
    }
  }
  if (fieldKey === undefined || list === undefined) throw new ItemNotFoundError("element", elementId);
  const el = list.elements.find((e) => e.id === elementId)!;

  const config = registry.page(node.type).render;
  const ctx = buildRenderCtx(state, registry);
  const ordinals = buildOrdinalIndex(node, config);
  const label = makeLabelResolver(state, node, ctx, ordinals);

  const sr: SectionRender =
    config.sections.find((r) => r.section === sectionKey && (r.field === undefined || r.field === fieldKey)) ?? {
      section: sectionKey,
      field: fieldKey,
    };
  const ordinal =
    ordinals.get(ordinalKey(sec.id, fieldKey, elementId)) ?? list.elements.findIndex((e) => e.id === elementId) + 1;

  if (sr.as === "sections") return renderElementSection(el, ordinal, sr, label);
  if (sr.as === "stack") return renderElementStack(el, sr, label);
  const group =
    sr.groupBy !== undefined && sr.groups !== undefined
      ? sr.groups.find((g) => g.when === (el.status ?? ""))
      : undefined;
  const template = group !== undefined ? (group.item ?? "") : (sr.item ?? "{text}");
  const filled = fillTemplate(template, el, label);
  if (sr.as === "checklist") return `- [${el.status === sr.checkedWhen ? "x" : " "}] ${filled}`;
  if (sr.as === "numbered") return `${ordinal}. ${filled}`;
  return `- ${filled}`;
}

// ────────────────────────────────────────────────────────────────────────────
// Workspace rendering
// ────────────────────────────────────────────────────────────────────────────

/**
 * Split a rendered section into its heading line and its body. `section()` joins the two
 * with a SINGLE newline (the canonical contract puts no blank line between a heading and
 * its body), so the split is the first newline — a body may itself contain blank lines.
 */
function splitSection(block: string): { heading: string; body: string } | null {
  if (!block.startsWith("#")) return null;
  const nl = block.indexOf("\n");
  return nl < 0 ? { heading: block, body: "" } : { heading: block.slice(0, nl), body: block.slice(nl + 1) };
}

/** A rendered section whose body is only its placeholder — nothing to show. */
function isPlaceholderSection(block: string): boolean {
  const parts = splitSection(block);
  if (parts === null) return false;
  const body = parts.body.trim();
  return !body.includes("\n") && /^_.*_$/.test(body);
}

/** Drop a rendered section's own heading, keeping its body. */
function stripSectionHeading(block: string): string {
  return splitSection(block)?.body ?? block;
}

/** How deep `@children-content` will inline before falling back to a link list. */
const MAX_INLINE_DEPTH = 2;

/** Does the page scalar named by `"<section>.<field>"` select this render config? */
function whenMatches(node: IPageNode, when: { field: string; equals: string; orUnset?: boolean }): boolean {
  const dot = when.field.indexOf(".");
  if (dot < 0) return false;
  const f = node.sections.find((x) => x.key === when.field.slice(0, dot))?.fields[when.field.slice(dot + 1)];
  const value = f !== undefined && f.kind === "scalar" ? String(f.value) : "";
  return value === when.equals || (when.orUnset === true && value.length === 0);
}

/**
 * Demote every ATX heading by `by` levels, clamped at H6 — so an inlined child's `# Title`
 * sits below the section heading that contains it. Fence-aware: a `#` inside a code block
 * is content, not a heading, and must survive untouched.
 */
function demoteHeadings(markdown: string, by: number): string {
  let fence: string | null = null;
  return markdown
    .split("\n")
    .map((line) => {
      const open = /^\s*(`{3,}|~{3,})/.exec(line);
      if (open !== null) {
        if (fence === null) fence = open[1][0];
        else if (line.trimStart().startsWith(fence.repeat(3))) fence = null;
        return line;
      }
      if (fence !== null) return line;
      const h = /^(#{1,6})(\s)/.exec(line);
      return h === null ? line : "#".repeat(Math.min(6, h[1].length + by)) + h[2] + line.slice(h[0].length);
    })
    .join("\n");
}

/**
 * Every non-archived child rendered IN FULL, newest first by `createdAt`. Ties break on
 * page id so equal timestamps — a bulk import stamps many — still order deterministically.
 * Past {@link MAX_INLINE_DEPTH} it degrades to the link list rather than recursing, so a
 * feed of feeds terminates.
 */
function renderChildContent(
  id: PageId,
  state: IWorkspaceState,
  registry: Registry,
  ctx: IRenderCtx,
  ph: string | undefined,
  depth: number,
): string {
  const children = ctx.childrenOf(id).filter((c) => !ctx.archivedOf(c));
  if (children.length === 0) return ph ?? placeholder();
  if (depth >= MAX_INLINE_DEPTH) return renderChildList(id, ctx);
  const ordered = [...children].sort((a, b) => {
    const at = state.pages.get(a)?.createdAt ?? "";
    const bt = state.pages.get(b)?.createdAt ?? "";
    return at === bt ? String(a).localeCompare(String(b)) : bt.localeCompare(at);
  });
  return joinBlocks(ordered.map((c) => demoteHeadings(renderPage(state, c, registry, depth + 1, true), 2)));
}

export function renderWorkspace(state: IWorkspaceState, registry: Registry): string {
  const ctx = buildRenderCtx(state, registry);
  const blocks: string[] = [heading(1, state.name)];

  const visit = (id: PageId, level: number): void => {
    const type = ctx.typeOf(id);
    const status = ctx.statusOf(id);
    const archived = ctx.archivedOf(id) ? ", archived" : "";
    const annotation = type !== undefined ? ` (${type}, ${status ?? ""}${archived})` : "";
    blocks.push(heading(level, (ctx.titleOf(id) ?? id) + annotation));
    for (const childId of ctx.childrenOf(id)) visit(childId, level + 1);
  };

  const roots: readonly (PageId | RootId)[] = ctx.childrenOf(ROOT);
  if (roots.length === 0) {
    blocks.push(placeholder("_No pages yet._"));
  } else {
    for (const rootId of roots) visit(rootId as PageId, 2);
  }
  return joinBlocks(blocks);
}
