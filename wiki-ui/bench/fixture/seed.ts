/**
 * The benchmark corpus. Deterministic by construction — `wikiOn`'s default clock (1s steps from
 * 2020-01-01) and ids (`id-1`, `id-2`, …) are pure counters, and every text choice here comes
 * from a fixed-seed PRNG — so reseeding produces a byte-identical stream every run. That is what
 * makes a latency number comparable across commits.
 *
 * `document` only: lifecycle-free, one `blocks` field, no studio and no FSM edges, so PageView
 * takes the plain content path and the measurement isn't confounded by a type's extra reads.
 *
 * Bump FIXTURE_VERSION whenever the shape changes — results carry it, and the compare script
 * refuses to put two different corpora on the same axis.
 */
import type { IWiki, IWorkspaceHandle, PageId, WorkspaceId } from "wiki";

export const FIXTURE_VERSION = 1;

export const WORKSPACE_A = "ws:bench" as WorkspaceId;
export const WORKSPACE_B = "ws:bench-secondary" as WorkspaceId;

/** The page ids the scenarios drive, resolved at seed time so no spec hardcodes `document:id-N`. */
export interface Manifest {
  readonly fixtureVersion: number;
  readonly workspaceId: WorkspaceId;
  readonly secondaryWorkspaceId: WorkspaceId;
  /** Two childless small pages, the first two rows of the sidebar — always visible, no scroll. */
  readonly smallA: PageId;
  readonly smallB: PageId;
  /** One ~1200-block page: tables, code fences, nested lists. */
  readonly huge: PageId;
  /** A depth-3 page, for isolating tree-render cost from content cost. */
  readonly deep: PageId;
  readonly mediumIds: readonly PageId[];
  readonly pageCount: number;
}

// ── deterministic text ──────────────────────────────────────────────────────────

/** xorshift32. Never Math.random(): the corpus has to be reproducible. */
function prng(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 0x1_0000_0000;
  };
}

const WORDS =
  "workspace projection commit stream fold render page section field status transition invariant token consistency reducer decider registry namespace envelope upcaster snapshot cursor mutation command event handle aggregate schema deterministic append boundary".split(
    " ",
  );

function sentence(rnd: () => number, words: number): string {
  const out: string[] = [];
  for (let i = 0; i < words; i++) out.push(WORDS[Math.floor(rnd() * WORDS.length)]!);
  return `${out.join(" ")}.`;
}

function paragraph(rnd: () => number): string {
  const n = 2 + Math.floor(rnd() * 4);
  return Array.from({ length: n }, () => sentence(rnd, 6 + Math.floor(rnd() * 10))).join(" ");
}

// ── block builders ──────────────────────────────────────────────────────────────

type Cmd = { command: string; args: Record<string, unknown> };

/** One page's worth of commands. ~15% of paragraphs carry a page ref, so `renderMarkdown`'s
 *  walkTokens/isPageId/pageHref rewrite path is actually exercised rather than skipped. */
function blocksFor(rnd: () => number, count: number, refTargets: readonly PageId[]): Cmd[] {
  const cmds: Cmd[] = [];
  for (let i = 0; i < count; i++) {
    const roll = rnd();
    if (i % 12 === 0) {
      cmds.push({ command: "addHeading", args: { level: 2 + (i % 3), inlines: [sentence(rnd, 4).replace(".", "")] } });
    } else if (roll < 0.08) {
      cmds.push({
        command: "addCode",
        args: { language: "ts", source: Array.from({ length: 4 }, () => `const ${WORDS[Math.floor(rnd() * WORDS.length)]!} = ${Math.floor(rnd() * 1000)};`).join("\n") },
      });
    } else if (roll < 0.16) {
      cmds.push({
        command: "addList",
        args: { ordered: roll < 0.12, items: Array.from({ length: 3 + Math.floor(rnd() * 4) }, () => [sentence(rnd, 7)]) },
      });
    } else if (roll < 0.22) {
      const cols = 3 + Math.floor(rnd() * 2);
      cmds.push({
        command: "addTable",
        args: {
          header: Array.from({ length: cols }, () => [sentence(rnd, 2).replace(".", "")]),
          rows: Array.from({ length: 3 + Math.floor(rnd() * 3) }, () => Array.from({ length: cols }, () => [sentence(rnd, 3)])),
        },
      });
    } else if (roll < 0.26) {
      cmds.push({ command: "addQuote", args: { paragraphs: [[paragraph(rnd)]] } });
    } else if (roll < 0.41 && refTargets.length > 0) {
      const target = refTargets[Math.floor(rnd() * refTargets.length)]!;
      cmds.push({ command: "addParagraph", args: { inlines: [`${sentence(rnd, 8)} See `, { ref: target }, ` ${sentence(rnd, 6)}`] } });
    } else {
      cmds.push({ command: "addParagraph", args: { inlines: [paragraph(rnd)] } });
    }
  }
  return cmds;
}

