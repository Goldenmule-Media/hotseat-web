/**
 * `toc` page type — a generated, curatable Table Of Contents of a page's own children.
 *
 * The list of entries is a DERIVED VIEW of `ctx.childrenOf(self)` (the `contents`
 * {@link DerivedList} below), so it is NEVER hand-duplicated and can't drift: add / move /
 * rename / remove a child and the TOC re-renders to match, with no write to the TOC page
 * (the same discipline as the implementation-checklist's "Plan steps").
 *
 * What the page stores is ONLY the value-add an automatic child list can't express:
 *  - `groups` — named buckets with an optional blurb, in display order;
 *  - `placement` — a child→group assignment + within-group order, keyed by child id.
 * Both are reconciled against the LIVE child set at render time, so a placement whose child
 * was reparented away (or whose group was removed) is silently ignored, an archived child
 * drops out entirely, and a brand-new child appears under "Ungrouped" until curated. Presentation-local ordering: reordering the
 * TOC never touches the actual page tree.
 */
import type {
  DeepReadonly,
  DerivedItem,
  DerivedList,
  IItem,
  IRenderCtx,
  PageId,
  PageState,
  SectionOp,
} from "wiki/authoring";
import { arg, definePageType } from "wiki/authoring";
import { z, zodSchema } from "wiki/authoring";

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

/**
 * The contents projection: the page's CURRENT children, bucketed by the stored `groups` +
 * `placement` curation. Renders as a flat list when there are no groups, else a nested list
 * (group rows at level 0, members at level 1, with a trailing "Ungrouped" bucket). Pure over
 * folded state + the render ctx — deterministic, recomputed every render.
 */
const contents: DerivedList = (page, ctx: IRenderCtx) => {
  const selfId = page.id as unknown as PageId;
  // Live children, minus any that are archived — an archived page is hidden from default
  // views, so the TOC must not surface it (it would otherwise render a dead link).
  const children = ctx.childrenOf(selfId).filter((c) => !ctx.archivedOf(c));
  const childSet = new Set<string>(children.map((c) => String(c)));
  const titleOf = (id: PageId | string): string => ctx.titleOf(id as PageId) ?? String(id);
  // A child entry is a Markdown link to the child page (href = its stable page id; label is
  // render-derived, so renames reflow). Group rows below are not pages, so they stay plain.
  const link = (id: PageId | string): string => `[${titleOf(id)}](${String(id)})`;

  const groups = listItems(page, "groups", "items");
  const placements = listItems(page, "placement", "items");

  // No curation yet → a flat TOC of every child (linked), in tree order.
  if (groups.length === 0) {
    return children.map((c) => ({ id: String(c), text: link(c) }));
  }

  const groupIds = new Set<string>(groups.map((g) => g.id));
  // child → groupId, ignoring placements for departed children / removed groups; first wins.
  const assigned = new Map<string, string>();
  for (const p of placements) {
    const child = fieldStr(p, "child");
    const group = fieldStr(p, "group");
    if (!childSet.has(child) || !groupIds.has(group) || assigned.has(child)) continue;
    assigned.set(child, group);
  }

  // Within-group order follows placement order (the curated order), filtered to valid rows.
  // `emitted` dedupes a child that has more than one placement entry (e.g. added via the
  // engine's auto-generated addElement command, which bypasses assignChild's update-in-place):
  // the `assigned` map already fixed one group per child, so render it at most once.
  const inGroup = new Map<string, string[]>();
  const emitted = new Set<string>();
  for (const p of placements) {
    const child = fieldStr(p, "child");
    const group = fieldStr(p, "group");
    if (assigned.get(child) !== group || emitted.has(child)) continue;
    emitted.add(child);
    const arr = inGroup.get(group) ?? [];
    arr.push(child);
    inGroup.set(group, arr);
  }

  const out: DerivedItem[] = [];
  for (const g of groups) {
    const title = fieldStr(g, "title") || "Untitled group";
    const blurb = fieldStr(g, "blurb");
    out.push({ id: g.id, level: 0, text: blurb.length > 0 ? `**${title}** — ${blurb}` : `**${title}**` });
    for (const child of inGroup.get(g.id) ?? []) {
      out.push({ id: child, level: 1, text: link(child) });
    }
  }
  // Children not (validly) placed in any group → a trailing bucket, in tree order.
  const ungrouped = children.filter((c) => !assigned.has(String(c)));
  if (ungrouped.length > 0) {
    out.push({ id: "@ungrouped", level: 0, text: "**Ungrouped**" });
    for (const c of ungrouped) out.push({ id: String(c), level: 1, text: link(c) });
  }
  return out;
};

