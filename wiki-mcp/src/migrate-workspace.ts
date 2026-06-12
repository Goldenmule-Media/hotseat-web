/**
 * Operator CLI: copy a workspace's event stream from one Durable Streams server to
 * another (e.g. local↔remote migration). A thin wrapper over the engine's
 * schema-agnostic `replicateWorkspace` — it loads NO page types, since replication
 * copies opaque event envelopes and never folds or renders.
 *
 * SAFE BY DEFAULT: prints the plan and writes NOTHING. Pass `--apply` to commit. The
 * destination keeps the SAME workspace id (a faithful replica); re-running is
 * idempotent (only commits past the destination head are copied) and refuses to
 * clobber a destination whose history diverges from the source.
 *
 *   # dry-run: preview copying a workspace to a remote server
 *   tsx src/migrate-workspace.ts --workspace ws:… --dest-url https://wiki.example.com
 *
 *   # apply, with bearer auth on the (auth-gated) destination
 *   tsx src/migrate-workspace.ts --workspace ws:… \
 *     --dest-url https://wiki.example.com --dest-token "$TOKEN" --apply
 *
 * Run via the package script: `npm run migrate-workspace -w wiki-mcp -- --workspace ws:… --dest-url … --apply`.
 */
import { replicateWorkspace, ReplicationConflictError } from "wiki/admin";
import { CredentialsStore, oauthHeaders } from "wiki/auth-client";
import type { IStreamConfig, WorkspaceId } from "wiki";

interface Flags {
  workspace: string;
  sourceUrl: string;
  sourceNamespace: string;
  sourceToken: string | undefined;
  destUrl: string;
  destNamespace: string;
  destToken: string | undefined;
  includeCatalog: boolean;
  apply: boolean;
}

function parseFlags(argv: readonly string[]): Flags {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    if (i < 0 || i + 1 >= argv.length) return undefined;
    const value = argv[i + 1];
    // A following token that is itself a flag means this flag was given no value —
    // don't silently swallow `--apply` as the value of `--dest-url`, etc.
    return value.startsWith("--") ? undefined : value;
  };
  const sourceUrl = flag("source-url") ?? process.env.WIKI_MCP_STREAM_URL ?? "http://127.0.0.1:4437";
  const sourceNamespace = flag("source-namespace") ?? process.env.WIKI_MCP_NAMESPACE ?? "default";
  const destUrl = flag("dest-url") ?? "";
  return {
    workspace: flag("workspace") ?? "",
    sourceUrl,
    sourceNamespace,
    sourceToken: flag("source-token") ?? process.env.WIKI_MIGRATE_SOURCE_TOKEN,
    destUrl,
    // Default the destination namespace to the source's (same-namespace migration is the common case).
    destNamespace: flag("dest-namespace") ?? sourceNamespace,
    destToken: flag("dest-token") ?? process.env.WIKI_MIGRATE_DEST_TOKEN,
    includeCatalog: !argv.includes("--no-catalog"),
    apply: argv.includes("--apply"),
  };
}

/**
 * A stream config with authorization, by precedence: an explicit static token
 * (flag/env) wins; else a stored OAuth grant for the server's origin
 * (`wiki-mirror login`, in `~/.wiki/credentials.json`) becomes a refreshing
 * header function; else unauthenticated (an open server).
 */
function streamConfig(baseUrl: string, namespace: string, token: string | undefined): IStreamConfig {
  if (token !== undefined && token.length > 0) {
    return { baseUrl, namespace, headers: { authorization: `Bearer ${token}` } };
  }
  if (new CredentialsStore().get(baseUrl) !== undefined) {
    return { baseUrl, namespace, headers: { authorization: oauthHeaders(baseUrl).authorization } };
  }
  return { baseUrl, namespace };
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.workspace.length === 0 || flags.destUrl.length === 0) {
    console.error(
      "usage: migrate-workspace --workspace <ws:id> --dest-url <url> [--dest-namespace <ns>] " +
        "[--dest-token <bearer>] [--source-url <url>] [--source-namespace <ns>] [--source-token <bearer>] " +
        "[--no-catalog] [--apply]\n" +
        "auth: explicit tokens win; otherwise a stored OAuth grant for the URL's origin is used\n" +
        "      (sign in once with `wiki-mirror login --stream-url <url>` — credentials refresh themselves)",
    );
    process.exitCode = 1;
    return;
  }

  const source = streamConfig(flags.sourceUrl, flags.sourceNamespace, flags.sourceToken);
  const dest = streamConfig(flags.destUrl, flags.destNamespace, flags.destToken);

  console.log(
    `Migrate workspace ${flags.workspace} — ${flags.apply ? "APPLY" : "DRY-RUN"}\n` +
      `  source: ${flags.sourceUrl} [${flags.sourceNamespace}]\n` +
      `  dest:   ${flags.destUrl} [${flags.destNamespace}]`,
  );

  try {
    const report = await replicateWorkspace({
      source,
      dest,
      workspaceId: flags.workspace as WorkspaceId,
      includeCatalog: flags.includeCatalog,
      dryRun: !flags.apply,
    });
    console.log(
      `\n  source: ${report.sourceCommits} commit(s), ${report.sourceEvents} event(s)\n` +
        `  dest before: ${report.destHeadBefore} event(s)\n` +
        `  ${flags.apply ? "copied" : "would copy"}: ${report.copiedCommits} commit(s), ${report.copiedEvents} event(s)` +
        `, ${report.catalogEventsCopied} catalog entr(y/ies)\n` +
        `  dest after: ${report.destHeadAfter} event(s)`,
    );
    if (!flags.apply) {
      console.log(`\nDry-run — pass --apply to write.`);
    } else if (report.copiedEvents === 0) {
      console.log(`\nDone — destination already up to date; nothing copied.`);
    } else {
      console.log(`\nDone — workspace ${flags.workspace} replicated to ${flags.destUrl}.`);
    }
  } catch (err) {
    if (err instanceof ReplicationConflictError) {
      console.error(`\nRefused: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
