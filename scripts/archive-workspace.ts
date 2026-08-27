/**
 * Operator CLI: archive (or unarchive) a workspace — the engine's only form of removal.
 *
 * SAFE BY DEFAULT: prints what it would do and writes NOTHING. Pass `--apply` to commit.
 *
 *   tsx scripts/archive-workspace.ts --workspace ws:… --stream-url https://…
 *   tsx scripts/archive-workspace.ts --workspace ws:… --stream-url https://… --apply
 *   tsx scripts/archive-workspace.ts --workspace ws:… --unarchive --apply
 *
 * ARCHIVING IS NOT DELETING, and the engine offers nothing stronger. The workspace drops
 * out of default listings and is reversible with `--unarchive`; its Durable Stream and
 * every event in it remain on the server. That is the event-sourced bargain — history is
 * append-only, so "delete" is a view, not an erasure. Actually destroying the data means
 * removing the stream at the Durable Streams host, outside this engine and irreversible.
 *
 * Auth follows the shared CLI precedence: `--token` / `$WIKI_TOKEN`, else a stored grant
 * from `wiki-mirror login`, else no header (an open server).
 */
import { createWiki } from "wiki";
import type { IPageType, IStreamConfig, WorkspaceId } from "wiki";
import { resolveAuthorization } from "wiki/auth-client";
import adr from "wiki-models/adr";
import architecture from "wiki-models/architecture";
import article from "wiki-models/article";
import bug from "wiki-models/bug";
import document from "wiki-models/document";
import engagement from "wiki-models/engagement";
import feature from "wiki-models/feature";
import restatementGlossary from "wiki-models/restatement-glossary";
import security from "wiki-models/security";
import specRestatement from "wiki-models/spec-restatement";
import study from "wiki-models/study";
import toc from "wiki-models/toc";

/**
 * Every bundle. Opening a workspace FOLDS its stream, and a fold rejects an event whose
 * page type is unregistered — so an operator command that must work on any workspace has
 * to carry the whole schema, even though it only touches the catalog.
 */
const ALL_PAGE_TYPES: readonly IPageType[] = [
  ...adr,
  ...architecture,
  ...article,
  ...bug,
  ...document,
  ...engagement,
  ...feature,
  ...restatementGlossary,
  ...security,
  ...specRestatement,
  ...study,
  ...toc,
];

function flagOf(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i < 0 || i + 1 >= argv.length) return undefined;
  const v = argv[i + 1];
  return v.startsWith("--") ? undefined : v;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const workspace = flagOf(argv, "workspace") ?? "";
  const streamUrl = flagOf(argv, "stream-url") ?? process.env.WIKI_STREAM_URL ?? "http://127.0.0.1:4437";
  const namespace = flagOf(argv, "namespace") ?? process.env.WIKI_NAMESPACE ?? "default";
  const token = flagOf(argv, "token") ?? process.env.WIKI_TOKEN;
  const apply = argv.includes("--apply");
  const unarchive = argv.includes("--unarchive");

  if (workspace.length === 0) {
    console.error("usage: archive-workspace --workspace <ws:id> [--stream-url <url>] [--unarchive] [--apply]");
    process.exit(2);
  }

  const authorization = resolveAuthorization(streamUrl, token);
  const stream: IStreamConfig = {
    baseUrl: streamUrl,
    namespace,
    ...(authorization !== undefined ? { headers: { authorization } } : {}),
  };
  const wiki = createWiki({ stream, pageTypes: ALL_PAGE_TYPES });

  const before = await wiki.listWorkspaces();
  const target = before.find((w) => w.id === workspace);
  if (target === undefined) {
    console.error(`No workspace ${workspace} on ${streamUrl}.`);
    await wiki.close();
    process.exit(1);
  }

  const verb = unarchive ? "unarchive" : "archive";
  console.log(`server     ${streamUrl}`);
  console.log(`workspace  ${target.id} — "${target.name}" [${target.status}]`);
  console.log(`action     ${verb}`);

  if (!apply) {
    console.log("\nDRY RUN — nothing written. Pass --apply.");
    console.log("Note: archiving hides a workspace from default listings and is reversible;");
    console.log("it does NOT erase the stream. The engine has no hard delete.");
    await wiki.close();
    return;
  }

  const handle = await wiki.openWorkspace(workspace as WorkspaceId);
  if (unarchive) await handle.unarchive();
  else await handle.archive();

  const after = (await wiki.listWorkspaces()).find((w) => w.id === workspace);
  console.log(`\ndone — now [${after?.status ?? "unlisted"}]`);
  await wiki.close();
}

await main();
