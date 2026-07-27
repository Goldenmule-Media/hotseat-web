/**
 * `spec-restatement` page type. An AI drafts a spec as an ordered list of sections; a
 * human proves understanding by RESTATING sections in their own words (a wiki-ui studio
 * drives `restateSections`); accepted restatements atomically replace the AI sections and
 * are born `human-verified`. When every section is verified, a holistic AI review records
 * notes; the human fixes/resolves and approves. Provenance is the element FSM
 * (`ai-draft` ↔ `human-verified`), enforced by the element write-gate: an AI edit must
 * downgrade a verified section back to `ai-draft` before touching its content.
 */
import type { DeepReadonly, IBlock, IField, IItem, PageState, Precondition, SeedElement, SectionOp } from "wiki/authoring";
import { definePageType, InvariantViolationError, parseBlocks, t, z, zodSchema } from "wiki/authoring";

const empty = z.object({});

/**
 * The REQUIRED SLOTS every spec must address, seeded empty at page creation and gated at
 * `submitForRestatement`. Derived from auditing a real 700-line spec's whole revision
 * history against a conventional tech-spec template: each slot here is either a template
 * obligation that survived contact with reality, or a section the real spec had to grow
 * late and expensively. A spec adds any further sections it wants — the rubric is a
 * floor, not a shape.
 *
 * The titles are DEFAULTS, not the contract; the gate reads the `slot` tag, so a spec may
 * retitle a slot to whatever its domain calls that obligation.
 */
const SLOTS = [
  {
    key: "motivation",
    title: "Motivation",
    prompt: "What is wrong TODAY. The current situation and its cost — not the desired end state, which is the Overview's job.",
  },
  {
    key: "overview",
    title: "Overview",
    prompt: "The shape of the proposal in prose: what is being built and the one or two ideas it rests on.",
  },
  {
    key: "data-model",
    title: "Data model & types",
    prompt:
      "The data the system manages, as TYPES — at least one fenced code block. Give every field's full domain, including reserved and sentinel values.",
  },
  {
    key: "algorithm",
    title: "Algorithm",
    prompt: "The normative decision or transformation, as numbered pseudocode — the one place a reader can go to know what the system actually does.",
  },
  {
    key: "invariants",
    title: "Invariants & limits",
    prompt:
      "Every rule the rest of the spec relies on, as a LIST of atomic, citable statements — bounds, caps, and the properties that must always hold. State each once; elsewhere cite it.",
  },
  {
    key: "failure-semantics",
    title: "Failure & concurrency semantics",
    prompt:
      "What happens under conflict, retry, partial data, and a missing dependency. Which way the system fails, and whether a locally-accepted result is provisional.",
  },
  {
    key: "data-dependencies",
    title: "Data dependencies",
    prompt:
      "For every input the system reads: how does it REACH the place that reads it, and what is the behaviour in the window before it arrives?",
  },
  {
    key: "migration",
    title: "Migration & existing data",
    prompt: "What happens to data that already exists and never knew about this change. If nothing exists yet, say so and why.",
  },
  {
    key: "staged-plan",
    title: "Staged plan",
    prompt:
      "The stages this ships in. Per stage: what ships, what it explicitly does NOT do yet, and the exit test that proves it landed.",
  },
] as const;

type SlotKey = (typeof SLOTS)[number]["key"];

const SLOT_KEYS = SLOTS.map((s) => s.key);
const slotArg = z.enum(SLOT_KEYS as [SlotKey, ...SlotKey[]]);
const slotTitle = new Map<string, string>(SLOTS.map((s) => [s.key, s.title]));

/** The rubric seeds: one empty `ai-draft` section per required slot, in rubric order. */
const slotSeeds: SeedElement[] = SLOTS.map((s) => ({
  key: s.key,
  status: "ai-draft",
  fields: {
    title: { kind: "prose", value: s.title },
    body: { kind: "blocks", blocks: [] },
    slot: { kind: "scalar", value: s.key },
    depth: { kind: "scalar", value: 0 },
  },
}));

const SEVERITIES = ["minor", "major", "critical"] as const;
const severityArg = z.enum(SEVERITIES);

const sectionInput = z.object({ title: z.string(), markdown: z.string(), depth: z.number().int().min(0).optional() });
const noteInput = z.object({ title: z.string(), markdown: z.string(), severity: severityArg });

function listOf(page: DeepReadonly<PageState>, sectionKey: string, fieldKey: string): readonly DeepReadonly<IItem>[] {
  const f = page.sections.find((s) => s.key === sectionKey)?.fields[fieldKey];
  return f !== undefined && f.kind === "list" ? f.elements : [];
}

function titleOf(el: DeepReadonly<IItem>): string {
  const f = el.fields["title"];
  return f !== undefined && f.kind === "prose" && f.value.length > 0 ? f.value : el.id;
}

/** A review-note's creation-time fields (body reified via parseBlocks). */
function bodyFields(title: string, markdown: string, newId: () => string): Record<string, IField> {
  return {
    title: { kind: "prose", value: title },
    body: { kind: "blocks", blocks: parseBlocks(markdown, newId) },
  };
}

/** A spec-section's creation-time fields — body plus its outline position and slot tag. */
function sectionFields(
  title: string,
  markdown: string,
  newId: () => string,
  depth: number,
  slot: string,
): Record<string, IField> {
  return {
    ...bodyFields(title, markdown, newId),
    slot: { kind: "scalar", value: slot },
    depth: { kind: "scalar", value: depth },
  };
}

/** The whole spec is in the human's words: ≥1 section and not one still ai-draft. This is
 *  what the `restated` status MEANS — the engine derives it from this, both ways. */
function everySectionVerified(page: DeepReadonly<PageState>): boolean {
  const sections = listOf(page, "sections", "items");
  return sections.length > 0 && sections.every((s) => s.status === "human-verified");
}

const allSectionsVerified: Precondition = (page) => {
  const sections = listOf(page, "sections", "items");
  if (sections.length === 0) return { unmet: "needs ≥1 spec section in sections.items" };
  const unverified = sections.filter((s) => s.status !== "human-verified");
  if (unverified.length > 0) {
    return { unmet: `every section must be human-verified; still ai-draft: ${unverified.map(titleOf).join(", ")}` };
  }
  return true;
};

