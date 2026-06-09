/**
 * `architecture` page type — one node in a typed graph that describes the codebase.
 *
 * A node documents ONE unit (module / component / subsystem / …, set by `kind`). It carries
 * the sections an architecture doc needs — summary, purpose, the contained sub-nodes
 * (Components — links to its page-tree children), usage, data model, code references,
 * dependencies, invariants — and is kept current by an AGENT issuing guarded
 * mutations (the engine can't watch the filesystem; freshness is an agent-recorded fact, not
 * an engine-faked flag). Two kinds of links, matching "describe and link to code OR modules":
 *  - CODE references — `codeRef {file, symbol?, kind?}` elements: file + function/class names,
 *    NO line numbers (they drift; file+symbol is stable and re-findable). Un-checked, because
 *    the engine is deterministic + self-contained and can't validate the filesystem (the
 *    agreed v1; a host symbol-index would make these integrity-checked later).
 *  - MODULE dependencies — `dependency {target: ref→architecture page, role, note?}` elements.
 *    `addDependency` enforces (in `produces`) that the target is an existing, OTHER `architecture`
 *    page; the `ref` is integrity-checked at WRITE time. A target archived later is NOT re-checked,
 *    so it keeps rendering with an "(archived)" marker. Labels are render-derived, so renames reflow.
 *
 * Lifecycle is lightweight, no draft (docs follow code): born `current`, an agent flips
 * `current ⇄ stale` and records the `syncedCommit` it last verified against. Nodes live as
 * children of a `toc` "Architecture Overview" page, which renders the grouped index.
 */
import type {
  BlockId,
  DeepReadonly,
  DerivedList,
  IBlock,
  IField,
  IItem,
  IRenderCtx,
  PageId,
  PageState,
  SectionOp,
} from "wiki/authoring";
import { arg, definePageType, t } from "wiki/authoring";
import { z, zodSchema } from "wiki/authoring";

const empty = z.object({});

const KINDS = ["module", "component", "subsystem", "service", "layer", "package"] as const;
const CODEREF_KINDS = ["file", "function", "class", "type", "interface", "constant"] as const;
const ROLES = ["depends-on", "exposes", "implements", "owns", "calls"] as const;

/** A section's list elements (or [] when absent / not a list). */
function listItems(page: DeepReadonly<PageState>, sectionKey: string, fieldKey: string): readonly DeepReadonly<IItem>[] {
  const f = page.sections.find((s) => s.key === sectionKey)?.fields[fieldKey];
  return f !== undefined && f.kind === "list" ? f.elements : [];
}

/** A scalar/prose field's string value, or "". */
function fieldStr(el: DeepReadonly<IItem>, key: string): string {
  const f = el.fields[key];
  return f !== undefined && (f.kind === "scalar" || f.kind === "prose") ? String(f.value) : "";
}

/** The page id a `ref`-to-page field points at, or undefined. */
function refPageId(el: DeepReadonly<IItem>, key: string): PageId | undefined {
  const f = el.fields[key];
  return f !== undefined && f.kind === "ref" && f.target.kind === "page" ? (f.target.id as PageId) : undefined;
}

/**
 * Render rows for the Code references section — a pure formatter over this page's own stored
 * `codeRef`s, so optional symbol/kind format cleanly (a static item template can't do the
 * conditional separators without leaving stray punctuation/whitespace). Deterministic.
 */
const codeReferenceRows: DerivedList = (page) =>
  listItems(page, "codeReferences", "items").map((el) => {
    const file = fieldStr(el, "file");
    const symbol = fieldStr(el, "symbol");
    const kind = fieldStr(el, "kind");
    const sym = symbol.length > 0 ? (kind.length > 0 ? `${kind} \`${symbol}\` in ` : `\`${symbol}\` in `) : "";
    return { id: el.id, text: `${sym}\`${file}\`` };
  });

/** Render rows for the Dependencies section — role + render-derived target title + optional note. */
const dependencyRows: DerivedList = (page, ctx: IRenderCtx) =>
  listItems(page, "dependencies", "items").map((el) => {
    const targetId = refPageId(el, "target");
    // Link the target page (href = its stable page id; label is render-derived, so renames
    // reflow), matching how Components and the toc render page references.
    const label =
      targetId !== undefined ? `[${ctx.titleOf(targetId) ?? String(targetId)}](${String(targetId)})` : "(unknown)";
    // Ref integrity is write-time only; a target archived afterward still resolves, so flag it.
    const archived = targetId !== undefined && ctx.archivedOf(targetId) ? " (archived)" : "";
    const role = fieldStr(el, "role");
    const note = fieldStr(el, "note");
    return { id: el.id, text: `**${role}** → ${label}${archived}${note.length > 0 ? ` — ${note}` : ""}` };
  });

