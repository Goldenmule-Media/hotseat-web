/**
 * `decision-record` page type (human label "ADR") — an Architecture Decision Record as a
 * first-class, FSM-governed wiki page. It replaces the flat ADR appendices that used to live
 * at the bottom of each package's design doc: those carried no status, no lifecycle, no link
 * from a decision to the one that revises it, and only a PER-FILE id (so `wiki-mcp` and
 * `wiki-models` could both ship an "ADR-M7"). Here every decision is one page in one global
 * "ADRs" workspace, and IDENTITY is the stable global page id. A human-friendly `ADR-N` label
 * is an engine-assigned `serial` field (`meta.number`) surfaced in the rendered title — a
 * display handle, never identity, so it can't collide or be hand-edited out of sequence.
 *
 * Shape (Michael Nygard's template + a little metadata):
 *  - meta — `number` (the engine-assigned `ADR-N` sequence; immutable), `date` (stored ISO
 *    string; never `new Date()`), `scope` (the package/area, for filtering), and `deciders`.
 *  - context — the forces and the problem, as prose.
 *  - decision — the call, as blocks (so a decision can carry a code / interface snippet).
 *  - consequences — what becomes easier or harder, as blocks.
 *  - relations — a `supersededBy` ref to the record that replaces this one.
 *
 * Lifecycle: `proposed` →(accept)→ `accepted`, or →(reject)→ `rejected`; an accepted record is
 * later →(supersede)→ `superseded` or →(deprecate)→ `deprecated`. `rejected`/`superseded`/
 * `deprecated` are terminal — they match how decisions actually end.
 *
 * SUPERSESSION is the one load-bearing edge, and it is INTEGRITY-CHECKED, not prose: entering
 * `superseded` requires a `supersededBy` ref that resolves to a LIVE `decision-record`. It is a
 * two-op atomic batch — `setSupersededBy(id)` (ingestion checks the target exists at set time)
 * then `supersede()` (a `namesSuccessor` precondition reads the now-committed ref and checks it
 * is a decision-record, not itself). Two ops, because a precondition runs BEFORE its own
 * command's ops and gets no args; `mutateMany`/`mutatePageBatch` lands them as one commit, so a
 * superseded decision can NEVER dangle. The reverse "Supersedes" view is render-derived from
 * incoming refs — no second source of truth to rot.
 */
import type {
  BlockId,
  DeepReadonly,
  DerivedItem,
  DerivedList,
  IBlock,
  IField,
  IRenderCtx,
  PageId,
  PageState,
  Precondition,
} from "wiki/authoring";
import { arg, definePageType, parseInline, t } from "wiki/authoring";
import { z, zodSchema } from "wiki/authoring";

const empty = z.object({});

// The states a decision can ever sit in (proposed/accepted are editable; the rest terminal).
const editable = ["proposed", "accepted"];

// ────────────────────────────────────────────────────────────────────────────
// Pure read helpers over folded state (shared by the precondition and the renderers)
// ────────────────────────────────────────────────────────────────────────────

/** A section's field map (or {} when the section is absent), tolerant of an undefined page. */
function fieldsOf(page: DeepReadonly<PageState> | undefined, sectionKey: string): DeepReadonly<Record<string, IField>> {
  return page?.sections.find((s) => s.key === sectionKey)?.fields ?? {};
}

/** A scalar field's string value, or "". */
function scalarOf(fields: DeepReadonly<Record<string, IField>>, key: string): string {
  const f = fields[key];
  return f !== undefined && f.kind === "scalar" ? String(f.value) : "";
}

/** The page id a `ref`-to-page field points at, or undefined (handles the materialized-empty
 *  scalar a `ref` field starts life as before it is set). */
function refPageId(fields: DeepReadonly<Record<string, IField>>, key: string): PageId | undefined {
  const f = fields[key];
  return f !== undefined && f.kind === "ref" && f.target.kind === "page" ? (f.target.id as PageId) : undefined;
}