const inRestated: Precondition = (page) =>
  page.status === "restated"
    ? true
    : {
        unmet: `requestHolisticReview fires from "restated" (page is "${page.status}") — a page enters it by itself once every section is human-verified; while reviewing use rerunHolisticReview`,
      };

const inReviewing: Precondition = (page) =>
  page.status === "reviewing" ? true : { unmet: `rerunHolisticReview runs while "reviewing" (page is "${page.status}")` };

const noOpenNotes: Precondition = (page) => {
  const open = listOf(page, "review", "notes").filter((n) => n.status === "open");
  return open.length === 0 ? true : { unmet: `resolve the open review notes first: ${open.map(titleOf).join(", ")}` };
};

const activeRestatement =
  (command: string): Precondition =>
  (page) =>
    page.status === "restating" || page.status === "restated" || page.status === "reviewing"
      ? true
      : { unmet: `${command} runs while "restating", "restated" or "reviewing" (page is "${page.status}")` };

/** Resolve `sectionIds` to elements, throwing loudly on a missing id or a wrong status —
 *  produces-emitted transition ops silently no-op on an illegal edge, so acceptance
 *  mistakes must fail the command instead. */
function requireSectionsInStatus(
  page: DeepReadonly<PageState>,
  sectionIds: readonly string[],
  status: string,
  complaint: string,
): void {
  const byId = new Map(listOf(page, "sections", "items").map((e) => [e.id, e]));
  const missing = sectionIds.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new InvariantViolationError(`sectionIds not found in sections.items: ${missing.join(", ")}`);
  }
  const wrong = sectionIds.filter((id) => byId.get(id)!.status !== status);
  if (wrong.length > 0) {
    throw new InvariantViolationError(`${complaint}: ${wrong.join(", ")}`);
  }
}

function blocksOf(el: DeepReadonly<IItem>): readonly DeepReadonly<IBlock>[] {
  const f = el.fields["body"];
  return f !== undefined && f.kind === "blocks" ? f.blocks : [];
}

function scalarOf(el: DeepReadonly<IItem>, field: string): string {
  const f = el.fields[field];
  return f !== undefined && f.kind === "scalar" ? String(f.value) : "";
}

/** A section's 0-based nesting depth: `##` body sections are 0, a `###` under one is 1. */
function depthOf(el: DeepReadonly<IItem>): number {
  const n = Number(scalarOf(el, "depth"));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** The slot this section fills, or "" for a spec's own added section. */
function slotOf(el: DeepReadonly<IItem>): string {
  return scalarOf(el, "slot");
}

/**
 * The half-open index range of `sectionId`'s SUBTREE — itself plus the run of deeper
 * sections that follows it. Structure ops move and delete whole subtrees, because a `###`
 * that leaves its `####`s behind silently reparents them under the previous section.
 */
function subtreeRange(elements: readonly DeepReadonly<IItem>[], index: number): { start: number; end: number } {
  const base = depthOf(elements[index]!);
  let end = index + 1;
  while (end < elements.length && depthOf(elements[end]!) > base) end++;
  return { start: index, end };
}

const setDepth = (id: string, value: number): SectionOp => ({
  op: "setElementField",
  section: "sections",
  field: "items",
  id,
  elementField: "depth",
  value: { kind: "scalar", value },
});

/**
 * The deepest legal depth for a section landing at `index` (the element before it is its
 * potential parent) — one deeper than its predecessor, or 0 at the top. Enforcing this on
 * every write is the "no skipped heading levels" rule: a `####` may not follow a `##`.
 */
function maxDepthAt(elements: readonly DeepReadonly<IItem>[], index: number): number {
  const prev = index > 0 ? elements[index - 1] : undefined;
  return prev === undefined ? 0 : depthOf(prev) + 1;
}

function requireLegalDepth(elements: readonly DeepReadonly<IItem>[], index: number, depth: number): void {
  const max = maxDepthAt(elements, index);
  if (depth > max) {
    throw new InvariantViolationError(
      `depth ${depth} skips a level at this position — the deepest legal depth here is ${max}`,
    );
  }
}

/**
 * `moveElement` ops that relocate a whole subtree so its first member lands at `toIndex`
 * of the list WITHOUT the subtree (the engine's "index once lifted out"). Members move one
 * at a time, each landing immediately after the previous, so the run stays contiguous;
 * indices are computed against the simulated array because each op shifts the next one's.
 */
function moveSubtreeOps(ids: readonly string[], subtree: readonly string[], toIndex: number): SectionOp[] {
  const rest = ids.filter((id) => !subtree.includes(id));
  const at = Math.max(0, Math.min(toIndex, rest.length));
  const cur = [...ids];
  const ops: SectionOp[] = [];
  subtree.forEach((id, k) => {
    cur.splice(cur.indexOf(id), 1);
    const insert = k === 0 ? (at === 0 ? 0 : cur.indexOf(rest[at - 1]!) + 1) : cur.indexOf(subtree[k - 1]!) + 1;
    cur.splice(insert, 0, id);
    ops.push({ op: "moveElement", section: "sections", field: "items", id, toIndex: insert });
  });
  return ops;
}

/** Section titles, lowercased, for citation resolution. */
function titleIndex(sections: readonly DeepReadonly<IItem>[]): Set<string> {
  return new Set(sections.map((s) => titleOf(s).trim().toLowerCase()).filter((t) => t.length > 0));
}

/** Flatten a block tree to its plain text — enough to find `(see X)` citations. */
function blockText(blocks: readonly DeepReadonly<IBlock>[]): string {
  const out: string[] = [];
  const walkInlines = (inlines: readonly DeepReadonly<{ kind: string; value?: string }>[]): void => {
    for (const i of inlines) if (typeof i.value === "string") out.push(i.value);
  };
  const walk = (bs: readonly DeepReadonly<IBlock>[]): void => {
    for (const b of bs) {
      switch (b.kind) {
        case "paragraph":
        case "heading":
          walkInlines(b.inlines);
          break;
        case "quote":
          walk(b.blocks);
          break;
        case "list":
          for (const item of b.items) walk(item);
          break;
        case "table":
          for (const cell of b.header) walkInlines(cell);
          for (const row of b.rows) for (const cell of row) walkInlines(cell);
          break;
        default:
          break;
      }
    }
  };
  walk(blocks);
  return out.join(" ");
}

/** Does this section's body carry a fenced code block anywhere in its tree? */
function hasCodeBlock(blocks: readonly DeepReadonly<IBlock>[]): boolean {
  return blocks.some(
    (b) =>
      b.kind === "code" ||
      (b.kind === "quote" && hasCodeBlock(b.blocks)) ||
      (b.kind === "list" && b.items.some((item) => hasCodeBlock(item))),
  );
}

function hasListBlock(blocks: readonly DeepReadonly<IBlock>[]): boolean {
  return blocks.some((b) => b.kind === "list" || (b.kind === "quote" && hasListBlock(b.blocks)));
}

/** The sections filling `slot` — the slot's own section plus its subtree. */
function slotSubtree(elements: readonly DeepReadonly<IItem>[], slot: string): readonly DeepReadonly<IItem>[] {
  const at = elements.findIndex((e) => slotOf(e) === slot);
  if (at === -1) return [];
  const { start, end } = subtreeRange(elements, at);
  return elements.slice(start, end);
}

function authored(el: DeepReadonly<IItem>): boolean {
  return blocksOf(el).length > 0;
}

/**
 * TIER-1 GATE — rubric coverage. Every required slot must still be present and carry real
 * content (its own body, or a subsection's). A slot is a floor: the spec may retitle it,
 * add subsections under it, and add sections of its own, but it cannot ship silent.
 */
const slotsCovered: Precondition = (page) => {
  const elements = listOf(page, "sections", "items");
  const missing: string[] = [];
  const blank: string[] = [];
  for (const s of SLOTS) {
    const run = slotSubtree(elements, s.key);
    if (run.length === 0) missing.push(s.title);
    else if (!run.some(authored)) blank.push(titleOf(run[0]!));
  }
  const complaints: string[] = [];
  if (missing.length > 0) complaints.push(`required slots deleted: ${missing.join(", ")}`);
  if (blank.length > 0) complaints.push(`required slots still empty: ${blank.join(", ")}`);
  return complaints.length === 0 ? true : { unmet: complaints.join("; ") };
};

/**
 * TIER-1 GATE — shape. The obligations a rubric can check mechanically rather than trust:
 * the types slot must actually contain types, and the invariants slot must be a LIST, so
 * each rule is atomic and citable instead of buried in prose (which is how the same rule
 * gets restated two different ways in two places).
 */
const slotShape: Precondition = (page) => {
  const elements = listOf(page, "sections", "items");
  const complaints: string[] = [];
  const dataModel = slotSubtree(elements, "data-model");
  if (dataModel.length > 0 && !dataModel.some((s) => hasCodeBlock(blocksOf(s)))) {
    complaints.push(`"${titleOf(dataModel[0]!)}" must define the data as types — add a fenced code block`);
  }
  const invariants = slotSubtree(elements, "invariants");
  if (invariants.length > 0 && !invariants.some((s) => hasListBlock(blocksOf(s)))) {
    complaints.push(`"${titleOf(invariants[0]!)}" must be a list of atomic rules, so the rest of the spec can cite them`);
  }
  return complaints.length === 0 ? true : { unmet: complaints.join("; ") };
};

/** `(see Foo)` / `(see Foo and Bar)` cross-references inside a body. */
const CITATION = /\(see ([^)]+)\)/gi;

