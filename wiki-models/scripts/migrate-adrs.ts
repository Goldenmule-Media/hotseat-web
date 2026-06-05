/**
 * One-off, re-runnable migration: parse the ADR appendices that today live at the bottom of
 * the five package DESIGN.md files into `decision-record` pages in one global "ADRs" workspace.
 *
 * This is the move the ADR feature exists to make: the ~28 design decisions that govern the
 * wiki — `wiki/ADR-001…011`, `wiki-mcp/ADR-M1…M7`, `wiki-server/ADR-S1…S3`, `wiki-models/ADR-W1`
 * + `wiki-models/ADR-M7`, and `wiki-cli/ADR-C1…C5` — stop being flat, per-file prose (where
 * `wiki-mcp/ADR-M7` and `wiki-models/ADR-M7` collide) and become typed, FSM-governed, globally-
 * identified, cross-linked wiki pages. Each record preserves its DATE, its SCOPE (the package),
 * and its original label as `legacyId` (traceability, not identity); supersession edges the
 * prose already states (ADR-S1 → ADR-S3) are wired as integrity-checked `supersededBy` refs.
 *
 * Engine-as-library: it talks to a Durable Streams host (the running `wiki-server` by default)
 * through `wiki`'s public `createWiki`, exactly as any consumer would. The page type is loaded
 * at runtime; nothing ADR-specific lives in the engine or host. Re-runnable: it archives any
 * existing active "ADRs" workspace before recreating it, so a second run lands the same graph.
 *
 *   tsx wiki-models/scripts/migrate-adrs.ts
 *     WIKI_STREAM_URL   the Durable Streams base URL   (default http://127.0.0.1:4437)
 *     WIKI_NAMESPACE    the stream namespace            (default "default")
 *     WIKI_ADR_WORKSPACE  the workspace name            (default "ADRs")
 *
 * The parser (`parseRepoAdrs`) and the migration (`migrateAdrs`) are exported so they can be
 * driven against an in-memory test wiki for deterministic verification (see wiki/test/migrate-adrs.test.ts).
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createWiki } from "wiki";
import type { IPageType, IWorkspaceHandle, PageId, WorkspaceId } from "wiki";

import adrPageTypes from "../src/adr/index";
import architecturePageTypes from "../src/architecture/index";
import featurePageTypes from "../src/feature/index";
import tocPageTypes from "../src/toc/index";

/**
 * A workspace maps to a repo/product, so the ADRs belong in this repository's own wiki
 * workspace — alongside its Architecture and Feature Specs TOCs — under a "Decision Records"
 * TOC, NOT a separate workspace. Opening that shared workspace means folding its existing
 * `architecture` / `feature` / `toc` history, so the migration must load every bundle.
 */
export const migrationPageTypes: readonly IPageType[] = [
  ...featurePageTypes,
  ...tocPageTypes,
  ...architecturePageTypes,
  ...adrPageTypes,
];

/** The TOC the decision records live under, a sibling of the workspace's other TOCs. */
const CONTAINER_TITLE = "Decision Records";

// ────────────────────────────────────────────────────────────────────────────
// Sources & known supersession edges
// ────────────────────────────────────────────────────────────────────────────

/** Each DESIGN.md whose Appendix carries an ADR record set; `pkg` becomes the record's `scope`. */
export const ADR_SOURCES: readonly { readonly pkg: string; readonly file: string }[] = [
  { pkg: "wiki", file: "wiki/DESIGN.md" },
  { pkg: "wiki-mcp", file: "wiki-mcp/DESIGN.md" },
  { pkg: "wiki-server", file: "wiki-server/DESIGN.md" },
  { pkg: "wiki-models", file: "wiki-models/DESIGN.md" },
  { pkg: "wiki-cli", file: "wiki-cli/DESIGN.md" },
];

/**
 * Supersession edges the prose already states, keyed `<superseded legacyId> → <successor legacyId>`.
 * ADR-S1 ("Host streams; do not wrap the engine") is explicitly superseded by ADR-S3
 * ("wiki-server hosts wiki-mcp") — its own Consequences note says so. Wired as an integrity-
 * checked `supersededBy` ref, so the decision graph can't silently rot.
 */
export const SUPERSESSIONS: Readonly<Record<string, string>> = {
  "wiki-server/ADR-S1": "wiki-server/ADR-S3",
};

// ────────────────────────────────────────────────────────────────────────────
// Parser — DESIGN.md ADR appendix → structured records
// ────────────────────────────────────────────────────────────────────────────

/** A parsed body block: prose, or a fenced code block with its language. */
export interface ParsedBlock {
  readonly kind: "prose" | "code";
  readonly text: string;
  readonly lang?: string;
}

