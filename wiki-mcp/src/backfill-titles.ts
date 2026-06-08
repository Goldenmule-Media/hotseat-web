/**
 * One-shot maintenance: backfill friendly titles onto auto-created child pages.
 * Pages materialized BEFORE the friendly-title fix kept
 * the raw type id as their title (e.g. `implementation-plan`); the title is
 * denormalized into the event log, so the fix is forward-only and existing pages need
 * an explicit `setPageTitle` to catch up.
 *
 * Detection signal: a page whose `title` is exactly its `type` id is an un-renamed
 * auto-created child. Each such page is renamed to the same friendly title NEW pages
 * now get: the type def's `label`, else a deterministic title-cased type id.
 *
 * SAFE BY DEFAULT: prints the plan and writes NOTHING. Pass `--apply` to commit the
 * renames. Connects to the running Durable Streams host over HTTP, so the wiki-server
 * must be up (and on the engine build that includes the fix).
 *
 *   tsx src/backfill-titles.ts                       # dry-run (preview)
 *   tsx src/backfill-titles.ts --apply               # write the renames
 *   tsx src/backfill-titles.ts --models wiki-models/feature --namespace default --apply
 *
 * Run via the package script: `npm run backfill-titles -w wiki-mcp -- --apply`.
 */
import { createWiki, titleCase, type IPageType, type ITreeNode } from "wiki";

import { asPageId } from "./engine.js";
import { loadModelBundle } from "./models/loader.js";

interface Flags {
  apply: boolean;
  models: string[];
  namespace: string;
  streamBaseUrl: string;
}

/** flags → env → defaults (mirrors wiki-mcp config resolution). */
function parseFlags(argv: readonly string[]): Flags {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const models = (flag("models") ?? process.env.WIKI_SERVER_MODELS ?? "wiki-models/feature")
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

  // Load the page types so we can read each type's `label` and build the engine.
  const pageTypes: IPageType[] = [];
  const labelOf = new Map<string, string | undefined>();
  for (const spec of flags.models) {
    const { pageTypes: pts } = await loadModelBundle(spec);
    for (const pt of pts) {
      pageTypes.push(pt);
      labelOf.set(pt.__def.type, pt.__def.label);
    }
  }

  const friendlyTitle = (type: string): string => labelOf.get(type) ?? titleCase(type);

  const wiki = createWiki({
    stream: { baseUrl: flags.streamBaseUrl, namespace: flags.namespace },
    pageTypes,
  });

  let scanned = 0;
  let renamed = 0;
  let failed = 0;
  try {
    const workspaces = await wiki.listWorkspaces();
    console.log(
      `Backfill child titles — ${flags.apply ? "APPLY" : "DRY-RUN"} · namespace "${flags.namespace}" · ${workspaces.length} workspace(s)`,
    );
    for (const ws of workspaces) {
      const handle = await wiki.openWorkspace(ws.id);
      const tree = await handle.tree();
      for (const page of walk(tree)) {
        scanned++;
        if (page.title !== page.type) continue; // already friendly / user-renamed
        const next = friendlyTitle(page.type);
        if (next === page.title) continue; // type id already reads fine (no label, no hyphens)
        if (flags.apply) {
          try {
            await handle.setPageTitle(asPageId(page.id), next);
            renamed++;
            console.log(`  ✓ ${ws.id} ${page.id}: "${page.title}" → "${next}"`);
          } catch (err) {
            failed++;
            console.log(`  ✗ ${ws.id} ${page.id}: "${page.title}" → "${next}" — ${(err as Error).message}`);
          }
        } else {
          renamed++;
          console.log(`  • ${ws.id} ${page.id}: "${page.title}" → "${next}"`);
        }
      }
    }
  } finally {
    await wiki.close();
  }

  console.log(
    `\nScanned ${scanned} page(s); ${flags.apply ? `renamed ${renamed}, ${failed} failed` : `${renamed} would be renamed (dry-run — pass --apply to write)`}.`,
  );
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