/** The decider names recorded on a record (empty entries dropped). */
function deciderNames(page: DeepReadonly<PageState>): string[] {
  const f = fieldsOf(page, "meta")["deciders"];
  if (f === undefined || f.kind !== "list") return [];
  return f.elements
    .map((el) => {
      const n = el.fields["name"];
      return n !== undefined && n.kind === "scalar" ? String(n.value) : "";
    })
    .filter((n) => n.length > 0);
}

/**
 * The top-most ancestor reachable by following `parentId` — the root-level container the ADRs
 * live under (the migration parents them all beneath one "Decision Records" page). Lets the
 * reverse "Supersedes" view enumerate sibling records regardless of nesting depth, WITHOUT the
 * engine exposing a workspace-wide page list to models.
 */
function containerRoot(page: DeepReadonly<PageState>, ctx: IRenderCtx): PageId {
  let id = page.id as unknown as PageId;
  let parent = page.parentId as unknown as PageId | null;
  while (parent !== null) {
    id = parent;
    parent = (ctx.pageState(parent)?.parentId ?? null) as unknown as PageId | null;
  }
  return id;
}

/** Every `decision-record` under the shared container, in deterministic tree order. */
function decisionRecordsUnder(page: DeepReadonly<PageState>, ctx: IRenderCtx): PageId[] {
  const out: PageId[] = [];
  const seen = new Set<string>();
  const walk = (id: PageId): void => {
    if (seen.has(String(id))) return; // the tree is acyclic, but stay defensive
    seen.add(String(id));
    if (ctx.typeOf(id) === "decision-record") out.push(id);
    for (const child of ctx.childrenOf(id)) walk(child as PageId);
  };
  walk(containerRoot(page, ctx));
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Supersession gate
// ────────────────────────────────────────────────────────────────────────────

/**
 * The `accepted → superseded` gate (Q4/Q8): a record may only be superseded once it names a
 * LIVE successor. Reads the now-committed `supersededBy` ref (the batch folds `setSupersededBy`
 * before this runs) and checks it points at an existing, OTHER `decision-record`. Ingestion's
 * ref-integrity already guarantees the target EXISTS at set time; this adds the type + self
 * checks a precondition (which gets no args) is the only place to make.
 */
const namesSuccessor: Precondition = (page, related) => {
  const target = refPageId(fieldsOf(page, "relations"), "supersededBy");
  if (target === undefined) {
    return { unmet: "set supersededBy (the ADR that replaces this one) before superseding" };
  }
  if (String(target) === String(related.self)) {
    return { unmet: "a decision cannot supersede itself" };
  }
  const successor = related.page(target);
  if (successor === undefined) {
    return { unmet: "supersededBy must point at an existing decision-record" };
  }
  if (successor.type !== "decision-record") {
    return { unmet: "supersededBy must point at a decision-record" };
  }
  return true;
};

// ────────────────────────────────────────────────────────────────────────────
// Render projections
// ────────────────────────────────────────────────────────────────────────────

/** A compact metadata block — one bullet per present field, empties omitted. Deterministic. */
const metaRows: DerivedList = (page) => {
  const meta = fieldsOf(page, "meta");
  const rows: DerivedItem[] = [];
  const date = scalarOf(meta, "date");
  const scope = scalarOf(meta, "scope");
  const deciders = deciderNames(page);
  if (date.length > 0) rows.push({ id: "date", text: `**Date:** ${date}` });
  if (scope.length > 0) rows.push({ id: "scope", text: `**Scope:** ${scope}` });
  if (deciders.length > 0) rows.push({ id: "deciders", text: `**Deciders:** ${deciders.join(", ")}` });
  return rows;
};

/**
 * The relations block, BOTH directions, derived from refs (never stored prose):
 *  - "Superseded by" — this record's own outgoing `supersededBy` ref.
 *  - "Supersedes" — every sibling record whose `supersededBy` points back here (incoming refs).
 * Links use the stable page-id href; labels are render-derived, so renames reflow. Deterministic.
 */
const relationRows: DerivedList = (page, ctx) => {
  const rows: DerivedItem[] = [];
  const self = page.id as unknown as PageId;
  const link = (id: PageId): string => `[${ctx.titleOf(id) ?? String(id)}](${String(id)})`;

  const out = refPageId(fieldsOf(page, "relations"), "supersededBy");
  if (out !== undefined) {
    const archived = ctx.archivedOf(out) ? " (archived)" : "";
    rows.push({ id: "superseded-by", text: `**Superseded by** → ${link(out)}${archived}` });
  }
  for (const id of decisionRecordsUnder(page, ctx)) {
    if (String(id) === String(self)) continue;
    const back = refPageId(fieldsOf(ctx.pageState(id), "relations"), "supersededBy");
    if (back !== undefined && String(back) === String(self)) {
      rows.push({ id: `supersedes:${String(id)}`, text: `**Supersedes** → ${link(id)}` });
    }
  }
  return rows;
};

// ────────────────────────────────────────────────────────────────────────────
// Block authoring helpers (mirrors feature-spec's addParagraph / addDesignCode)
// ────────────────────────────────────────────────────────────────────────────

/** A prose paragraph block carrying `text` — inline Markdown (code spans, emphasis, links) is
 *  parsed into canonical runs so a `blocks` field accepts it. Id minted from the injected `newId`. */
function paragraph(text: string, newId: () => string): IBlock {
  return { kind: "paragraph", id: newId() as BlockId, inlines: parseInline(text) };
}

export const DecisionRecord = definePageType({
  type: "decision-record",
  label: "ADR",
  description:
    "Records ONE architectural decision — the context, the options weighed, the choice made, and its " +
    "consequences — as a durable, dated rationale. Use it to capture WHY the system is shaped the way it is, " +
    "not to describe the shape itself (that's `architecture`) or to plan new work (that's a `feature`).",
  version: 1,
  initialStatus: "proposed",
  statusTransitions: [
    t("proposed", "accept", "accepted"),
    t("proposed", "reject", "rejected"),
    t("accepted", "supersede", "superseded"), // gated on naming a live successor (namesSuccessor)
    t("accepted", "deprecate", "deprecated"),
  ],
  sections: {
    meta: {
      name: "Metadata",
      required: true,
      mutableIn: editable,
      fields: {
        number: { kind: "serial" }, // ADR-N — engine-assigned at create, immutable; shown via render.title
        date: { kind: "scalar", required: true }, // ISO date string — STORED, never new Date()
        scope: { kind: "scalar" }, // e.g. "wiki-mcp" — for filtering/grouping
        deciders: { kind: "list", element: "decider", ordered: true },
      },
    },
    context: { name: "Context", required: true, mutableIn: editable, fields: { body: { kind: "prose", required: true } } },
    decision: { name: "Decision", required: true, mutableIn: editable, fields: { body: { kind: "blocks" } } },
    consequences: { name: "Consequences", required: true, mutableIn: editable, fields: { body: { kind: "blocks" } } },
    // Relations is writable ONLY once accepted — supersession is a post-acceptance act.
    relations: { name: "Relations", required: true, mutableIn: ["accepted"], fields: { supersededBy: { kind: "ref", targetKinds: ["page"] } } },
  },
  elements: {
    decider: { fields: { name: { kind: "scalar", required: true } } },
  },
  sectionSet: { mode: "closed" },
  derived: {
    "meta-rows": metaRows,
    "relation-rows": relationRows,
  },
  commands: {
    // ── metadata ──
    setDate: {
      args: zodSchema(z.object({ date: z.string() })),
      target: { section: "meta", field: "date" },
      set: { date: arg("date") },
    },
    setScope: {
      args: zodSchema(z.object({ scope: z.string() })),
      target: { section: "meta", field: "scope" },
      set: { scope: arg("scope") },
    },
    addDecider: {
      args: zodSchema(z.object({ name: z.string() })),
      result: zodSchema(z.object({ deciderId: z.string() })),
      target: { section: "meta", field: "deciders" },
      set: { name: arg("name") },
    },
    removeDecider: {
      args: zodSchema(z.object({ deciderId: z.string() })),
      target: { section: "meta", field: "deciders" },
      produces: (_page, args) => [
        { op: "removeElement", section: "meta", field: "deciders", id: (args as { deciderId: string }).deciderId },
      ],
    },
    // ── context (prose) ──
    setContext: {
      args: zodSchema(z.object({ text: z.string() })),
      target: { section: "context", field: "body" },
      set: { body: arg("text") },
    },
    // ── decision (blocks: prose + code) ──
    addDecisionBlock: {
      args: zodSchema(z.object({ text: z.string() })),
      result: zodSchema(z.object({ blockId: z.string() })),
      target: { section: "decision", field: "body" },
      produces: (_page, args, ctx) => {
        const a = args as { text: string };
        return [{ op: "addBlock", section: "decision", field: "body", block: paragraph(a.text, ctx.newId) }];
      },
    },
    addDecisionCode: {
      args: zodSchema(z.object({ language: z.string(), source: z.string() })),
      result: zodSchema(z.object({ blockId: z.string() })),
      target: { section: "decision", field: "body" },
      produces: (_page, args, ctx) => {
        const a = args as { language: string; source: string };
        // hash is normalized / recomputed during ingestion (mirrors feature-spec addDesignCode).
        const block: IBlock = { kind: "code", id: ctx.newId() as BlockId, lang: a.language, source: a.source, hash: "" };
        return [{ op: "addBlock", section: "decision", field: "body", block }];
      },
    },
    removeDecisionBlock: {
      args: zodSchema(z.object({ blockId: z.string() })),
      target: { section: "decision", field: "body" },
      produces: (_page, args) => [
        { op: "removeBlock", section: "decision", field: "body", block: (args as { blockId: string }).blockId as BlockId },
      ],
    },
    // ── consequences (blocks) ──
    addConsequence: {
      args: zodSchema(z.object({ text: z.string() })),
      result: zodSchema(z.object({ blockId: z.string() })),
      target: { section: "consequences", field: "body" },
      produces: (_page, args, ctx) => {
        const a = args as { text: string };
        return [
          { op: "addBlock", section: "consequences", field: "body", block: paragraph(a.text, ctx.newId) },
        ];
      },
    },
    removeConsequence: {
      args: zodSchema(z.object({ blockId: z.string() })),
      target: { section: "consequences", field: "body" },
      produces: (_page, args) => [
        { op: "removeBlock", section: "consequences", field: "body", block: (args as { blockId: string }).blockId as BlockId },
      ],
    },
    // ── lifecycle ──
    accept: { args: zodSchema(empty), transition: { level: "page", event: "accept" } },
    reject: { args: zodSchema(empty), transition: { level: "page", event: "reject" } },
    deprecate: { args: zodSchema(empty), transition: { level: "page", event: "deprecate" } },
    // Supersession — set the ref (ingestion checks existence) then transition (precondition
    // checks it is a live decision-record). Batch the two via mutateMany for one atomic commit.
    setSupersededBy: {
      args: zodSchema(z.object({ supersededBy: z.string() })),
      target: { section: "relations", field: "supersededBy" },
      set: { supersededBy: arg("supersededBy") }, // string id → {kind:"ref",target:{kind:"page",id}} (kindFor sugar)
    },
    supersede: {
      args: zodSchema(empty),
      transition: { level: "page", event: "supersede" },
      preconditions: [namesSuccessor],
    },
  },
  render: {
    title: "ADR-{meta.number}: {title}",
    graphSections: false, // refs ARE the relations; the engine's link-based References section would be empty
    sections: [
      { derived: "meta-rows", heading: "Metadata", placeholder: "_No metadata._" },
      { section: "context", field: "body", heading: "Context", as: "block", placeholder: "_No context yet._" },
      { section: "decision", field: "body", heading: "Decision", as: "blocks", placeholder: "_No decision recorded._" },
      { section: "consequences", field: "body", heading: "Consequences", as: "blocks", placeholder: "_None._" },
      { derived: "relation-rows", heading: "Relations", placeholder: "_None._" },
    ],
  },
});
