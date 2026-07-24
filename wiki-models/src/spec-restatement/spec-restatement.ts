/**
 * `spec-restatement` page type. An AI drafts a spec as an ordered list of sections; a
 * human proves understanding by RESTATING sections in their own words (a wiki-ui studio
 * drives `restateSections`); accepted restatements atomically replace the AI sections and
 * are born `human-verified`. When every section is verified, a holistic AI review records
 * notes; the human fixes/resolves and approves. Provenance is the element FSM
 * (`ai-draft` ↔ `human-verified`), enforced by the element write-gate: an AI edit must
 * downgrade a verified section back to `ai-draft` before touching its content.
 */
import type { DeepReadonly, IBlock, IField, IItem, PageState, Precondition, SectionOp } from "wiki/authoring";
import { definePageType, InvariantViolationError, parseBlocks, t, z, zodSchema } from "wiki/authoring";

const empty = z.object({});

const SEVERITIES = ["minor", "major", "critical"] as const;
const severityArg = z.enum(SEVERITIES);

const sectionInput = z.object({ title: z.string(), markdown: z.string() });
const noteInput = z.object({ title: z.string(), markdown: z.string(), severity: severityArg });

function listOf(page: DeepReadonly<PageState>, sectionKey: string, fieldKey: string): readonly DeepReadonly<IItem>[] {
  const f = page.sections.find((s) => s.key === sectionKey)?.fields[fieldKey];
  return f !== undefined && f.kind === "list" ? f.elements : [];
}

function titleOf(el: DeepReadonly<IItem>): string {
  const f = el.fields["title"];
  return f !== undefined && f.kind === "prose" && f.value.length > 0 ? f.value : el.id;
}

