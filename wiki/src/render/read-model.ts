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

/** Resolve a ref target to its render-derived label. Workspace-scoped: a
 * cross-page ref (`target.page` set) resolves against that page; same-page otherwise. */
function makeLabelResolver(state: IWorkspaceState, page: IPageNode, ctx: IRenderCtx): LabelResolver {
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
        if (el !== undefined && target.labelField !== undefined) {
          const lf = el.fields[target.labelField];
          if (lf !== undefined && (lf.kind === "prose" || lf.kind === "scalar")) return String(lf.value);
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
        matched.length === 0 ? placeholder() : asList(matched.map((el) => fillTemplate(g.item, el, label)));
      blocks.push(section(heading(2, g.heading ?? g.when), body));
    }
    return blocks.join("\n\n");
  }
  const template = sr.item ?? "{text}";
  // "" → the caller's placeholder fallback (model-declared `sr.placeholder` or default).
  if (f.elements.length === 0) return "";
  if (sr.as === "checklist") {
    // A box is checked when the element status === checkedWhen.
    return bulletList(
      f.elements.map((el) => `[${el.status === sr.checkedWhen ? "x" : " "}] ${fillTemplate(template, el, label)}`),
    );
  }
  return asList(f.elements.map((el) => fillTemplate(template, el, label)));
}

/**
 * Render a field's body, or "" when it is present but EMPTY — the caller falls back to
 * the model-declared `sr.placeholder` (or the engine default), so a declared placeholder
 * applies uniformly to missing AND empty fields.
 */
function renderFieldBody(
  f: IField,
  sr: SectionRender,
  label: LabelResolver,
): string {
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
      return f.blocks.length === 0 ? "" : renderBlocks(f.blocks, label);
    case "list":
      return renderListField(f, sr, label);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Page rendering
// ────────────────────────────────────────────────────────────────────────────

export function renderPage(state: IWorkspaceState, pageId: PageId, registry: Registry): string {
  const node = state.pages.get(pageId);
  if (node === undefined) {
    return joinBlocks([heading(1, "Unknown page"), placeholder("_Page not found._")]);
  }
  const ctx = buildRenderCtx(state, registry);
  const def = registry.page(node.type);
  const config: RenderConfig = def.render;
  const label = makeLabelResolver(state, node, ctx);
  const pageView = pageStateView(node) as DeepReadonly<PageState>;

  const blocks: string[] = [];
  blocks.push(heading(1, displayTitle(node, registry)));
  blocks.push(statusBadge(node.status));

  for (const sr of config.sections) {
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

  if (config.graphSections !== false) {
    blocks.push(section(heading(2, "References"), renderReferences(node.id, ctx)));
    blocks.push(section(heading(2, "Child pages"), renderChildList(node.id, ctx)));
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

// ────────────────────────────────────────────────────────────────────────────
// Workspace rendering
// ────────────────────────────────────────────────────────────────────────────

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