export const Toc = definePageType({
  type: "toc",
  label: "Table of contents",
  description:
    "An index page that groups and links its child pages into a navigable overview (e.g. an Architecture " +
    "Overview or Decision Records index). Use it as a container/landing node that organizes other pages; it " +
    "holds no subject matter of its own.",
  version: 1,
  // A TOC has no lifecycle of its own — it's always curatable; structural archivePage
  // handles removal. Content edits are gated to the single `active` status via `mutableIn`.
  initialStatus: "active",
  statusTransitions: [],
  sections: {
    overview: {
      name: "Overview",
      required: true,
      mutableIn: ["active"],
      fields: { body: { kind: "prose" } },
    },
    groups: {
      name: "Groups",
      required: true,
      mutableIn: ["active"],
      fields: { items: { kind: "list", element: "group", ordered: true } },
    },
    placement: {
      name: "Placement",
      required: true,
      mutableIn: ["active"],
      fields: { items: { kind: "list", element: "entry", ordered: true } },
    },
  },
  elements: {
    group: {
      fields: { title: { kind: "prose", required: true }, blurb: { kind: "prose" } },
    },
    entry: {
      fields: { child: { kind: "scalar", required: true }, group: { kind: "scalar", required: true } },
    },
  },
  sectionSet: { mode: "closed" },
  derived: { contents },
  commands: {
    /** Set the lead paragraph shown above the contents. */
    setOverview: {
      args: zodSchema(z.object({ text: z.string() })),
      target: { section: "overview", field: "body" },
      set: { body: arg("text") },
    },
    /** Create a group (bucket). Returns the new group's id to assign children into. */
    addGroup: {
      args: zodSchema(z.object({ title: z.string() })),
      result: zodSchema(z.object({ groupId: z.string() })),
      target: { section: "groups", field: "items" },
      set: { title: arg("title") },
    },
    renameGroup: {
      args: zodSchema(z.object({ groupId: z.string(), title: z.string() })),
      target: { section: "groups", field: "items", element: { idArg: "groupId" } },
      set: { title: arg("title") },
    },
    setGroupBlurb: {
      args: zodSchema(z.object({ groupId: z.string(), blurb: z.string() })),
      target: { section: "groups", field: "items", element: { idArg: "groupId" } },
      set: { blurb: arg("blurb") },
    },
    moveGroup: {
      args: zodSchema(z.object({ groupId: z.string(), toIndex: z.number().int().min(0) })),
      target: { section: "groups", field: "items" },
      produces: (_page, args) => {
        const a = args as { groupId: string; toIndex: number };
        return [{ op: "moveElement", section: "groups", field: "items", id: a.groupId, toIndex: a.toIndex }];
      },
    },
    /** Remove a group and any placements that referenced it (children fall back to Ungrouped). */
    removeGroup: {
      args: zodSchema(z.object({ groupId: z.string() })),
      target: { section: "groups", field: "items" },
      produces: (page, args) => {
        const a = args as { groupId: string };
        const ops: SectionOp[] = [{ op: "removeElement", section: "groups", field: "items", id: a.groupId }];
        for (const p of listItems(page, "placement", "items")) {
          if (fieldStr(p, "group") === a.groupId) {
            ops.push({ op: "removeElement", section: "placement", field: "items", id: p.id });
          }
        }
        return ops;
      },
    },
    /** Assign a child to a group (idempotent: re-assigning moves it between groups). A child
     *  that isn't currently a child, or a group that doesn't exist, simply won't render until
     *  both are present — the contents view reconciles against the live state. */
    assignChild: {
      args: zodSchema(z.object({ childId: z.string(), groupId: z.string() })),
      target: { section: "placement", field: "items" },
      produces: (page, args, ctx) => {
        const a = args as { childId: string; groupId: string };
        for (const p of listItems(page, "placement", "items")) {
          if (fieldStr(p, "child") === a.childId) {
            return [
              {
                op: "setElementField",
                section: "placement",
                field: "items",
                id: p.id,
                elementField: "group",
                value: { kind: "scalar", value: a.groupId },
              },
            ];
          }
        }
        return [
          {
            op: "addElement",
            section: "placement",
            field: "items",
            id: ctx.newId(),
            fields: {
              child: { kind: "scalar", value: a.childId },
              group: { kind: "scalar", value: a.groupId },
            },
          },
        ];
      },
    },
    /** Remove a child's group assignment (it returns to Ungrouped). */
    unassignChild: {
      args: zodSchema(z.object({ childId: z.string() })),
      target: { section: "placement", field: "items" },
      produces: (page, args) => {
        const a = args as { childId: string };
        const ops: SectionOp[] = [];
        for (const p of listItems(page, "placement", "items")) {
          if (fieldStr(p, "child") === a.childId) {
            ops.push({ op: "removeElement", section: "placement", field: "items", id: p.id });
          }
        }
        return ops;
      },
    },
    /** Reorder the groups to match the given id order. Ids that aren't current groups are
     *  skipped (they must NOT consume an index slot, or they'd shift the real groups). */
    reorderGroups: {
      args: zodSchema(z.object({ orderedGroupIds: z.array(z.string()) })),
      target: { section: "groups", field: "items" },
      produces: (page, args) => {
        const ids = (args as { orderedGroupIds: string[] }).orderedGroupIds;
        const groupIds = new Set<string>(listItems(page, "groups", "items").map((g) => g.id));
        const ops: SectionOp[] = [];
        let index = 0;
        for (const id of ids) {
          if (!groupIds.has(id)) continue;
          ops.push({ op: "moveElement", section: "groups", field: "items", id, toIndex: index });
          index++;
        }
        return ops;
      },
    },
    /** Reorder children (their placement entries) to match the given child-id order — this is
     *  the within-group order, since a group renders its members in placement order. */
    reorderChildren: {
      args: zodSchema(z.object({ orderedChildIds: z.array(z.string()) })),
      target: { section: "placement", field: "items" },
      produces: (page, args) => {
        const order = (args as { orderedChildIds: string[] }).orderedChildIds;
        const entryOf = new Map<string, string>();
        for (const p of listItems(page, "placement", "items")) entryOf.set(fieldStr(p, "child"), p.id);
        const ops: SectionOp[] = [];
        let index = 0;
        for (const childId of order) {
          const entryId = entryOf.get(childId);
          if (entryId !== undefined) {
            ops.push({ op: "moveElement", section: "placement", field: "items", id: entryId, toIndex: index });
            index++;
          }
        }
        return ops;
      },
    },
  },
  render: {
    title: "{title}",
    // We render the children ourselves (the curated `contents` view), so suppress the
    // engine's auto-appended References + Child-pages sections.
    graphSections: false,
    sections: [
      { section: "overview", heading: "Overview", field: "body", as: "block", placeholder: "_No overview yet._" },
      { derived: "contents", heading: "Contents", placeholder: "_No pages yet._" },
    ],
  },
});
