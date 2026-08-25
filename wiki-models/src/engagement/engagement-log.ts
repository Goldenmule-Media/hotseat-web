/**
 * `engagement-log` page type — ONE ongoing thread with a counterparty, as a dated log.
 *
 * One page per person, meeting series, vendor, candidate, org or event; the page
 * accumulates reverse-chronological `entry` elements. This deliberately COLLAPSES what
 * look like four genres — a 1-on-1, a recurring meeting, a vendor relationship, an
 * interview loop — because they are one shape. The evidence is the author's own note
 * templates: `Meeting` is `date / Notes / Action items`, and `Meeting with Prep`,
 * `Meeting with External` and `1 on 1` each ADD one part to that same skeleton. Four
 * nested variants of one form are one page type with optional parts, not four types.
 *
 * Shape:
 *  - subject     — what this thread IS (kind / org / role); `kind` drives nothing in the
 *                  engine, it is the facet a reader filters on.
 *  - context     — who they are and why the thread exists (prose).
 *  - standing    — the persistent header that is NOT an entry: a roster, a meeting
 *                  format, a career path, a profile.
 *  - onDeck      — carry-forward agenda: `prompt` elements that survive across entries
 *                  until ticked. `awaitsHuman` while unanswered — an On Deck item is a
 *                  thing to raise with a person, which only the human can do.
 *  - entries     — the log itself, NEWEST FIRST (see the ordering note below).
 *  - actionItems — commitments, page-level (see the nesting note below).
 *  - outcome     — the disposition, required to leave `active` via `decide`.
 *  - provenance  — where an imported page came from, so a re-import can find it again.
 *
 * Lifecycle: `active` →(decide)→ `decided` →(reopen)→ `active`; `active` →(supersede)→
 * `superseded`. EVERY edge is a human edge and none is `agency: "agent"` — there is no
 * forward edge an agent can drive, because the way this page progresses is that a human
 * has a conversation. A self-loop `recordEntry` edge would make the self-directing loop
 * spin, inventing meetings that never happened; recording an entry is a content command
 * with no transition at all. Retiring a thread is `archivePage`, not a status.
 *
 * ACTION ITEMS ARE PAGE-LEVEL, NOT PER-ENTRY. The engine's `addElement` op targets a
 * `(section, field)` pair, so an element cannot own a growable list of sub-elements —
 * `entry.actionItems` is not expressible. Each `action-item` therefore carries an `on`
 * scalar naming the entry date it came from. This is the better model anyway: the
 * question worth asking is "what have I got outstanding across every thread?", which a
 * page-level list answers and a per-entry nesting would bury. `attendees` is a scalar on
 * the entry for the same structural reason, and because the source notes write attendees
 * as a freeform name list rather than a roster of typed people.
 *
 * NEWEST FIRST IS STORAGE ORDER. Render has no reverse/sort knob — a list renders in the
 * order it is stored — so `recordEntry` inserts at index 0 rather than appending, and an
 * importer must add a file's entries newest-first. Reading a log newest-first is the
 * whole point: the current state of a relationship is the top of the page.
 */
import type { DeepReadonly, DerivedItem, DerivedList, IField, PageState, SectionOp } from "wiki/authoring";
import { arg, definePageType, parseBlocks, t } from "wiki/authoring";
import { z, zodSchema } from "wiki/authoring";

const empty = z.object({});

// Content is authorable while the thread is live or concluded (a concluded thread still
// takes a late follow-up); a superseded page is a pointer and freezes.
const editable = ["active", "decided"];

/** What the thread is with. A facet for reading, not an engine concept. */
const subjectKind = z.enum(["person", "series", "org", "vendor", "candidate", "event", "client"]);

/** How a thread ended. `requiredIn: ["decided"]` makes the engine refuse `decide` without it. */
const disposition = z.enum(["engage", "pass", "hire", "no-hire", "revisit", "concluded"]);

// ────────────────────────────────────────────────────────────────────────────
// Pure read helpers over folded state
// ────────────────────────────────────────────────────────────────────────────