/** The node's contained sub-nodes (its page-tree children), each rendered as a Markdown link
 *  to the child page. The href is the stable page id — the address an agent feeds back into
 *  getPage/renderPage (the host `wiki://{ns}/page/…` URI isn't available at render time, since
 *  the engine is namespace/workspace-agnostic). The label is render-derived, so renames reflow.
 *  Surfaces the package→component hierarchy on the node page, the way a toc lists its children.
 *  Archived children are dropped — a node hidden from default views must not linger here. */
const componentRows: DerivedList = (page, ctx: IRenderCtx) => {
  const self = page.id as unknown as PageId;
  return ctx
    .childrenOf(self)
    .filter((id) => !ctx.archivedOf(id))
    .map((id) => ({ id: String(id), text: `[${ctx.titleOf(id) ?? String(id)}](${id})` }));
};

/** A prose paragraph block carrying `text` (id minted from the injected `newId`). Mirrors adr.ts. */
function paragraph(text: string, newId: () => string): IBlock {
  return { kind: "paragraph", id: newId() as BlockId, inlines: [{ kind: "text", value: text, marks: [] }] };
}

const editable = ["current", "stale"];

export const Architecture = definePageType({
  type: "architecture",
  label: "Architecture node",
  version: 2,
  // No draft: a node is documented after the code exists, so it is born `current`; an agent
  // flips it `stale` when it detects drift and back to `current` once re-verified.
  initialStatus: "current",
  statusTransitions: [t("current", "markStale", "stale"), t("stale", "markCurrent", "current")],
  sections: {
    summary: {
      name: "Summary",
      required: true,
      mutableIn: editable,
      // The `kind` enum is declared on the FIELD (not just setKind's arg) so the engine
      // enforces it on every path — including the auto-generated setSummaryKind command.
      fields: { kind: { kind: "scalar", schema: zodSchema(z.enum(KINDS)) }, body: { kind: "prose" } },
    },
    purpose: { name: "Purpose", required: true, mutableIn: editable, fields: { body: { kind: "prose" } } },
    usage: { name: "Usage", required: true, mutableIn: editable, fields: { body: { kind: "prose" } } },
    dataModel: { name: "Data model", required: true, mutableIn: editable, fields: { body: { kind: "prose" } } },
    // Free-form design narrative: prose paragraphs + code blocks (type defs, pseudo-code) — the
    // high-value mechanics that don't fit the structured prose fields. Required so it materializes
    // empty on every page (incl. pre-existing) at fold time (no backfill), and so the addBlock-based
    // commands have a section to target (a non-required section would never materialize → SectionNotFound).
    details: { name: "Design notes", required: true, mutableIn: editable, fields: { body: { kind: "blocks" } } },
    codeReferences: {
      name: "Code references",
      required: true,
      mutableIn: editable,
      fields: { items: { kind: "list", element: "codeRef", ordered: true } },
    },
    dependencies: {
      name: "Dependencies",
      required: true,
      mutableIn: editable,
      fields: { items: { kind: "list", element: "dependency", ordered: true } },
    },
    invariants: {
      name: "Invariants & constraints",
      required: true,
      mutableIn: editable,
      fields: { items: { kind: "list", element: "invariant", ordered: true } },
    },
    sync: { name: "Synced commit", required: true, mutableIn: editable, fields: { commit: { kind: "scalar" } } },
  },
  elements: {
    codeRef: {
      fields: {
        file: { kind: "scalar", required: true },
        symbol: { kind: "scalar" },
        kind: { kind: "scalar", schema: zodSchema(z.enum(CODEREF_KINDS)) },
      },
    },
    dependency: {
      fields: {
        target: { kind: "ref", required: true, targetKinds: ["page"] },
        role: { kind: "scalar", required: true, schema: zodSchema(z.enum(ROLES)) },
        note: { kind: "prose" },
      },
    },
    invariant: { fields: { statement: { kind: "prose", required: true } } },
  },
  sectionSet: { mode: "closed" },
  derived: {
    "code-reference-rows": codeReferenceRows,
    "dependency-rows": dependencyRows,
    "component-rows": componentRows,
  },
  // The curated enums (kind / role / codeRef-kind) and `required` flags are enforced on these
  // hand-written commands — the authoritative authoring path. The engine ALSO auto-generates
  // unconstrained structural commands (set<Sec><Field>, add/remove/move<Sec><Field>Element) that
  // bypass those checks; that is an engine-wide escape hatch, not specific to this page type.
  commands: {
    setKind: {
      args: zodSchema(z.object({ kind: z.enum(KINDS) })),
      target: { section: "summary", field: "kind" },
      set: { kind: arg("kind") },
    },
    setSummary: {
      args: zodSchema(z.object({ text: z.string() })),
      target: { section: "summary", field: "body" },
      set: { body: arg("text") },
    },
    setPurpose: {
      args: zodSchema(z.object({ text: z.string() })),
      target: { section: "purpose", field: "body" },
      set: { body: arg("text") },
    },
    setUsage: {
      args: zodSchema(z.object({ text: z.string() })),
      target: { section: "usage", field: "body" },
      set: { body: arg("text") },
    },
    setDataModel: {
      args: zodSchema(z.object({ text: z.string() })),
      target: { section: "dataModel", field: "body" },
      set: { body: arg("text") },
    },
    // ── design notes (blocks: prose + code) — mirrors adr's addDecisionBlock/addDecisionCode ──
    /** Append a prose paragraph to the Design notes. */
    addNote: {
      args: zodSchema(z.object({ text: z.string() })),
      result: zodSchema(z.object({ blockId: z.string() })),
      target: { section: "details", field: "body" },
      produces: (_page, args, ctx) => {
        const a = args as { text: string };
        return [{ op: "addBlock", section: "details", field: "body", block: paragraph(a.text, ctx.newId) }];
      },
    },
    /** Append a fenced code block to the Design notes (hash "" → recomputed at ingestion). */
    addNoteCode: {
      args: zodSchema(z.object({ language: z.string(), source: z.string() })),
      result: zodSchema(z.object({ blockId: z.string() })),
      target: { section: "details", field: "body" },
      produces: (_page, args, ctx) => {
        const a = args as { language: string; source: string };
        const block: IBlock = { kind: "code", id: ctx.newId() as BlockId, lang: a.language, source: a.source, hash: "" };
        return [{ op: "addBlock", section: "details", field: "body", block }];
      },
    },
    removeNote: {
      args: zodSchema(z.object({ blockId: z.string() })),
      target: { section: "details", field: "body" },
      produces: (_page, args) => [
        { op: "removeBlock", section: "details", field: "body", block: (args as { blockId: string }).blockId as BlockId },
      ],
    },
    /** Add a code reference (file + optional symbol/kind; never a line number). */
    addCodeRef: {
      args: zodSchema(
        z
          .object({ file: z.string(), symbol: z.string().optional(), kind: z.enum(CODEREF_KINDS).optional() })
          // `kind` describes the symbol, and the renderer only shows it alongside a symbol, so
          // reject a `kind` without a `symbol` rather than silently dropping it.
          .refine((a) => a.kind === undefined || a.symbol !== undefined, {
            message: "`kind` requires `symbol`",
            path: ["kind"],
          }),
      ),
      result: zodSchema(z.object({ codeRefId: z.string() })),
      target: { section: "codeReferences", field: "items" },
      produces: (_page, args, ctx) => {
        const a = args as { file: string; symbol?: string; kind?: string };
        const fields: Record<string, IField> = { file: { kind: "scalar", value: a.file } };
        if (a.symbol !== undefined) fields.symbol = { kind: "scalar", value: a.symbol };
        if (a.kind !== undefined) fields.kind = { kind: "scalar", value: a.kind };
        return [{ op: "addElement", section: "codeReferences", field: "items", id: ctx.newId(), fields }];
      },
    },
    removeCodeRef: {
      args: zodSchema(z.object({ codeRefId: z.string() })),
      target: { section: "codeReferences", field: "items" },
      produces: (_page, args) => [
        { op: "removeElement", section: "codeReferences", field: "items", id: (args as { codeRefId: string }).codeRefId },
      ],
    },
    /** Add a dependency edge to another architecture page (integrity-checked: target must exist). */
    addDependency: {
      args: zodSchema(z.object({ targetId: z.string(), role: z.enum(ROLES), note: z.string().optional() })),
      result: zodSchema(z.object({ dependencyId: z.string() })),
      target: { section: "dependencies", field: "items" },
      produces: (_page, args, ctx) => {
        const a = args as { targetId: string; role: string; note?: string };
        // An edge is to ANOTHER architecture page. (resolveRef independently rejects a
        // non-existent target; this also rejects self-edges and wrong-type targets — the
        // `ref`'s `targetKinds` is advisory, so the page-type constraint is enforced here.)
        if (a.targetId === String(ctx.related.self)) {
          throw new Error("an architecture node cannot depend on itself");
        }
        const target = ctx.related.page(a.targetId as PageId);
        if (target === undefined || target.type !== "architecture") {
          throw new Error(`dependency target must be an existing architecture page (got "${a.targetId}")`);
        }
        const fields: Record<string, IField> = {
          target: { kind: "ref", target: { kind: "page", id: a.targetId as PageId } },
          role: { kind: "scalar", value: a.role },
        };
        if (a.note !== undefined) fields.note = { kind: "prose", value: a.note };
        return [{ op: "addElement", section: "dependencies", field: "items", id: ctx.newId(), fields }];
      },
    },
    removeDependency: {
      args: zodSchema(z.object({ dependencyId: z.string() })),
      target: { section: "dependencies", field: "items" },
      produces: (_page, args) => [
        {
          op: "removeElement",
          section: "dependencies",
          field: "items",
          id: (args as { dependencyId: string }).dependencyId,
        },
      ],
    },
    addInvariant: {
      args: zodSchema(z.object({ text: z.string() })),
      result: zodSchema(z.object({ invariantId: z.string() })),
      target: { section: "invariants", field: "items" },
      set: { statement: arg("text") },
    },
    removeInvariant: {
      args: zodSchema(z.object({ invariantId: z.string() })),
      target: { section: "invariants", field: "items" },
      produces: (_page, args) => [
        { op: "removeElement", section: "invariants", field: "items", id: (args as { invariantId: string }).invariantId },
      ],
    },
    /** Record the repo commit this node was last verified against. */
    recordSync: {
      args: zodSchema(z.object({ commit: z.string() })),
      target: { section: "sync", field: "commit" },
      set: { commit: arg("commit") },
    },
    /** Flag the node as drifted from the code (agent-determined, out of band). */
    markStale: { args: zodSchema(empty), transition: { level: "page", event: "markStale" } },
    /** Re-affirm the node matches the code (after editing + recordSync). */
    markCurrent: { args: zodSchema(empty), transition: { level: "page", event: "markCurrent" } },
  },
  render: {
    title: "{title}",
    graphSections: false,
    // NOTE: a `placeholder` is honored for DERIVED sections and missing fields, but an empty
    // scalar/prose/list field renders the engine default `_None._` (renderFieldBody), so we
    // set placeholders only on the derived rows where they actually apply.
    sections: [
      { section: "summary", field: "kind", heading: "Kind", as: "inline" },
      { section: "summary", field: "body", heading: "Summary", as: "block" },
      { section: "purpose", field: "body", heading: "Purpose", as: "block" },
      { section: "details", field: "body", heading: "Design notes", as: "blocks", placeholder: "_No design notes._" },
      // Contained sub-nodes = this node's page-tree children, rendered as links (page-id href).
      // Surfaces the package→component hierarchy ON the node page (the way a toc surfaces its
      // children); a leaf node shows the placeholder.
      { derived: "component-rows", heading: "Components", placeholder: "_No components._" },
      { derived: "dependency-rows", heading: "Dependencies", placeholder: "_No dependencies._" },
      { derived: "code-reference-rows", heading: "Code references", placeholder: "_No code references._" },
      { section: "dataModel", field: "body", heading: "Data model", as: "block" },
      { section: "usage", field: "body", heading: "Usage", as: "block" },
      { section: "invariants", field: "items", heading: "Invariants & constraints", as: "bullets", item: "{statement}" },
      { section: "sync", field: "commit", heading: "Synced commit", as: "inline" },
    ],
  },
});
