/**
 * Markdown rendering entry points (DESIGN §11, §13.5; BUILD_NOTES §7).
 *
 * Three pure, deterministic functions over a folded `IWorkspaceState`:
 *
 *  - `buildRenderCtx(state, registry)` — assembles the read-only {@link IRenderCtx}
 *    a page renderer is handed: title/type/status lookups, ordered children, and
 *    forward/back links, all read straight out of the workspace projection (no I/O,
 *    no fetching — DESIGN §11 rule 5).
 *  - `renderPage(state, pageId, registry)` — dispatches to the page type's own
 *    `render(pageStateView(node), ctx)`; if the type has no usable renderer, falls
 *    back to a generic structured renderer (fields + item lists with status badges +
 *    an Open/Resolved question split).
 *  - `renderWorkspace(state, registry)` — renders the whole tree as nested headings
 *    in `children` order, top-level pages under `@root`.
 *
 * Determinism: every function is a total, pure transform of its arguments. Collections
 * render in insertion order (the order tracked in state); no wall clock, no randomness,
 * no object-key enumeration drives output. Formatting is canonicalized through the
 * helpers in `./determinism` — single blank line between blocks, one trailing newline.
 */
import type {
  IPageNode,
  IRenderCtx,
  IItemRecord,
  IWorkspaceState,
  PageId,
  PageState,
  RootId,
} from "../api";
import { ROOT } from "../api";
import type { Registry } from "../core/registry";
import { pageStateView } from "../core/workspace";
import { bulletList, heading, joinBlocks, placeholder, section, statusBadge } from "./determinism";

// ────────────────────────────────────────────────────────────────────────────
// Render context
// ────────────────────────────────────────────────────────────────────────────

/**
 * Build the read-only workspace context a page renderer reads from. Every lookup
 * is a pure read of the folded `state`; titles/types/statuses are denormalized into
 * the page nodes and links live on `state.links`, so nothing here fetches or mutates.
 */