/** A spec-section / review-note's creation-time fields (body reified via parseBlocks). */
function bodyFields(title: string, markdown: string, newId: () => string): Record<string, IField> {
  return {
    title: { kind: "prose", value: title },
    body: { kind: "blocks", blocks: parseBlocks(markdown, newId) },
  };
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

const inRestating: Precondition = (page) =>
  page.status === "restating"
    ? true
    : { unmet: `requestHolisticReview fires from "restating" (page is "${page.status}"); while reviewing use rerunHolisticReview` };

const inReviewing: Precondition = (page) =>
  page.status === "reviewing" ? true : { unmet: `rerunHolisticReview runs while "reviewing" (page is "${page.status}")` };

const noOpenNotes: Precondition = (page) => {
  const open = listOf(page, "review", "notes").filter((n) => n.status === "open");
  return open.length === 0 ? true : { unmet: `resolve the open review notes first: ${open.map(titleOf).join(", ")}` };
};

const activeRestatement =
  (command: string): Precondition =>
  (page) =>
    page.status === "restating" || page.status === "reviewing"
      ? true
      : { unmet: `${command} runs while "restating" or "reviewing" (page is "${page.status}")` };

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

const hasDraftedSections: Precondition = (page) =>
  listOf(page, "sections", "items").length > 0
    ? true
    : { unmet: "draft at least one section before submitting for restatement" };

export const SpecRestatement = definePageType({
  type: "spec-restatement",
  label: "Spec restatement",
  description:
    "A spec drafted by an AI and proven understood by a human who RESTATES each section in their own words. " +
    "Workflow: drafting → restating → reviewing → approved. As the drafting agent: draft an \"Overview\" as the " +
    "FIRST section via `draftSection` (a normal spec-section titled \"Overview\" — it gets restated and " +
    "verified like every other section), then the ordered body sections (each is born `ai-draft`), and call " +
    "`submitForRestatement` when the draft is complete. NEVER mark a section human-verified yourself — " +
    "verification happens only through a human's `restateSections` in the studio, which atomically replaces " +
    "AI sections with the human's restatement (born `human-verified`). Once every section is verified, " +
    "`recordHolisticReview` files the AI's holistic notes and moves the page to reviewing; use " +
    "`reviseSection`/`resolveNote`/`rerunHolisticReview` in the fix loop, and stop at the human `approve` gate.",
  version: 1,
  initialStatus: "drafting",
  statusTransitions: [
    t("drafting", "submitForRestatement", "restating", { agency: "agent" }),
    t("restating", "requestHolisticReview", "reviewing", {
      agency: "human",
      description:
        "Fired only via the recordHolisticReview command, which records the review summary and notes in the same commit.",
    }),
    t("reviewing", "approve", "approved", { agency: "human" }),
    t("reviewing", "reopenRestating", "restating"),
    t("approved", "reopen", "restating", { agency: "human" }),
  ],
  sections: {
    sections: {
      name: "Sections",
      required: true,
      // reviewing included so the note-fix loop (restate/revise) works in one state.
      mutableIn: ["drafting", "restating", "reviewing"],
      fields: { items: { kind: "list", element: "spec-section", ordered: true } },
    },
    review: {
      name: "Review",
      required: true,
      // restating REQUIRED: recordHolisticReview's content ops evaluate in the FROM status.
      mutableIn: ["restating", "reviewing"],
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
      },
      status: {
        initial: "ai-draft",
        transitions: [t("ai-draft", "verify", "human-verified"), t("human-verified", "reviseAsDraft", "ai-draft")],
      },
      // Content edits only while ai-draft: an edit of a verified section must downgrade first.
      mutableIn: ["ai-draft"],
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
    draftSection: {
      description:
        "Draft one spec section (born ai-draft, awaiting human restatement). `markdown` is the section body " +
        "(full block Markdown). Appends unless `afterId` names an existing section to insert immediately after.",
      args: zodSchema(z.object({ title: z.string(), markdown: z.string(), afterId: z.string().optional() })),
      result: zodSchema(z.object({ sectionId: z.string() })),
      target: { section: "sections", field: "items" },
      produces: (page, args, ctx) => {
        const a = args as { title: string; markdown: string; afterId?: string };
        let index: number | undefined;
        if (a.afterId !== undefined) {
          const at = listOf(page, "sections", "items").findIndex((e) => e.id === a.afterId);
          if (at === -1) throw new InvariantViolationError(`afterId "${a.afterId}" is not a section on this page`);
          index = at + 1;
        }
        return [
          {
            op: "addElement",
            section: "sections",
            field: "items",
            id: ctx.newId(),
            fields: bodyFields(a.title, a.markdown, ctx.newId),
            ...(index !== undefined ? { index } : {}),
          },
        ];
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
        const a = args as { removeIds: string[]; sections: { title: string; markdown: string }[] };
        const elements = listOf(page, "sections", "items");
        const present = new Set(elements.map((e) => e.id));
        const missing = a.removeIds.filter((id) => !present.has(id));
        if (missing.length > 0) {
          // Deliberate OCC conflict surfacing: after a rebase, a vanished section must FAIL.
          throw new InvariantViolationError(`removeIds not found in sections.items: ${missing.join(", ")}`);
        }
        const removing = new Set(a.removeIds);
        const firstIdx = elements.findIndex((e) => removing.has(e.id));
        const insertAt = elements.slice(0, firstIdx).filter((e) => !removing.has(e.id)).length;
        const ops: SectionOp[] = a.removeIds.map((id) => ({ op: "removeElement", section: "sections", field: "items", id }));
        a.sections.forEach((s, i) => {
          ops.push({
            op: "addElement",
            section: "sections",
            field: "items",
            id: ctx.newId(),
            fields: bodyFields(s.title, s.markdown, ctx.newId),
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
      args: zodSchema(z.object({ title: z.string().min(1), markdown: z.string().min(1), beforeId: z.string().optional() })),
      result: zodSchema(z.object({ sectionId: z.string() })),
      target: { section: "sections", field: "items" },
      preconditions: [activeRestatement("addSection")],
      produces: (page, args, ctx) => {
        const a = args as { title: string; markdown: string; beforeId?: string };
        const index = a.beforeId === undefined ? undefined : sectionAt(page, a.beforeId).index;
        return [
          {
            op: "addElement",
            section: "sections",
            field: "items",
            id: ctx.newId(),
            fields: bodyFields(a.title, a.markdown, ctx.newId),
            status: "human-verified",
            ...(index !== undefined ? { index } : {}),
          },
        ];
      },
    },
    moveSection: {
      description:
        "Reorder: move a section to 0-based `toIndex` among sections.items (the index it lands on once " +
        "lifted out). Pure structure — no content and no status change, so a human-verified section stays " +
        "verified where it lands.",
      args: zodSchema(z.object({ sectionId: z.string(), toIndex: z.number().int().min(0) })),
      target: { section: "sections", field: "items" },
      produces: (page, args) => {
        const a = args as { sectionId: string; toIndex: number };
        const { index } = sectionAt(page, a.sectionId);
        const last = listOf(page, "sections", "items").length - 1;
        if (a.toIndex > last) {
          throw new InvariantViolationError(`toIndex ${a.toIndex} is past the last section (${last})`);
        }
        if (a.toIndex === index) return [];
        return [{ op: "moveElement", section: "sections", field: "items", id: a.sectionId, toIndex: a.toIndex }];
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
        const { index, el } = sectionAt(page, a.sectionId);
        const absorbed = listOf(page, "sections", "items")[index + 1];
        if (absorbed === undefined || absorbed.id !== a.absorbId) {
          throw new InvariantViolationError(
            `absorbId "${a.absorbId}" is not the section immediately after "${a.sectionId}" — join merges adjacent sections`,
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
        "top half outlives the split.",
      args: zodSchema(
        z.object({
          sectionId: z.string(),
          topMarkdown: z.string().min(1),
          bottomMarkdown: z.string().min(1),
          newTitle: z.string().min(1),
        }),
      ),
      result: zodSchema(z.object({ newSectionId: z.string() })),
      target: { section: "sections", field: "items" },
      preconditions: [activeRestatement("splitSection")],
      produces: (page, args, ctx) => {
        const a = args as { sectionId: string; topMarkdown: string; bottomMarkdown: string; newTitle: string };
        const { index, el } = sectionAt(page, a.sectionId);
        const ops = rewriteBody(a.sectionId, parseBlocks(a.topMarkdown, ctx.newId), el.status === "human-verified");
        ops.push({
          op: "addElement",
          section: "sections",
          field: "items",
          id: ctx.newId(),
          fields: bodyFields(a.newTitle, a.bottomMarkdown, ctx.newId),
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
      preconditions: [inRestating, allSectionsVerified],
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
      description: "Declare the AI draft complete and hand the spec to the human for restatement.",
      args: zodSchema(empty),
      transition: { level: "page", event: "submitForRestatement" },
      preconditions: [hasDraftedSections],
    },
    approve: {
      description: "Human sign-off: accept the reviewed spec. Refused while any review note is still open.",
      args: zodSchema(empty),
      transition: { level: "page", event: "approve" },
      preconditions: [noOpenNotes],
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
