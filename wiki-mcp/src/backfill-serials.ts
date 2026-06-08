/**
 * One-shot maintenance: backfill engine-assigned `serial` fields onto pages that predate the
 * field, and strip any hand-typed `ADR-NNNN:` prefix the old convention baked into ADR titles.
 *
 * Pages created BEFORE a `serial` field was added to their type carried no minted value, so the
 * field materialized to the placeholder 0 (e.g. an ADR renders "ADR-0: …"). `assignSerials`
 * fills the unset pages per type, in creation order, with a stable number — immutable and
 * idempotent. Separately, ADRs that were authored with the number IN the title (e.g.
 * "ADR-0001: …") would now double up ("ADR-1: ADR-0001: …"); since the number is supplied by
 * the render template, the stored title should hold only the description, so we strip the
 * leading `ADR-NNNN:`.
 *
 * SAFE BY DEFAULT: prints the plan and writes NOTHING. Pass `--apply` to commit. Connects to the
 * running Durable Streams host over HTTP, so the wiki-server must be up (on a build with the
 * serial field + `assignSerials`).
 *
 *   tsx src/backfill-serials.ts                        # dry-run (preview)
 *   tsx src/backfill-serials.ts --apply                # write
 *   tsx src/backfill-serials.ts --models wiki-models/adr,wiki-models/toc --apply
 *
 * Run via the package script: `npm run backfill-serials -w wiki-mcp -- --apply`.
 */
import { createWiki, type IPageType, type ITreeNode } from "wiki";

import { asPageId } from "./engine.js";
import { loadModelBundle } from "./models/loader.js";

interface Flags {
  apply: boolean;
  models: string[];
  namespace: string;
  streamBaseUrl: string;
}

/** A leading `ADR-<digits>:` the old convention baked into the title (the number now lives in
 *  the render template, so the stored title should carry only the description). */
const TITLE_NUMBER = /^ADR-\d+:\s*/;

/** flags → env → defaults (mirrors wiki-mcp config resolution). */
function parseFlags(argv: readonly string[]): Flags {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const models = (
    flag("models") ??
    process.env.WIKI_SERVER_MODELS ??
    "wiki-models/toc,wiki-models/architecture,wiki-models/feature,wiki-models/adr"
  )
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return {
    apply: argv.includes("--apply"),
    models,
    namespace: flag("namespace") ?? process.env.WIKI_MCP_NAMESPACE ?? "default",
    streamBaseUrl: flag("stream-url") ?? process.env.WIKI_MCP_STREAM_URL ?? "http://127.0.0.1:4437",
  };
}

/** Every (id, type, title) in a workspace tree, depth-first (skips the @root sentinel). */
function* walk(node: ITreeNode): Generator<{ id: string; type: string; title: string }> {
  if (node.type !== undefined) yield { id: node.id, type: node.type, title: node.title };
  for (const child of node.children) yield* walk(child);
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));

  const pageTypes: IPageType[] = [];
  for (const spec of flags.models) {
    const { pageTypes: pts } = await loadModelBundle(spec);
    pageTypes.push(...pts);
  }

  const wiki = createWiki({
    stream: { baseUrl: flags.streamBaseUrl, namespace: flags.namespace },
    pageTypes,
  });

  let workspacesTouched = 0;
  let stripped = 0;
  let failed = 0;
  try {
    const workspaces = await wiki.listWorkspaces();
    console.log(
      `Backfill ADR serials — ${flags.apply ? "APPLY" : "DRY-RUN"} · namespace "${flags.namespace}" · ${workspaces.length} workspace(s)`,
    );
    for (const ws of workspaces) {
      // assignSerials is a structural command — it (rightly) refuses an archived workspace, which
      // is hidden anyway. Skip it.
      if (ws.status === "archived") {
        console.log(`\n${ws.name} (${ws.id}) — [archived], skipped`);
        continue;
      }
      const handle = await wiki.openWorkspace(ws.id);
      const tree = await handle.tree();
      const records = [...walk(tree)].filter((p) => p.type === "decision-record");
      if (records.length === 0) continue;
      const toStrip = records.filter((p) => TITLE_NUMBER.test(p.title));
      console.log(
        `\n${ws.name} (${ws.id}) — ${records.length} decision-record(s); assignSerials + strip ${toStrip.length} title(s)`,
      );

      if (flags.apply) {
        workspacesTouched++;
        // 1) Mint numbers onto any record still at the placeholder 0 (idempotent).
        await handle.assignSerials();
        // 2) Strip the hand-typed "ADR-NNNN:" prefix — the number now comes from render.title.
        for (const page of toStrip) {
          const next = page.title.replace(TITLE_NUMBER, "");
          try {
            await handle.setPageTitle(asPageId(page.id), next);
            stripped++;
            console.log(`  ✓ ${page.id}: "${page.title}" → "${next}"`);
          } catch (err) {
            failed++;
            console.log(`  ✗ ${page.id}: "${page.title}" → "${next}" — ${(err as Error).message}`);
          }
        }
        // 3) Show the resulting H1 of the first record as a sanity check.
        const sample = await handle.toMarkdown(asPageId(records[0].id));
        console.log(`  → e.g. ${sample.split("\n", 1)[0]}`);
      } else {
        for (const page of toStrip) {
          console.log(`  • strip ${page.id}: "${page.title}" → "${page.title.replace(TITLE_NUMBER, "")}"`);
        }
      }
    }
  } finally {
    await wiki.close();
  }

  console.log(
    flags.apply
      ? `\nDone — assignSerials on ${workspacesTouched} workspace(s); stripped ${stripped} title(s), ${failed} failed.`
      : `\nDry-run — pass --apply to write (assignSerials is idempotent; only zero-valued serials are filled).`,
  );
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