/**
 * TIER-1 GATE — citation integrity. Every `(see X)` must name a section that exists on
 * this page. Sections get renamed and merged constantly during drafting, and a citation to
 * a section that no longer exists is invisible in Markdown — the spec this rubric was
 * derived from shipped with exactly one such dangling reference.
 */
const citationsResolve: Precondition = (page) => {
  const elements = listOf(page, "sections", "items");
  const titles = titleIndex(elements);
  const dangling = new Map<string, string>();
  for (const el of elements) {
    const text = blockText(blocksOf(el));
    for (const m of text.matchAll(CITATION)) {
      for (const raw of m[1]!.split(/\band\b|,/)) {
        const name = raw.trim().replace(/[.\s]+$/, "").toLowerCase();
        if (name.length > 0 && !titles.has(name)) dangling.set(`${titleOf(el)} → "${raw.trim()}"`, name);
      }
    }
  }
  return dangling.size === 0
    ? true
    : { unmet: `these cross-references name no section on this page: ${[...dangling.keys()].join("; ")}` };
};

/** Locate a section, throwing loudly when the id is not on this page. */
function sectionAt(page: DeepReadonly<PageState>, sectionId: string): { index: number; el: DeepReadonly<IItem> } {
  const elements = listOf(page, "sections", "items");
  const index = elements.findIndex((e) => e.id === sectionId);
  if (index === -1) throw new InvariantViolationError(`section "${sectionId}" not found in sections.items`);
  return { index, el: elements[index]! };
}

/**
 * A body rewrite that PRESERVES the element's status. Content is writable only while
 * `ai-draft` (the element write-gate), so editing a verified section means downgrading
 * first — the ops evaluate in order, so re-verifying after the write lands in the same
 * commit and the section never publicly leaves human-verified.
 */
function rewriteBody(sectionId: string, blocks: readonly DeepReadonly<IBlock>[], verified: boolean): SectionOp[] {
  const gate = (event: string): SectionOp => ({
    op: "transition",
    level: "element",
    section: "sections",
    field: "items",
    element: sectionId,
    event,
  });
  return [
    ...(verified ? [gate("reviseAsDraft")] : []),
    {
      op: "setElementField",
      section: "sections",
      field: "items",
      id: sectionId,
      elementField: "body",
      value: { kind: "blocks", blocks: blocks as IBlock[] },
    },
    ...(verified ? [gate("verify")] : []),
  ];
}

