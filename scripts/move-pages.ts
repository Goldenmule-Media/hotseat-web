/**
 * Operator CLI: move pages, each with its subtree, from one workspace to another.
 *
 * SAFE BY DEFAULT: checks the move against both workspaces, prints what it would do, and
 * writes NOTHING. Pass `--apply` to move.
 *
 *   tsx scripts/move-pages.ts --from ws:… --to ws:… --pages toc:a,toc:b --parent toc:core
 *   tsx scripts/move-pages.ts --from ws:… --to ws:… --pages toc:a,toc:b --parent toc:core --apply
 *   tsx scripts/move-pages.ts --from ws:…                       # list the moves out still pending
 *   tsx scripts/move-pages.ts --from ws:… --resume move:… --apply
 *
 * `--parent` is where the pages land in the target (omit for top level); `--position` is
 * their index among the new siblings. Attachments the pages reference are copied through the
 * blob endpoint first. A move that stops partway (a crash, a dropped connection) stays
 * pending on the source and finishes when you run the same command again, or `--resume` it.
 *
 * Every client that tails either workspace must already run an engine that knows the move
 * events (the server, wiki-ui, and each installed wiki-mirror), or its tail stops.
 *
 * Auth follows the shared CLI precedence: `--token` / `$WIKI_TOKEN`, else a stored grant
 * from `wiki-mirror login`, else no header (an open server).
 */
import { createWiki } from "wiki";
import type { IPageType, IStreamConfig, PageId, WorkspaceId } from "wiki";
import { movePages, resumePageMove, type BlobCopier, type MovePagesReport } from "wiki/admin";
import { AttachmentClient } from "wiki/attachments";
import { resolveAuthorization } from "wiki/auth-client";
import adr from "wiki-models/adr";
import architecture from "wiki-models/architecture";
import article from "wiki-models/article";
import bug from "wiki-models/bug";
import document from "wiki-models/document";
import engagement from "wiki-models/engagement";
import feature from "wiki-models/feature";
import recipe from "wiki-models/recipe";
import restatementGlossary from "wiki-models/restatement-glossary";
import security from "wiki-models/security";
import specRestatement from "wiki-models/spec-restatement";
import study from "wiki-models/study";
import toc from "wiki-models/toc";

/** Every bundle: opening a workspace folds its whole stream, which needs every type it uses. */
const ALL_PAGE_TYPES: readonly IPageType[] = [
  ...adr,
  ...architecture,
  ...article,
  ...bug,
  ...document,
  ...engagement,
  ...feature,
  ...recipe,
  ...restatementGlossary,
  ...security,
  ...specRestatement,
  ...study,
  ...toc,
];

const USAGE =
  "usage: move-pages --from <ws> [--to <ws> --pages <id,id…> [--parent <pageId>] [--position <n>]] " +
  "[--resume <moveId>] [--stream-url <url>] [--namespace <ns>] [--token <t>] [--apply]";

function flagOf(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i < 0 || i + 1 >= argv.length) return undefined;
  const v = argv[i + 1];
  return v.startsWith("--") ? undefined : v;
}

function print(report: MovePagesReport): void {
  console.log(`move       ${report.moveId ?? "(dry run)"}${report.resumed ? "  [resumed]" : ""}`);
  console.log(`from → to  ${report.from} → ${report.to}`);
  console.log(`roots      ${report.roots.join(", ")}`);
  console.log(`pages      ${report.movedPageIds.length}`);
  for (const id of report.movedPageIds) console.log(`  ${id}`);
  if (report.blobs.length > 0) console.log(`attachments ${report.blobs.length}`);
  for (const [page, sections] of Object.entries(report.serials)) {
    for (const [section, fields] of Object.entries(sections)) {
      for (const [field, { from, to }] of Object.entries(fields)) console.log(`renumbered ${page} ${section}.${field}: ${from} → ${to}`);
    }
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const from = flagOf(argv, "from") as WorkspaceId | undefined;
  const to = flagOf(argv, "to") as WorkspaceId | undefined;
  const pages = (flagOf(argv, "pages") ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0) as PageId[];
  const parent = (flagOf(argv, "parent") ?? null) as PageId | null;
  const positionFlag = flagOf(argv, "position");
  const resume = flagOf(argv, "resume");
  const streamUrl = flagOf(argv, "stream-url") ?? process.env.WIKI_STREAM_URL ?? "http://127.0.0.1:4437";
  const namespace = flagOf(argv, "namespace") ?? process.env.WIKI_NAMESPACE ?? "default";
  const token = flagOf(argv, "token") ?? process.env.WIKI_TOKEN;
  const apply = argv.includes("--apply");

  if (from === undefined || (pages.length > 0 && to === undefined)) {
    console.error(USAGE);
    process.exit(2);
  }

  const authorization = resolveAuthorization(streamUrl, token);
  const headers = authorization !== undefined ? { authorization } : undefined;
  const stream: IStreamConfig = { baseUrl: streamUrl, namespace, ...(headers !== undefined ? { headers } : {}) };
  const wiki = createWiki({ stream, pageTypes: ALL_PAGE_TYPES });
  const blobs = new AttachmentClient({ baseUrl: streamUrl, namespace, ...(headers !== undefined ? { headers } : {}) });
  const copyBlob: BlobCopier = async (id, src, dst) => {
    const found = await blobs.download(src, id);
    if (found === undefined) {
      console.warn(`warning: attachment ${id} isn't stored in ${src}; its reference stays broken`);
      return;
    }
    await blobs.upload(dst, found.bytes, found.meta.mime, found.meta.name);
  };
  const open = (id: WorkspaceId) => wiki.openWorkspace(id);
  console.log(`server     ${streamUrl}`);

  try {
    if (resume !== undefined) {
      if (!apply) {
        console.log(`\nDRY RUN — would resume ${resume} on ${from}. Pass --apply.`);
        return;
      }
      print(await resumePageMove({ open, from, moveId: resume, copyBlob }));
      console.log("\ndone");
      return;
    }

    if (pages.length === 0) {
      const pending = await (await open(from)).pendingMoves();
      if (pending.length === 0) console.log(`No moves out of ${from} are pending.`);
      for (const m of pending) console.log(`${m.moveId}  → ${m.to}  roots ${m.roots.join(", ")}  (${m.pageIds.length} pages)`);
      return;
    }

    const report = await movePages({
      open,
      from,
      to: to!,
      pageIds: pages,
      parentId: parent,
      ...(positionFlag !== undefined ? { position: Number(positionFlag) } : {}),
      copyBlob,
      dryRun: !apply,
    });
    print(report);
    console.log(apply ? "\ndone" : "\nDRY RUN — nothing written. Pass --apply.");
  } finally {
    await wiki.close();
  }
}

await main();