/** One parsed ADR, in the `decision-record` shape (Context prose · Decision/Consequences blocks). */
export interface ParsedAdr {
  readonly legacyId: string; // e.g. "wiki-mcp/ADR-M7" (empty for a wiki-native record like the meta-ADR)
  readonly scope: string; // the package, e.g. "wiki-mcp"
  readonly adrId: string; // e.g. "ADR-M7"
  readonly title: string;
  readonly date: string; // ISO date string, stored (never new Date())
  readonly context: string; // prose
  readonly decision: readonly ParsedBlock[];
  readonly consequences: readonly ParsedBlock[]; // prose blocks (any code is routed into `decision`)
  readonly deciders?: readonly string[];
}

/**
 * The meta-ADR, authored IN the wiki (not parsed from a DESIGN.md appendix) and written first —
 * the reflexive decision that this whole feature embodies. Alone among the records it carries NO
 * `legacyId`: it has no per-file ancestor, because it was born in the wiki. Its prose is already
 * plain (no Markdown markers), since `decision`/`consequences` are `blocks` fields.
 */
export const META_ADR: ParsedAdr = {
  legacyId: "",
  scope: "wiki-models",
  adrId: "meta",
  title: "Design decisions live in the wiki",
  date: "2026-06-05",
  deciders: ["Ben Jordan"],
  context:
    "For its first weeks this system recorded its own architecture decisions the conventional way: " +
    "an ADR appendix pinned to the bottom of each package's DESIGN.md. That form has no status or " +
    "lifecycle, no link from a decision to the one that revises it, and identity that is only " +
    "per-file — wiki-mcp and wiki-models each shipped a different \"ADR-M7\", a collision a single " +
    "namespace makes impossible. There was no way to ask which decisions touch the read model, or to " +
    "follow a decision's consequences.",
  decision: [
    {
      kind: "prose",
      text:
        "Adopt a decision-record (ADR) page type and gather every existing ADR under a Decision " +
        "Records section of this repository's own wiki workspace — alongside its Architecture and " +
        "Feature Specs, since a workspace maps to a repo/product and is the single consistency " +
        "aggregate. A decision becomes a typed, FSM-governed wiki page — Context, Decision, " +
        "Consequences, plus date, scope, deciders, and the preserved legacy label — that moves through " +
        "proposed to accepted and then, if revised, to superseded or deprecated. Supersession is an " +
        "integrity-checked reference: a decision may enter superseded only once it names a live " +
        "successor, so the decision graph cannot silently rot. The engine and host stay schema-agnostic; " +
        "the ADR type ships as one more runtime-loaded wiki-models bundle.",
    },
    {
      kind: "prose",
      text:
        "This record is itself the proof: it was authored in the wiki, not migrated from a DESIGN.md " +
        "appendix — which is why, alone among the records here, it carries no legacy id.",
    },
  ],
  consequences: [
    {
      kind: "prose",
      text:
        "Design decisions are now searchable, cross-linked, and governed objects inside the very system " +
        "they govern. Deterministic render keeps a future docs/adr snapshot churn-free (a separate " +
        "Markdown-projection feature). The DESIGN.md appendices are retired only once that snapshot " +
        "lands, so there is never a window with two sources of truth — nor one with none.",
    },
  ],
};

const ADR_HEADER = /^### (ADR-[A-Za-z0-9]+) — (.+?) \((\d{4}-\d{2}-\d{2})\)\s*$/;

/** Split a chunk of Markdown into prose paragraphs and fenced code blocks (blank-line separated). */
function splitBlocks(body: string): ParsedBlock[] {
  const lines = body.split("\n");
  const out: ParsedBlock[] = [];
  let para: string[] = [];
  const flush = (): void => {
    const text = para.join("\n").trim();
    if (text.length > 0) out.push({ kind: "prose", text });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence !== null) {
      flush();
      const lang = fence[1] !== undefined && fence[1].length > 0 ? fence[1] : "text";
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i]!)) code.push(lines[i++]!);
      out.push({ kind: "code", text: code.join("\n"), lang });
      continue; // the closing fence line is consumed by the for-loop's i++
    }
    if (line.trim().length === 0) flush();
    else para.push(line);
  }
  flush();
  return out;
}

/** Strip a leading **Context.** / **Decision.** / **Consequences …** segment label (sub-labels kept). */
function stripSegmentLabel(text: string): string {
  return text.replace(/^\*\*(Context|Decision|Consequences)\b[^*]*\*\*\s*/, "");
}

