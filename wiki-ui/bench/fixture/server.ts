/**
 * The bench's stream host: a bare DurableStreamTestServer on a FIXED port, seeded with the
 * corpus, held open until SIGTERM. Prints `READY <url>` on stdout — global-setup waits on that.
 *
 * A bare stream server is enough; no wiki-server is needed. The UI's `/auth/config` probe reads
 * any HTTP response (including this server's 404 for the absent route) as "auth disabled, server
 * reachable", and the stream server already answers with `Access-Control-Allow-Origin: *`.
 *
 * Runs under `tsx`, not inside Playwright's process: `wiki`/`wiki-models` publish extensionless
 * TypeScript source through their package exports, which resolves under tsx and webpack but not
 * under Playwright's own loader.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startTestServer, wikiOn } from "wiki/testing";
import documentPageTypes from "wiki-models/document";
import { seed } from "./seed";

const PORT = Number(process.env["BENCH_STREAM_PORT"] ?? 4470);
// Must match the UI's default (lib/config.ts), NOT wiki/testing's "test".
const NAMESPACE = process.env["BENCH_NAMESPACE"] ?? "default";
const HERE = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const server = await startTestServer({ port: PORT });
  const wiki = wikiOn(server.url, documentPageTypes, { namespace: NAMESPACE });

  const started = Date.now();
  const manifest = await seed(wiki, (m) => console.log(`[bench-fixture] ${m}`));
  await wiki.close(); // the writer is done; the server keeps serving the seeded streams
  writeFileSync(join(HERE, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`[bench-fixture] seeded in ${Date.now() - started}ms`);
  console.log(`READY ${server.url}`);

  const stop = (): void => void server.stop().then(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

void main().catch((e: unknown) => {
  console.error("[bench-fixture] failed:", e);
  process.exit(1);
});