/** Commands go up in chunks rather than one giant atomic batch — a few hundred appends of
 *  bounded size, closer to how a real workspace accumulates. */
const BATCH = 50;

async function author(h: IWorkspaceHandle, pageId: PageId, cmds: readonly Cmd[]): Promise<void> {
  for (let i = 0; i < cmds.length; i += BATCH) {
    await h.mutateMany(pageId, cmds.slice(i, i + BATCH));
  }
}

// ── the corpus ──────────────────────────────────────────────────────────────────

const SECTIONS = 8;
const PER_SECTION = 12;
const GRANDCHILDREN = 4;
const HUGE_BLOCKS = 1200;
const LARGE_BLOCKS = 300;

export async function seed(wiki: IWiki, log: (m: string) => void = () => {}): Promise<Manifest> {
  const rnd = prng(0x5eed_1234);
  const a = await wiki.createWorkspace({ name: "Bench", id: WORKSPACE_A });

  // Pass 1: the whole tree, so every page ref in pass 2 has an existing target (a dangling
  // ref aborts the commit — the engine checks integrity, it does not warn).
  const create = async (title: string, parent: PageId | null): Promise<PageId> =>
    (await a.createPage("document", { title, parentId: parent })).value;

  const smallA = await create("Alpha", null);
  const smallB = await create("Beta", null);
  const huge = await create("Huge", null);

  const sections: PageId[] = [];
  const children: PageId[] = [];
  const grandchildren: PageId[] = [];
  for (let s = 0; s < SECTIONS; s++) {
    const section = await create(`Section ${String(s + 1).padStart(2, "0")}`, null);
    sections.push(section);
    for (let c = 0; c < PER_SECTION; c++) {
      const child = await create(`Section ${s + 1} · Page ${c + 1}`, section);
      children.push(child);
      if (s === 0 && c === 0) {
        for (let g = 0; g < GRANDCHILDREN; g++) grandchildren.push(await create(`Nested page ${g + 1}`, child));
      }
    }
  }
  const all = [smallA, smallB, huge, ...sections, ...children, ...grandchildren];
  log(`created ${all.length} pages`);

  // Pass 2: content. Sizes are assigned by position so they don't drift with the PRNG.
  const large = new Set(children.slice(0, 4));
  const medium = children.slice(4, 29);
  const mediumSet = new Set(medium);

  const sizeOf = (id: PageId): number => {
    if (id === huge) return HUGE_BLOCKS;
    if (large.has(id)) return LARGE_BLOCKS;
    if (mediumSet.has(id)) return 40 + Math.floor(rnd() * 61);
    return 5 + Math.floor(rnd() * 16);
  };

  let blocks = 0;
  for (const id of all) {
    const n = sizeOf(id);
    await author(a, id, blocksFor(rnd, n, all));
    blocks += n;
  }
  log(`authored ${blocks} blocks`);

  // A second workspace exists ONLY so primeSearchIndex() — which opens every active workspace —
  // and the first whole-workspace reindex are priced realistically in the cold scenario.
  const b = await wiki.createWorkspace({ name: "Bench Secondary", id: WORKSPACE_B });
  for (let i = 0; i < 20; i++) {
    const { value } = await b.createPage("document", { title: `Secondary ${i + 1}`, parentId: null });
    await author(b, value, blocksFor(rnd, 5 + Math.floor(rnd() * 10), []));
  }

  return {
    fixtureVersion: FIXTURE_VERSION,
    workspaceId: WORKSPACE_A,
    secondaryWorkspaceId: WORKSPACE_B,
    smallA,
    smallB,
    huge,
    deep: grandchildren[0]!,
    mediumIds: medium,
    pageCount: all.length,
  };
}