export function buildRenderCtx(state: IWorkspaceState, _registry: Registry): IRenderCtx {
  const nodeOf = (id: PageId): IPageNode | undefined => state.pages.get(id);

  return {
    titleOf(id: PageId): string | undefined {
      return nodeOf(id)?.title;
    },
    typeOf(id: PageId): string | undefined {
      return nodeOf(id)?.type;
    },
    statusOf(id: PageId): string | undefined {
      return nodeOf(id)?.status;
    },
    childrenOf(id: PageId | RootId): readonly PageId[] {
      // Return a defensive copy so renderers can't mutate the projection's arrays.
      return [...(state.children.get(id) ?? [])];
    },
    linksOf(id: PageId): readonly { readonly to: PageId; readonly role: string }[] {
      // Insertion order preserved: filter the flat edge list in place.
      return state.links
        .filter((l) => l.from === id)
        .map((l) => ({ to: l.to, role: l.role }));
    },
    backlinksOf(id: PageId): readonly { readonly from: PageId; readonly role: string }[] {
      return state.links
        .filter((l) => l.to === id)
        .map((l) => ({ from: l.from, role: l.role }));
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Page rendering
// ────────────────────────────────────────────────────────────────────────────

/**
 * Render a single page to Markdown. Dispatches to the page type's `render`; if that
 * type has no usable renderer, uses the default structured renderer.
 *
 * @throws {@link UnknownPageTypeError} if `pageId` resolves to an unregistered type
 *   (via `registry.page`). A missing page id renders an explicit placeholder block.
 */
export function renderPage(state: IWorkspaceState, pageId: PageId, registry: Registry): string {
  const node = state.pages.get(pageId);
  if (node === undefined) {
    return joinBlocks([heading(1, "Unknown page"), placeholder("_Page not found._")]);
  }

  const ctx = buildRenderCtx(state, registry);
  const view = pageStateView(node);
  const def = registry.page(node.type);

  // Dispatch to the page type's own renderer when it provides a usable one;
  // otherwise fall back to the generic structured renderer.
  if (typeof def.render === "function") {
    return def.render(view, ctx);
  }
  return defaultRender(view, ctx);
}

/**
 * The default structured renderer (DESIGN §11): a deterministic walk of a page's
 * scalar `fields`, then its item lists (each with a status badge when the item type
 * carries one), with `question` items split into Open / Resolved sections, then a
 * References section from `ctx.linksOf` and a Child pages section from
 * `ctx.childrenOf`. Used for any page type that doesn't supply its own `render`.
 */
export function defaultRender(page: PageState, ctx: IRenderCtx): string {
  const blocks: string[] = [];

  // Title + status.
  blocks.push(heading(1, page.title));
  blocks.push(statusBadge(page.status));

  // Scalar fields, in declared (object insertion) order. Items live in `page.items`,
  // never in `fields`, so `fields` holds only scalars/arrays of scalars.
  const fields = page.fields;
  if (fields !== null && typeof fields === "object") {
    for (const [key, value] of Object.entries(fields as Record<string, unknown>)) {
      const rendered = renderScalarField(value);
      if (rendered === undefined) continue;
      blocks.push(section(heading(2, titleCase(key)), rendered));
    }
  }

  // Item lists. `question` gets the Open/Resolved split; every other item type renders
  // as a single section. Iterate item-type tags in their (insertion) order.
  for (const [itemType, records] of Object.entries(page.items)) {
    if (itemType === "question") {
      blocks.push(...renderQuestionSections(records));
      continue;
    }
    blocks.push(section(heading(2, titleCase(itemType) + "s"), renderItemList(records)));
  }

  // References (graph links from this page).
  blocks.push(section(heading(2, "References"), renderReferences(page.id, ctx)));

  // Child pages (tree children in `children` order).
  blocks.push(section(heading(2, "Child pages"), renderChildList(page.id, ctx)));

  return joinBlocks(blocks);
}

/** Open/Resolved question split (DESIGN §13.5). Both sections always render. */
function renderQuestionSections(records: readonly IItemRecord[]): string[] {
  const open = records.filter((q) => q.status !== "resolved");
  const resolved = records.filter((q) => q.status === "resolved");
  return [
    section(
      heading(2, "Open questions"),
      open.length === 0 ? placeholder() : bulletList(open.map((q) => `**${textOf(q)}**`)),
    ),
    section(
      heading(2, "Resolved questions"),
      resolved.length === 0
        ? placeholder()
        : bulletList(
            resolved.map((q) => {
              const answer = typeof q.answer === "string" ? q.answer : "";
              return `**${textOf(q)}** → ${answer}`;
            }),
          ),
    ),
  ];
}

/** A generic item list: one bullet per record, with a trailing status badge if present. */
function renderItemList(records: readonly IItemRecord[]): string {
  if (records.length === 0) return placeholder();
  return bulletList(
    records.map((rec) => {
      const label = textOf(rec);
      return typeof rec.status === "string" ? `${label} (${rec.status})` : label;
    }),
  );
}

/** References section body, from `ctx.linksOf`, rendered `role → Target title`. */
function renderReferences(id: PageId, ctx: IRenderCtx): string {
  const links = ctx.linksOf(id);
  if (links.length === 0) return placeholder();
  return bulletList(links.map((l) => `${l.role} → ${ctx.titleOf(l.to) ?? l.to}`));
}

/** Child pages section body, in `children` order, by title. */
function renderChildList(id: PageId, ctx: IRenderCtx): string {
  const children = ctx.childrenOf(id);
  if (children.length === 0) return placeholder();
  return bulletList(children.map((childId) => ctx.titleOf(childId) ?? childId));
}

// ────────────────────────────────────────────────────────────────────────────
// Workspace rendering
// ────────────────────────────────────────────────────────────────────────────

/**
 * Render the whole workspace tree as nested Markdown headings in `children` order,
 * top-level pages under `@root`. The workspace name is the H1; each page is a heading
 * one level deeper than its parent (clamped at 6), annotated with `(type, status)`.
 */
export function renderWorkspace(state: IWorkspaceState, registry: Registry): string {
  const ctx = buildRenderCtx(state, registry);
  const blocks: string[] = [heading(1, state.name)];

  const visit = (id: PageId, level: number): void => {
    const type = ctx.typeOf(id);
    const status = ctx.statusOf(id);
    const annotation = type !== undefined ? ` (${type}, ${status ?? ""})` : "";
    blocks.push(heading(level, (ctx.titleOf(id) ?? id) + annotation));
    for (const childId of ctx.childrenOf(id)) {
      visit(childId, level + 1);
    }
  };

  const roots = ctx.childrenOf(ROOT);
  if (roots.length === 0) {
    blocks.push(placeholder("_No pages yet._"));
  } else {
    for (const rootId of roots) visit(rootId, 2);
  }

  return joinBlocks(blocks);
}

// ────────────────────────────────────────────────────────────────────────────
// Small pure helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Render a single scalar `fields` value to a block, or `undefined` to skip the
 * section entirely (absent/empty optional fields don't emit an empty heading).
 * Strings render verbatim; arrays of scalars render as a bullet list; numbers/booleans
 * stringify. Objects/arrays-of-objects are not expected in `fields` (items live in
 * `page.items`) and are skipped.
 */
function renderScalarField(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value.length === 0 ? undefined : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const scalars = value.filter(
      (v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean",
    );
    if (scalars.length === 0) return undefined;
    return bulletList(scalars.map((v) => String(v)));
  }
  return undefined;
}

/** Best-effort display label for an item record: its `text`, else `name`, else id. */
function textOf(rec: IItemRecord): string {
  if (typeof rec.text === "string") return rec.text;
  if (typeof rec.name === "string") return rec.name;
  return rec.id;
}

/** "implementation-plan" / "open_question" → "Implementation plan" / "Open question". */
function titleCase(key: string): string {
  const spaced = key.replace(/[-_]+/g, " ").trim();
  if (spaced.length === 0) return spaced;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