function fieldsOf(page: DeepReadonly<PageState>, sectionKey: string): DeepReadonly<Record<string, IField>> {
  return page.sections.find((s) => s.key === sectionKey)?.fields ?? {};
}

function scalarOf(fields: DeepReadonly<Record<string, IField>>, key: string): string {
  const f = fields[key];
  return f !== undefined && f.kind === "scalar" ? String(f.value) : "";
}

/** One bullet per present subject facet, empties omitted. Deterministic. */
const subjectRows: DerivedList = (page) => {
  const subject = fieldsOf(page, "subject");
  const rows: DerivedItem[] = [];
  const kind = scalarOf(subject, "kind");
  const org = scalarOf(subject, "org");
  const role = scalarOf(subject, "role");
  if (kind.length > 0) rows.push({ id: "kind", text: `**Kind:** ${kind}` });
  if (org.length > 0) rows.push({ id: "org", text: `**Org:** ${org}` });
  if (role.length > 0) rows.push({ id: "role", text: `**Role:** ${role}` });
  return rows;
};

/** The disposition + its note, once decided. */
const outcomeRows: DerivedList = (page) => {
  const outcome = fieldsOf(page, "outcome");
  const rows: DerivedItem[] = [];
  const call = scalarOf(outcome, "disposition");
  const note = scalarOf(outcome, "note");
  if (call.length > 0) rows.push({ id: "disposition", text: `**Disposition:** ${call}` });
  if (note.length > 0) rows.push({ id: "note", text: note });
  return rows;
};