/**
 * Flatten inline Markdown to a plain-text leaf for a `blocks` field. The engine's block normal
 * form (ADR-005) forbids Markdown syntax in a text run — backtick / `*` / `_` / a complete
 * `[..](..)` link / a leading `#` — so a migrated decision/consequence paragraph must be plain:
 * we keep the WORDS (link labels, the contents of inline code / emphasis) and drop only the
 * cosmetic markers. `prose` fields (Context) keep their Markdown verbatim, since prose is exempt;
 * real fenced code survives as a `code` block (addDecisionCode), not flattened here.
 */
function flattenInline(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // [label](href) / ![alt](src) → label
    .replace(/[`*_]/g, "") // inline-code / bold / italic markers → gone (words remain)
    .replace(/^#+\s*/gm, ""); // a leading heading marker on any line
}

/** Parse one ADR's body (everything below its `### ` header) into the record's three sections. */
function parseAdrBody(body: string): Pick<ParsedAdr, "context" | "decision" | "consequences"> {
  const ctx: string[] = [];
  const decision: ParsedBlock[] = [];
  const consequenceProse: ParsedBlock[] = [];
  const strayCode: ParsedBlock[] = [];
  let seg: "context" | "decision" | "consequences" = "context";

  for (const b of splitBlocks(body)) {
    if (b.kind === "prose") {
      if (/^\*\*Decision\b/.test(b.text)) seg = "decision";
      else if (/^\*\*Consequences\b/.test(b.text)) seg = "consequences";
      else if (/^\*\*Context\b/.test(b.text)) seg = "context";
      const text = stripSegmentLabel(b.text);
      if (text.length === 0) continue;
      if (seg === "context") ctx.push(text);
      else if (seg === "decision") decision.push({ kind: "prose", text });
      else consequenceProse.push({ kind: "prose", text });
    } else {
      // Code lands in `decision` (its natural ADR home); a `prose` field can't hold a fence.
      if (seg === "decision") decision.push(b);
      else strayCode.push(b);
    }
  }
  return {
    context: ctx.join("\n\n"),
    decision: [...decision, ...strayCode],
    consequences: consequenceProse,
  };
}

/** Parse every ADR in one DESIGN.md (only the `### ADR-…` appendix entries). */
export function parseAdrFile(markdown: string, pkg: string): ParsedAdr[] {
  const lines = markdown.split("\n");
  const out: ParsedAdr[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = ADR_HEADER.exec(lines[i]!);
    if (m === null) continue;
    const [, adrId, title, date] = m as unknown as [string, string, string, string];
    // The body runs to the next ADR header or the next H2/H3 section.
    let j = i + 1;
    while (j < lines.length && !/^#{2,3} /.test(lines[j]!)) j++;
    const body = lines.slice(i + 1, j).join("\n");
    out.push({ legacyId: `${pkg}/${adrId}`, scope: pkg, adrId, title, date, ...parseAdrBody(body) });
    i = j - 1;
  }
  return out;
}

/** Parse the ADR appendices across all five DESIGN.md files, in package then document order. */
export function parseRepoAdrs(repoRoot: string): ParsedAdr[] {
  return ADR_SOURCES.flatMap(({ pkg, file }) => parseAdrFile(readFileSync(resolve(repoRoot, file), "utf8"), pkg));
}

// ────────────────────────────────────────────────────────────────────────────
// Migration — structured records → decision-record pages in one workspace
// ────────────────────────────────────────────────────────────────────────────

export interface MigrationResult {
  readonly container: PageId;
  readonly byLegacy: ReadonlyMap<string, PageId>;
  readonly superseded: readonly string[];
}

/**
 * Re-run reset: archive any prior active "Decision Records" TOC and its records, renaming the
 * old TOC out of the way first. The unique-sibling-title invariant counts ARCHIVED siblings too
 * (and event sourcing has no hard delete), so a fresh TOC can't reuse the name until the old one
 * is renamed. Old subtrees stay in history, hidden from default views. Idempotent: with no prior
 * TOC this is a no-op, so the FIRST migration into a shared workspace touches nothing else.
 */
async function archivePriorRecords(ws: IWorkspaceHandle, log: (msg: string) => void): Promise<void> {
  const tree = await ws.tree();
  const prior = tree.children.filter(
    (n) => n.type === "toc" && n.title === CONTAINER_TITLE && n.archived !== true,
  );
  for (const toc of prior) {
    for (const child of toc.children) await ws.archivePage(child.id as PageId); // records are leaves
    await ws.setPageTitle(toc.id as PageId, `${CONTAINER_TITLE} (replaced ${String(toc.id)})`); // free the title
    await ws.archivePage(toc.id as PageId);
    log(`reset: archived a prior "${CONTAINER_TITLE}" TOC (${String(toc.id)})`);
  }
}

/**
 * Write the parsed ADRs into `ws` (this repository's wiki workspace): a "Decision Records" toc
 * container — a sibling of the workspace's Architecture / Feature Specs TOCs — holding one accepted
 * `decision-record` per ADR, then the integrity-checked supersession edges. Every record is
 * `accept`-ed (these are adopted decisions); a superseded one walks accepted → superseded via the
 * two-op atomic batch (`setSupersededBy` then `supersede`), so the gate's live-target check holds.
 * Resets a prior Decision Records subtree first, so a re-run replaces rather than duplicates.
 */
export async function migrateAdrs(
  ws: IWorkspaceHandle,
  parsed: readonly ParsedAdr[],
  log: (msg: string) => void = () => {},
): Promise<MigrationResult> {
  await archivePriorRecords(ws, log);
  const container = (await ws.createPage("toc", { title: CONTAINER_TITLE, parentId: null })).value;
  const byLegacy = new Map<string, PageId>();

  // The meta-ADR is written first (it has no legacyId — it was born in the wiki), then every
  // parsed source ADR. A record with an empty legacyId simply skips that field and the index.
  for (const adr of [META_ADR, ...parsed]) {
    const id = (await ws.createPage("decision-record", { title: adr.title, parentId: container })).value;
    await ws.mutate(id, "setDate", { date: adr.date });
    if (adr.scope.length > 0) await ws.mutate(id, "setScope", { scope: adr.scope });
    if (adr.legacyId.length > 0) await ws.mutate(id, "setLegacyId", { legacyId: adr.legacyId });
    for (const d of adr.deciders ?? []) await ws.mutate(id, "addDecider", { name: d });
    if (adr.context.length > 0) await ws.mutate(id, "setContext", { text: adr.context });
    for (const b of adr.decision) {
      if (b.kind === "code") await ws.mutate(id, "addDecisionCode", { language: b.lang ?? "text", source: b.text });
      else await ws.mutate(id, "addDecisionBlock", { text: flattenInline(b.text) });
    }
    for (const b of adr.consequences) await ws.mutate(id, "addConsequence", { text: flattenInline(b.text) });
    await ws.mutate(id, "accept", {});
    if (adr.legacyId.length > 0) byLegacy.set(adr.legacyId, id);
    log(`+ ${adr.legacyId.length > 0 ? adr.legacyId : "(meta)"} — ${adr.title}`);
  }

  const superseded: string[] = [];
  for (const [from, to] of Object.entries(SUPERSESSIONS)) {
    const fromId = byLegacy.get(from);
    const toId = byLegacy.get(to);
    if (fromId === undefined || toId === undefined) continue;
    // Two ops, one atomic commit: set the ref (ingestion checks existence), then transition
    // (the namesSuccessor gate checks it is a live decision-record).
    await ws.mutateMany(fromId, [
      { command: "setSupersededBy", args: { supersededBy: String(toId) } },
      { command: "supersede", args: {} },
    ]);
    superseded.push(from);
    log(`↳ ${from} superseded by ${to}`);
  }
  return { container, byLegacy, superseded };
}

// ────────────────────────────────────────────────────────────────────────────
// CLI entry — connect to a Durable Streams host and (re)build the "ADRs" workspace
// ────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const parsed = parseRepoAdrs(repoRoot);
  const baseUrl = process.env.WIKI_STREAM_URL ?? "http://127.0.0.1:4437";
  const namespace = process.env.WIKI_NAMESPACE ?? "default";
  // A workspace maps to a repo/product: the ADRs go in THIS repo's wiki workspace (default
  // "wiki"), under a Decision Records TOC — not a workspace of their own.
  const wsName = process.env.WIKI_ADR_WORKSPACE ?? "wiki";

  const wiki = createWiki({ stream: { baseUrl, namespace }, pageTypes: migrationPageTypes });
  try {
    const existing = (await wiki.listWorkspaces()).find((w) => w.name === wsName && w.status === "active");
    const ws =
      existing !== undefined
        ? await wiki.openWorkspace(existing.id as WorkspaceId)
        : await wiki.createWorkspace({ name: wsName });
    console.log(`${existing !== undefined ? "opened" : "created"} workspace ${ws.id} ("${wsName}")`);
    const { byLegacy, superseded } = await migrateAdrs(ws, parsed, (m) => console.log(m));
    console.log(
      `\nmigrated ${byLegacy.size} ADRs (${superseded.length} supersession edge${superseded.length === 1 ? "" : "s"}) ` +
        `under the "${CONTAINER_TITLE}" TOC of workspace ${ws.id} — namespace "${namespace}" @ ${baseUrl}`,
    );
  } finally {
    await wiki.close();
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