export const SpecRestatement = definePageType({
  type: "spec-restatement",
  label: "Spec restatement",
  description:
    "A spec drafted by an AI and proven understood by a human who RESTATES each section in their own words. " +
    "Workflow: drafting → restating → reviewing → approved.\n\n" +
    "Every new spec is born with the REQUIRED SLOTS below already present and empty, in this order. Author " +
    "each with `writeSlot`:\n" +
    SLOTS.map((s) => `  • ${s.key} — ${s.title}: ${s.prompt}`).join("\n") +
    "\n\nAdd whatever else the spec needs with `draftSection` — the rubric is a floor, not a shape. `depth` " +
    "makes a section a SUBSECTION of the one above it (0 = top level, 1 = one deeper, never skipping a " +
    "level); subsections travel with their parent on move and delete. `submitForRestatement` is refused " +
    "until every slot is authored, the data-model slot contains a fenced code block, the invariants slot is " +
    "a list, and every `(see X)` cross-reference names a section that exists on the page.\n\n" +
    "NEVER mark a section human-verified yourself — verification happens only through a human's " +
    "`restateSections` in the studio, which atomically replaces AI sections with the human's restatement " +
    "(born `human-verified`). The page moves ITSELF to `restated` in the commit that verifies the last " +
    "section, and back to `restating` the moment one returns to ai-draft: that status is the sections, not a " +
    "decision. From `restated`, `recordHolisticReview` files the AI's holistic notes and moves the page to " +
    "reviewing; use `reviseSection`/`resolveNote`/`rerunHolisticReview` in the fix loop, and stop at the " +
    "human `approve` gate.",
  version: 1,
  initialStatus: "drafting",
  statusTransitions: [
    t("drafting", "submitForRestatement", "restating", { agency: "agent" }),
    t("restating", "completeRestatement", "restated", {
      agency: "agent",
      description:
        "Fires ITSELF the moment the last section becomes human-verified; the command exists only to catch up a page that was already complete before the rule was.",
    }),
    t("restated", "reopenRestatement", "restating", {
      description: "Fires itself when a section goes back to ai-draft — the status follows the content.",
    }),
    t("restated", "requestHolisticReview", "reviewing", {
      agency: "human",
      description:
        "Fired only via the recordHolisticReview command, which records the review summary and notes in the same commit.",
    }),
    t("reviewing", "approve", "approved", { agency: "human" }),
    t("reviewing", "reopenRestating", "restating"),
    t("approved", "reopen", "restating", { agency: "human" }),
  ],
  /**
   * `restated` is not a decision anyone makes — it IS "every section is in the human's
   * words", so the engine derives it from the sections both ways. Verifying the last
   * section lands the page there in that same commit; unaccepting one, or drafting a new
   * section, takes it straight back to `restating`.
   */
  autoTransitions: [
    { event: "completeRestatement", when: everySectionVerified },
    { event: "reopenRestatement", when: (page) => !everySectionVerified(page) },
  ],
  sections: {
    sections: {
      name: "Sections",
      required: true,
      // reviewing included so the note-fix loop (restate/revise) works in one state;
      // restated so an accepted section can still be edited once the spec is complete.
      mutableIn: ["drafting", "restating", "restated", "reviewing"],
      // Seeded with the required-slot rubric, so a new spec is born knowing what it owes.
      fields: { items: { kind: "list", element: "spec-section", ordered: true, seed: slotSeeds } },
    },
    review: {
      name: "Review",
      required: true,
      // restated REQUIRED: recordHolisticReview's content ops evaluate in the FROM status.
      // restating kept so the edge stays VISIBLE-but-blocked there, naming the sections
      // still to restate instead of vanishing from describeMutations.
      mutableIn: ["restating", "restated", "reviewing"],
      fields: {
        summary: { kind: "prose", requiredIn: ["approved"] },
        notes: { kind: "list", element: "review-note" },
      },
    },
  },
  elements: {
    "spec-section": {
      fields: {
        title: { kind: "prose", required: true },
        body: { kind: "blocks", required: true },
        /** The required slot this section fills, or "" for a section the spec added itself. */
        slot: { kind: "scalar" },
        /** 0-based outline depth: 0 renders `##`-level, 1 is a subsection of the one above. */
        depth: { kind: "scalar" },
      },
      status: {
        initial: "ai-draft",
        transitions: [t("ai-draft", "verify", "human-verified"), t("human-verified", "reviseAsDraft", "ai-draft")],
      },
      // Content edits only while ai-draft: an edit of a verified section must downgrade first.
      mutableIn: ["ai-draft"],
      // Re-nesting a section does not restate it, so depth stays writable while verified.
      structuralFields: ["depth"],
      awaitsHuman: (el) => el.status === "ai-draft",
    },
    "review-note": {
      fields: {
        title: { kind: "prose", required: true },
        body: { kind: "blocks", required: true },
        severity: { kind: "scalar", required: true, schema: zodSchema(severityArg) },
        resolution: { kind: "prose" },
      },
      status: { initial: "open", transitions: [t("open", "resolve", "resolved")] },
      mutableIn: ["open"],
      awaitsHuman: (n) => n.status === "open",
    },
  },
  sectionSet: { mode: "closed" },
  commands: {
    writeSlot: {
      description:
        "Author one of the REQUIRED SLOTS seeded on every spec (see the page description for the list and what " +
        "each owes). `markdown` replaces that slot section's body. This is the drafting agent's main verb: a new " +
        "spec is born with every slot present and empty, and `submitForRestatement` refuses while any is blank. " +
        "A page predating the rubric carries no slot sections; writing one CREATES it at the end, so an older " +
        "spec grows its rubric a slot at a time instead of dead-ending at the gate.",
      args: zodSchema(z.object({ slot: slotArg, markdown: z.string().min(1), title: z.string().optional() })),
      target: { section: "sections", field: "items" },
      produces: (page, args, ctx) => {
        const a = args as { slot: SlotKey; markdown: string; title?: string };
        const el = listOf(page, "sections", "items").find((e) => slotOf(e) === a.slot);
        if (el === undefined) {
          return [
            {
              op: "addElement",
              section: "sections",
              field: "items",
              id: ctx.newId(),
              fields: sectionFields(a.title ?? slotTitle.get(a.slot) ?? a.slot, a.markdown, ctx.newId, 0, a.slot),
            },
          ];
        }
        const ops: SectionOp[] = [];
        if (el.status === "human-verified") {
          ops.push({ op: "transition", level: "element", section: "sections", field: "items", element: el.id, event: "reviseAsDraft" });
        }
        ops.push({
          op: "setElementField",
          section: "sections",
          field: "items",
          id: el.id,
          elementField: "body",
          value: { kind: "blocks", blocks: parseBlocks(a.markdown, ctx.newId) },
        });
        if (a.title !== undefined) {
          ops.push({ op: "setElementField", section: "sections", field: "items", id: el.id, elementField: "title", value: { kind: "prose", value: a.title } });
        }
        return ops;
      },
    },
    draftSection: {
      description:
        "Draft one spec section BEYOND the required slots — the spec's own material, or a subsection under a " +
        "slot. Born ai-draft, awaiting human restatement. `markdown` is the section body (full block Markdown). " +
        "`depth` is the outline level: 0 is a top-level section, 1 a subsection of the section above it (it may " +
        "not skip a level). Appends unless `afterId` names an existing section to insert immediately after — " +
        "which is how you put a subsection under its parent.",
      args: zodSchema(
        z.object({
          title: z.string(),
          markdown: z.string(),
          afterId: z.string().optional(),
          depth: z.number().int().min(0).optional(),
        }),
      ),
      result: zodSchema(z.object({ sectionId: z.string() })),
      target: { section: "sections", field: "items" },
      produces: (page, args, ctx) => {
        const a = args as { title: string; markdown: string; afterId?: string; depth?: number };
        const elements = listOf(page, "sections", "items");
        let index = elements.length;
        if (a.afterId !== undefined) {
          const at = elements.findIndex((e) => e.id === a.afterId);
          if (at === -1) throw new InvariantViolationError(`afterId "${a.afterId}" is not a section on this page`);
          // Land after the whole subtree, so "after X" never lands inside X's children.
          index = subtreeRange(elements, at).end;
        }
        const depth = a.depth ?? 0;
        requireLegalDepth(elements, index, depth);
        return [
          {
            op: "addElement",
            section: "sections",
            field: "items",
            id: ctx.newId(),
            fields: sectionFields(a.title, a.markdown, ctx.newId, depth, ""),
            ...(index !== elements.length ? { index } : {}),
          },
        ];
      },
    },
    indentSection: {
      description:
        "Make a section a SUBSECTION of the one above it — it and its own subsections all shift one level " +
        "deeper. Pure structure: no content changes and a human-verified section stays verified. Refused when " +
        "it would skip a heading level (nothing above to nest under) or on a required-slot section, which " +
        "stays top-level.",
      args: zodSchema(z.object({ sectionId: z.string() })),
      target: { section: "sections", field: "items" },
      produces: (page, args) => {
        const a = args as { sectionId: string };
        const elements = listOf(page, "sections", "items");
        const { index, el } = sectionAt(page, a.sectionId);
        if (slotOf(el).length > 0) {
          throw new InvariantViolationError(
            `"${titleOf(el)}" fills the required "${slotTitle.get(slotOf(el)) ?? slotOf(el)}" slot and stays a top-level section`,
          );
        }
        requireLegalDepth(elements, index, depthOf(el) + 1);
        const { start, end } = subtreeRange(elements, index);
        return elements.slice(start, end).map((s) => setDepth(s.id, depthOf(s) + 1));
      },
    },
    outdentSection: {
      description:
        "Promote a subsection one level toward the top — it and its own subsections all shift one level " +
        "shallower. Sections that followed it at its old depth become its children. Pure structure: verified " +
        "sections stay verified. Refused on a section already at the top level.",
      args: zodSchema(z.object({ sectionId: z.string() })),
      target: { section: "sections", field: "items" },
      produces: (page, args) => {
        const a = args as { sectionId: string };
        const elements = listOf(page, "sections", "items");
        const { index, el } = sectionAt(page, a.sectionId);
        if (depthOf(el) === 0) throw new InvariantViolationError(`"${titleOf(el)}" is already a top-level section`);
        const { start, end } = subtreeRange(elements, index);
        return elements.slice(start, end).map((s) => setDepth(s.id, depthOf(s) - 1));
      },
    },
    restateSections: {
      description:
        "THE human accept (studio only — never call as the drafting agent): atomically replace the sections " +
        "named in `removeIds` with the human's restated `sections`, which are born human-verified. The new run " +
        "sits where the first removed section sat; an empty `sections` is a deliberate removal/shortening. " +
        "Fails loudly when a removeId no longer exists (a concurrent edit won the race).",
      args: zodSchema(z.object({ removeIds: z.array(z.string()).min(1), sections: z.array(sectionInput) })),
      target: { section: "sections", field: "items" },
      produces: (page, args, ctx) => {
        const a = args as { removeIds: string[]; sections: { title: string; markdown: string; depth?: number }[] };
        const elements = listOf(page, "sections", "items");
        const byId = new Map(elements.map((e) => [e.id, e]));
        const missing = a.removeIds.filter((id) => !byId.has(id));
        if (missing.length > 0) {
          // Deliberate OCC conflict surfacing: after a rebase, a vanished section must FAIL.
          throw new InvariantViolationError(`removeIds not found in sections.items: ${missing.join(", ")}`);
        }
        // A required slot may be reworded and re-nested, never dropped: its tag rides onto
        // the replacement that takes its place in the run.
        const slots = a.removeIds.map((id) => slotOf(byId.get(id)!)).filter((s) => s.length > 0);
        if (slots.length > a.sections.length) {
          throw new InvariantViolationError(
            `this restatement would drop required slot(s): ${slots
              .slice(a.sections.length)
              .map((s) => slotTitle.get(s) ?? s)
              .join(", ")} — restate slot sections one run at a time`,
          );
        }
        const removing = new Set(a.removeIds);
        const firstIdx = elements.findIndex((e) => removing.has(e.id));
        const insertAt = elements.slice(0, firstIdx).filter((e) => !removing.has(e.id)).length;
        const kept = elements.filter((e) => !removing.has(e.id));
        const ops: SectionOp[] = a.removeIds.map((id) => ({ op: "removeElement", section: "sections", field: "items", id }));
        // Depths default to the run's original first section, so a plain reword keeps its place.
        const fallback = depthOf(byId.get(a.removeIds[0]!)!);
        // Walk the resulting run, so each new section's legal ceiling is its real predecessor:
        // the last kept section before the insert point, then each new section in turn.
        const before = insertAt > 0 ? kept[insertAt - 1] : undefined;
        let prevDepth = before === undefined ? -1 : depthOf(before);
        a.sections.forEach((s, i) => {
          const depth = slots[i] !== undefined ? 0 : (s.depth ?? fallback);
          if (depth > prevDepth + 1) {
            throw new InvariantViolationError(
              `"${s.title}" at depth ${depth} skips a level — the deepest legal depth there is ${prevDepth + 1}`,
            );
          }
          prevDepth = depth;
          ops.push({
            op: "addElement",
            section: "sections",
            field: "items",
            id: ctx.newId(),
            fields: sectionFields(s.title, s.markdown, ctx.newId, depth, slots[i] ?? ""),
            status: "human-verified",
            index: insertAt + i,
          });
        });
        return ops;
      },
    },
    acceptSections: {
      description:
        "HUMAN sign-off only (studio — never call as an agent, on the user's behalf or otherwise): accept " +
        "the named ai-draft sections AS-IS, with no restatement. Reading the draft and judging it correct " +
        "as written IS the verification; each section flips to human-verified with no content change. " +
        "Fails loudly when an id is missing or not ai-draft.",
      args: zodSchema(z.object({ sectionIds: z.array(z.string()).min(1) })),
      target: { section: "sections", field: "items" },
      preconditions: [activeRestatement("acceptSections")],
      produces: (page, args) => {
        const a = args as { sectionIds: string[] };
        requireSectionsInStatus(page, a.sectionIds, "ai-draft", "sections not ai-draft (already verified?)");
        return a.sectionIds.map(
          (id): SectionOp => ({ op: "transition", level: "element", section: "sections", field: "items", element: id, event: "verify" }),
        );
      },
    },
    unacceptSections: {
      description:
        "Human-driven UNDO of acceptance: send the named human-verified sections back to ai-draft with NO " +
        "content changes (they rejoin the restatement queue). An agent wanting to change verified content " +
        "uses reviseSection instead. Fails loudly when an id is missing or not human-verified.",
      args: zodSchema(z.object({ sectionIds: z.array(z.string()).min(1) })),
      target: { section: "sections", field: "items" },
      preconditions: [activeRestatement("unacceptSections")],
      produces: (page, args) => {
        const a = args as { sectionIds: string[] };
        requireSectionsInStatus(page, a.sectionIds, "human-verified", "sections not human-verified");
        return a.sectionIds.map(
          (id): SectionOp => ({ op: "transition", level: "element", section: "sections", field: "items", element: id, event: "reviseAsDraft" }),
        );
      },
    },
    reviseSection: {
      description:
        "AI/system edit of an existing section's body (and optionally title). A human-verified section is " +
        "honestly downgraded to ai-draft in the same commit — it must be re-verified by restatement.",
      args: zodSchema(z.object({ sectionId: z.string(), title: z.string().optional(), markdown: z.string() })),
      target: { section: "sections", field: "items" },
      produces: (page, args, ctx) => {
        const a = args as { sectionId: string; title?: string; markdown: string };
        const el = listOf(page, "sections", "items").find((e) => e.id === a.sectionId);
        if (el === undefined) throw new InvariantViolationError(`section "${a.sectionId}" not found in sections.items`);
        const ops: SectionOp[] = [];
        if (el.status === "human-verified") {
          // Opens the element write-gate for the edits after it (per-op sequential evaluation).
          ops.push({ op: "transition", level: "element", section: "sections", field: "items", element: a.sectionId, event: "reviseAsDraft" });
        }
        ops.push({
          op: "setElementField",
          section: "sections",
          field: "items",
          id: a.sectionId,
          elementField: "body",
          value: { kind: "blocks", blocks: parseBlocks(a.markdown, ctx.newId) },
        });
        if (a.title !== undefined) {
          ops.push({ op: "setElementField", section: "sections", field: "items", id: a.sectionId, elementField: "title", value: { kind: "prose", value: a.title } });
        }
        return ops;
      },
    },
    addSection: {
      description:
        "HUMAN authoring (studio only — the drafting agent uses draftSection): insert a section the human " +
        "WROTE, born human-verified because their own words ARE the verification. Appends unless `beforeId` " +
        "names an existing section to insert immediately before (that anchors the position to an id, so a " +
        "concurrent insert elsewhere can't shift it).",
      args: zodSchema(
        z.object({
          title: z.string().min(1),
          markdown: z.string().min(1),
          beforeId: z.string().optional(),
          depth: z.number().int().min(0).optional(),
        }),
      ),
      result: zodSchema(z.object({ sectionId: z.string() })),
      target: { section: "sections", field: "items" },
      preconditions: [activeRestatement("addSection")],
      produces: (page, args, ctx) => {
        const a = args as { title: string; markdown: string; beforeId?: string; depth?: number };
        const elements = listOf(page, "sections", "items");
        const index = a.beforeId === undefined ? elements.length : sectionAt(page, a.beforeId).index;
        const depth = a.depth ?? 0;
        requireLegalDepth(elements, index, depth);
        return [
          {
            op: "addElement",
            section: "sections",
            field: "items",
            id: ctx.newId(),
            fields: sectionFields(a.title, a.markdown, ctx.newId, depth, ""),
            status: "human-verified",
            ...(index !== elements.length ? { index } : {}),
          },
        ];
      },
    },
    moveSection: {
      description:
        "Reorder: move a section — WITH its subsections, which travel as one block — to 0-based `toIndex` " +
        "among the sections remaining once the block is lifted out. Pure structure: no content and no status " +
        "change, so human-verified sections stay verified where they land. The block's depth is clamped to " +
        "what the destination allows (a subsection moved to the top of the spec becomes a top-level section), " +
        "so a move can never leave a skipped heading level behind.",
      args: zodSchema(z.object({ sectionId: z.string(), toIndex: z.number().int().min(0) })),
      target: { section: "sections", field: "items" },
      produces: (page, args) => {
        const a = args as { sectionId: string; toIndex: number };
        const elements = listOf(page, "sections", "items");
        const { index, el } = sectionAt(page, a.sectionId);
        const { start, end } = subtreeRange(elements, index);
        const block = elements.slice(start, end);
        const rest = elements.filter((e) => !block.includes(e));
        if (a.toIndex > rest.length) {
          throw new InvariantViolationError(`toIndex ${a.toIndex} is past the last position (${rest.length})`);
        }
        const before = a.toIndex > 0 ? rest[a.toIndex - 1] : undefined;
        const ceiling = before === undefined ? 0 : depthOf(before) + 1;
        const shift = Math.min(0, ceiling - depthOf(el));
        const ops = moveSubtreeOps(
          elements.map((e) => e.id),
          block.map((e) => e.id),
          a.toIndex,
        );
        if (shift !== 0) for (const s of block) ops.push(setDepth(s.id, depthOf(s) + shift));
        return ops;
      },
    },
    removeSection: {
      description:
        "Delete a section outright — the human's call that this content does not belong in the spec. Its " +
        "subsections go with it, and unlike join and split, which preserve one id, the ids are GONE: a " +
        "restatement in progress on any of them goes too. Refused on a required-slot section, and on any " +
        "section whose subtree holds one — a slot is an obligation, not a suggestion.",
      args: zodSchema(z.object({ sectionId: z.string() })),
      target: { section: "sections", field: "items" },
      preconditions: [activeRestatement("removeSection")],
      produces: (page, args) => {
        const a = args as { sectionId: string };
        const elements = listOf(page, "sections", "items");
        const { index } = sectionAt(page, a.sectionId);
        const { start, end } = subtreeRange(elements, index);
        const block = elements.slice(start, end);
        const slotted = block.filter((s) => slotOf(s).length > 0);
        if (slotted.length > 0) {
          throw new InvariantViolationError(
            `this would delete required slot(s): ${slotted
              .map((s) => slotTitle.get(slotOf(s)) ?? slotOf(s))
              .join(", ")} — a required section can be reworded or emptied, never removed`,
          );
        }
        return block.map((s): SectionOp => ({ op: "removeElement", section: "sections", field: "items", id: s.id }));
      },
    },
    joinSections: {
      description:
        "Merge `absorbId` INTO the section immediately before it: `sectionId` keeps its id, title and " +
        "position and its body gains the absorbed blocks; `absorbId` is removed. Ids survive on purpose — a " +
        "restatement in progress on the survivor outlives the join. Provenance stays honest: the survivor " +
        "keeps human-verified only when BOTH were verified; absorbing an ai-draft returns it to ai-draft.",
      args: zodSchema(z.object({ sectionId: z.string(), absorbId: z.string() })),
      target: { section: "sections", field: "items" },
      preconditions: [activeRestatement("joinSections")],
      produces: (page, args) => {
        const a = args as { sectionId: string; absorbId: string };
        const elements = listOf(page, "sections", "items");
        const { index, el } = sectionAt(page, a.sectionId);
        const absorbed = elements[index + 1];
        if (absorbed === undefined || absorbed.id !== a.absorbId) {
          throw new InvariantViolationError(
            `absorbId "${a.absorbId}" is not the section immediately after "${a.sectionId}" — join merges adjacent sections`,
          );
        }
        if (slotOf(absorbed).length > 0) {
          throw new InvariantViolationError(
            `"${titleOf(absorbed)}" fills the required "${slotTitle.get(slotOf(absorbed)) ?? slotOf(absorbed)}" slot — joining it away would drop that obligation`,
          );
        }
        if (subtreeRange(elements, index + 1).end > index + 2) {
          throw new InvariantViolationError(
            `"${titleOf(absorbed)}" has subsections of its own — they would be orphaned; join or outdent them first`,
          );
        }
        const stays = el.status === "human-verified" && absorbed.status === "human-verified";
        const ops = rewriteBody(a.sectionId, [...blocksOf(el), ...blocksOf(absorbed)], el.status === "human-verified");
        // Verified survivor + ai-draft absorbed: the merged body now holds unrestated text.
        if (el.status === "human-verified" && !stays) ops.pop();
        ops.push({ op: "removeElement", section: "sections", field: "items", id: a.absorbId });
        return ops;
      },
    },
    splitSection: {
      description:
        "Split one section in two: `sectionId` KEEPS its id, title, position and status but its body becomes " +
        "`topMarkdown`, and a new section titled `newTitle` holding `bottomMarkdown` is inserted immediately " +
        "after it, born with the SAME status (splitting your own verified words leaves both verified; " +
        "splitting an ai-draft leaves two ai-drafts). The surviving id means a restatement in progress on the " +
        "top half outlives the split. `asSubsection` makes the bottom half a SUBSECTION of the top rather " +
        "than its sibling — the split that turns one long section into a parent and its first child.",
      args: zodSchema(
        z.object({
          sectionId: z.string(),
          topMarkdown: z.string().min(1),
          bottomMarkdown: z.string().min(1),
          newTitle: z.string().min(1),
          asSubsection: z.boolean().optional(),
        }),
      ),
      result: zodSchema(z.object({ newSectionId: z.string() })),
      target: { section: "sections", field: "items" },
      preconditions: [activeRestatement("splitSection")],
      produces: (page, args, ctx) => {
        const a = args as {
          sectionId: string;
          topMarkdown: string;
          bottomMarkdown: string;
          newTitle: string;
          asSubsection?: boolean;
        };
        const { index, el } = sectionAt(page, a.sectionId);
        const depth = depthOf(el) + (a.asSubsection === true ? 1 : 0);
        const ops = rewriteBody(a.sectionId, parseBlocks(a.topMarkdown, ctx.newId), el.status === "human-verified");
        ops.push({
          op: "addElement",
          section: "sections",
          field: "items",
          id: ctx.newId(),
          // The bottom half never inherits the slot: the top keeps the obligation.
          fields: sectionFields(a.newTitle, a.bottomMarkdown, ctx.newId, depth, ""),
          ...(el.status !== undefined ? { status: el.status } : {}),
          index: index + 1,
        });
        return ops;
      },
    },
    recordHolisticReview: {
      description:
        "Record the holistic AI review — summary plus notes (born open) — and fire the page's " +
        "requestHolisticReview transition to reviewing, all in ONE commit. Requires every section human-verified.",
      args: zodSchema(z.object({ summary: z.string(), notes: z.array(noteInput) })),
      target: { section: "review" },
      // Content first: an unrestated spec's real problem is the ai-draft sections, not the
      // status it hasn't reached because of them.
      preconditions: [allSectionsVerified, inRestated],
      produces: (_page, args, ctx) => {
        const a = args as { summary: string; notes: { title: string; markdown: string; severity: string }[] };
        const ops: SectionOp[] = [{ op: "setField", section: "review", field: "summary", value: { kind: "prose", value: a.summary } }];
        for (const n of a.notes) {
          ops.push({
            op: "addElement",
            section: "review",
            field: "notes",
            id: ctx.newId(),
            fields: { ...bodyFields(n.title, n.markdown, ctx.newId), severity: { kind: "scalar", value: n.severity } },
          });
        }
        ops.push({ op: "transition", level: "page", event: "requestHolisticReview" });
        return ops;
      },
    },
    rerunHolisticReview: {
      description:
        "Re-run the holistic review while reviewing (after sections changed): replaces the summary and every " +
        "still-open note with fresh ones; resolved notes are kept as history. Requires every section " +
        "human-verified again. No page transition.",
      args: zodSchema(z.object({ summary: z.string(), notes: z.array(noteInput) })),
      target: { section: "review" },
      preconditions: [inReviewing, allSectionsVerified],
      produces: (page, args, ctx) => {
        const a = args as { summary: string; notes: { title: string; markdown: string; severity: string }[] };
        const ops: SectionOp[] = listOf(page, "review", "notes")
          .filter((n) => n.status === "open")
          .map((n): SectionOp => ({ op: "removeElement", section: "review", field: "notes", id: n.id }));
        ops.push({ op: "setField", section: "review", field: "summary", value: { kind: "prose", value: a.summary } });
        for (const n of a.notes) {
          ops.push({
            op: "addElement",
            section: "review",
            field: "notes",
            id: ctx.newId(),
            fields: { ...bodyFields(n.title, n.markdown, ctx.newId), severity: { kind: "scalar", value: n.severity } },
          });
        }
        return ops;
      },
    },
    resolveNote: {
      description: "Resolve one open review note, optionally recording how it was addressed.",
      args: zodSchema(z.object({ noteId: z.string(), resolution: z.string().optional() })),
      target: { section: "review", field: "notes" },
      produces: (page, args) => {
        const a = args as { noteId: string; resolution?: string };
        const note = listOf(page, "review", "notes").find((n) => n.id === a.noteId);
        if (note === undefined) throw new InvariantViolationError(`review note "${a.noteId}" not found in review.notes`);
        const ops: SectionOp[] = [];
        if (a.resolution !== undefined) {
          ops.push({ op: "setElementField", section: "review", field: "notes", id: a.noteId, elementField: "resolution", value: { kind: "prose", value: a.resolution } });
        }
        ops.push({ op: "transition", level: "element", section: "review", field: "notes", element: a.noteId, event: "resolve" });
        return ops;
      },
    },
    submitForRestatement: {
      description:
        "Declare the AI draft complete and hand the spec to the human for restatement. Refused until the " +
        "rubric holds: every required slot authored, the data-model slot carrying actual types, the " +
        "invariants slot a list, and every `(see X)` naming a section that exists.",
      args: zodSchema(empty),
      transition: { level: "page", event: "submitForRestatement" },
      preconditions: [slotsCovered, slotShape, citationsResolve],
    },
    completeRestatement: {
      description:
        "Move a fully-restated spec to `restated`. Rarely needed by hand: the engine fires this edge itself in " +
        "the commit that verifies the last section, and the opposite one when a section goes back to ai-draft. " +
        "It exists for a page that was ALREADY complete before the derived status did — one call catches it up.",
      args: zodSchema(empty),
      transition: { level: "page", event: "completeRestatement" },
      preconditions: [allSectionsVerified],
    },
    approve: {
      description:
        "Human sign-off: accept the reviewed spec. Refused while any review note is still open, or if the " +
        "restatement pass left the rubric unmet — sections get merged and renamed during review, so coverage " +
        "and citations are checked again here.",
      args: zodSchema(empty),
      transition: { level: "page", event: "approve" },
      preconditions: [noOpenNotes, slotsCovered, slotShape, citationsResolve],
    },
    reopenRestating: {
      description: "Escape from reviewing back to restating (e.g. the review invalidated the restatement pass).",
      args: zodSchema(empty),
      transition: { level: "page", event: "reopenRestating" },
    },
    reopen: {
      description: "Reopen an approved spec for another restatement/review cycle.",
      args: zodSchema(empty),
      transition: { level: "page", event: "reopen" },
    },
  },
  render: {
    title: "Spec: {title}",
    graphSections: false,
    sections: [
      {
        section: "sections",
        heading: "Sections",
        field: "items",
        // ALL sections render in stored order regardless of status — the deterministic
        // Markdown is a clean spec; provenance styling is browser-side.
        as: "sections",
        numbered: false,
        // The flat ordered list renders as a heading hierarchy: depth 0 → `###`, 1 → `####`.
        depthField: "depth",
        placeholder: "_No sections drafted._",
        element: { heading: "{title}", body: [{ field: "body" }] },
      },
      { section: "review", heading: "Review", field: "summary", as: "block", placeholder: "_Not reviewed._" },
      {
        section: "review",
        field: "notes",
        as: "sections",
        numbered: false,
        groupBy: "status",
        groups: [{ when: "open", heading: "Open notes" }],
        element: { heading: "{title} ({severity})", body: [{ field: "body" }] },
      },
    ],
  },
});