export const EngagementLog = definePageType({
  type: "engagement-log",
  label: "Engagement log",
  description:
    "ONE ongoing thread with a counterparty — a person, a recurring meeting, a vendor, a candidate, an " +
    "org or an event — as a reverse-chronological log of dated entries, with carry-forward agenda items " +
    "and the commitments that came out of them. Use it for anything you meet about repeatedly; use a " +
    "`document` for a one-off note that will never gain a second entry.",
  version: 1,
  initialStatus: "active",
  statusTransitions: [
    // No agent edges: a thread moves forward because a human talked to someone.
    t("active", "decide", "decided"),
    t("decided", "reopen", "active"),
    t("active", "supersede", "superseded"),
  ],
  sections: {
    subject: {
      name: "Subject",
      required: true,
      mutableIn: editable,
      fields: {
        kind: { kind: "scalar", required: true, schema: zodSchema(subjectKind) },
        org: { kind: "scalar" },
        role: { kind: "scalar" },
      },
    },
    context: {
      name: "Context",
      required: true,
      mutableIn: editable,
      fields: { body: { kind: "prose" } },
    },
    standing: {
      name: "Standing",
      required: true,
      mutableIn: editable,
      fields: { body: { kind: "blocks" } },
    },
    onDeck: {
      name: "On deck",
      required: true,
      mutableIn: editable,
      fields: { items: { kind: "list", element: "prompt", ordered: true } },
    },
    entries: {
      name: "Entries",
      required: true,
      mutableIn: editable,
      fields: { items: { kind: "list", element: "entry", ordered: true } },
    },
    actionItems: {
      name: "Action items",
      required: true,
      mutableIn: editable,
      fields: { items: { kind: "list", element: "action-item", ordered: true } },
    },
    outcome: {
      name: "Outcome",
      required: true,
      mutableIn: editable,
      fields: {
        // The engine refuses `decide` until this is authored, and refuses to blank it
        // while decided — the completeness gate, declared not hand-rolled.
        disposition: { kind: "scalar", requiredIn: ["decided"], schema: zodSchema(disposition) },
        note: { kind: "scalar" },
      },
    },
    provenance: {
      name: "Provenance",
      required: true,
      mutableIn: ["active", "decided", "superseded"],
      fields: {
        source: { kind: "scalar" },
        movedTo: { kind: "scalar", requiredIn: ["superseded"] },
      },
    },
  },
  elements: {
    entry: {
      fields: {
        date: { kind: "scalar", required: true },
        attendees: { kind: "scalar" },
        prep: { kind: "blocks" },
        notes: { kind: "blocks" },
      },
    },
    "action-item": {
      fields: {
        text: { kind: "prose", required: true },
        owner: { kind: "scalar" },
        due: { kind: "scalar" },
        // The entry this came out of. Provenance, not a ref: entries are elements, and an
        // element cannot be a ref target.
        on: { kind: "scalar" },
      },
      status: { initial: "open", transitions: [t("open", "complete", "done"), t("open", "drop", "dropped")] },
      awaitsHuman: (el) => el.status === "open",
    },
    prompt: {
      fields: { text: { kind: "prose", required: true } },
      status: { initial: "unanswered", transitions: [t("unanswered", "raise", "raised")] },
      awaitsHuman: (el) => el.status === "unanswered",
    },
  },
  sectionSet: { mode: "closed" },
  derived: {
    "subject-rows": subjectRows,
    "outcome-rows": outcomeRows,
  },
  commands: {
    // ── subject ──
    setKind: {
      args: zodSchema(z.object({ kind: subjectKind })),
      target: { section: "subject", field: "kind" },
      set: { kind: arg("kind") },
    },
    setOrg: {
      args: zodSchema(z.object({ org: z.string() })),
      target: { section: "subject", field: "org" },
      set: { org: arg("org") },
    },
    setRole: {
      args: zodSchema(z.object({ role: z.string() })),
      target: { section: "subject", field: "role" },
      set: { role: arg("role") },
    },
    setContext: {
      args: zodSchema(z.object({ text: z.string() })),
      target: { section: "context", field: "body" },
      set: { body: arg("text") },
    },

    // ── entries (newest first: insert at index 0, never append) ──
    recordEntry: {
      args: zodSchema(
        z.object({
          date: z.string(),
          attendees: z.string().optional(),
          prep: z.string().optional(),
          notes: z.string().optional(),
        }),
      ),
      result: zodSchema(z.object({ entryId: z.string() })),
      target: { section: "entries", field: "items" },
      description: "Log a dated entry at the TOP of the log. `prep`/`notes` take Markdown.",
      // `produces` rather than `set`, for the index: a log reads newest-first, and render
      // has no reverse knob, so position 0 is the model's job.
      produces: (_page, args, ctx): SectionOp[] => {
        const a = args as { date: string; attendees?: string; prep?: string; notes?: string };
        const fields: Record<string, IField> = { date: { kind: "scalar", value: a.date } };
        if (a.attendees !== undefined && a.attendees.length > 0) {
          fields["attendees"] = { kind: "scalar", value: a.attendees };
        }
        if (a.prep !== undefined && a.prep.length > 0) {
          fields["prep"] = { kind: "blocks", blocks: parseBlocks(a.prep, ctx.newId) };
        }
        if (a.notes !== undefined && a.notes.length > 0) {
          fields["notes"] = { kind: "blocks", blocks: parseBlocks(a.notes, ctx.newId) };
        }
        return [{ op: "addElement", section: "entries", field: "items", id: ctx.newId(), fields, index: 0 }];
      },
    },
    removeEntry: {
      args: zodSchema(z.object({ entryId: z.string() })),
      target: { section: "entries", field: "items" },
      produces: (_page, args) => [
        { op: "removeElement", section: "entries", field: "items", id: (args as { entryId: string }).entryId },
      ],
    },

    // ── on deck ──
    addOnDeck: {
      args: zodSchema(z.object({ text: z.string() })),
      result: zodSchema(z.object({ promptId: z.string() })),
      target: { section: "onDeck", field: "items" },
      set: { text: arg("text") },
    },
    raiseOnDeck: {
      args: zodSchema(z.object({ promptId: z.string() })),
      target: { section: "onDeck", field: "items", element: { idArg: "promptId" } },
      transition: { level: "element", event: "raise" },
    },
    removeOnDeck: {
      args: zodSchema(z.object({ promptId: z.string() })),
      target: { section: "onDeck", field: "items" },
      produces: (_page, args) => [
        { op: "removeElement", section: "onDeck", field: "items", id: (args as { promptId: string }).promptId },
      ],
    },

    // ── action items ──
    addActionItem: {
      args: zodSchema(
        z.object({
          text: z.string(),
          owner: z.string().optional(),
          due: z.string().optional(),
          on: z.string().optional(),
        }),
      ),
      result: zodSchema(z.object({ itemId: z.string() })),
      target: { section: "actionItems", field: "items" },
      set: { text: arg("text"), owner: arg("owner"), due: arg("due"), on: arg("on") },
    },
    completeActionItem: {
      args: zodSchema(z.object({ itemId: z.string() })),
      target: { section: "actionItems", field: "items", element: { idArg: "itemId" } },
      transition: { level: "element", event: "complete" },
    },
    dropActionItem: {
      args: zodSchema(z.object({ itemId: z.string() })),
      target: { section: "actionItems", field: "items", element: { idArg: "itemId" } },
      transition: { level: "element", event: "drop" },
    },

    // ── provenance ──
    setSource: {
      args: zodSchema(z.object({ source: z.string() })),
      target: { section: "provenance", field: "source" },
      set: { source: arg("source") },
    },

    // ── lifecycle ──
    // `decide` carries the disposition in the SAME atomic op list as the transition, so a
    // thread can never be concluded without saying how it concluded.
    decide: {
      args: zodSchema(z.object({ disposition, note: z.string().optional() })),
      target: { section: "outcome", field: "disposition" },
      // Two scalars in one section: a declarative `set` writes only the ONE targeted
      // field, so this drops to `produces` — which REPLACES the whole declarative effect,
      // the transition included, so the edge is fired as an op here. All three land in one
      // atomic op list, which is the point: a thread cannot be concluded without saying
      // how it concluded.
      produces: (_page, args): SectionOp[] => {
        const a = args as { disposition: string; note?: string };
        const ops: SectionOp[] = [
          { op: "setField", section: "outcome", field: "disposition", value: { kind: "scalar", value: a.disposition } },
        ];
        if (a.note !== undefined && a.note.length > 0) {
          ops.push({ op: "setField", section: "outcome", field: "note", value: { kind: "scalar", value: a.note } });
        }
        ops.push({ op: "transition", level: "page", event: "decide" });
        return ops;
      },
    },
    reopen: { args: zodSchema(empty), transition: { level: "page", event: "reopen" } },
    supersede: {
      args: zodSchema(z.object({ movedTo: z.string() })),
      target: { section: "provenance", field: "movedTo" },
      set: { movedTo: arg("movedTo") },
      transition: { level: "page", event: "supersede" },
    },
  },
  render: {
    title: "{title}",
    sections: [
      { derived: "subject-rows", heading: "Subject", placeholder: "_Unclassified._" },
      { section: "context", heading: "Context", field: "body", as: "block", placeholder: "_None._" },
      { section: "standing", heading: "Standing", field: "body", as: "blocks", placeholder: "_None._" },
      {
        section: "onDeck",
        heading: "On deck",
        field: "items",
        as: "checklist",
        checkedWhen: "raised",
        item: "{text}",
        placeholder: "_Nothing on deck._",
      },
      {
        section: "actionItems",
        heading: "Action items",
        field: "items",
        as: "checklist",
        checkedWhen: "done",
        item: "{text}",
        placeholder: "_None._",
      },
      {
        section: "entries",
        heading: "Entries",
        field: "items",
        as: "sections",
        numbered: false,
        element: {
          heading: "{date}",
          body: [
            { label: "Attendees", field: "attendees" },
            { label: "Prep", field: "prep" },
            { field: "notes" },
          ],
        },
        placeholder: "_No entries yet._",
      },
      { derived: "outcome-rows", heading: "Outcome", placeholder: "_Open._" },
    ],
  },
});
