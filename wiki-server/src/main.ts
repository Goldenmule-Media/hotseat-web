#!/usr/bin/env node
/**
 * wiki-server entrypoint (DESIGN §8.1). Boot one {@link DurableStreamTestServer}
 * with the resolved config, log its base URL, and trap signals for a clean
 * shutdown. That is the whole job — the server is a content-agnostic stream host
 * (DESIGN §3); it imports `@durable-streams/server`, never `wiki`.
 */
import { DurableStreamTestServer } from "@durable-streams/server";

// NOTE: `.js` extension is required because wiki-server is COMPILED and run via
// `node dist/main.js` (raw Node ESM needs explicit extensions). This differs from
// `wiki/`, which is consumed as TS source and so imports extensionless.
import { configWarnings, resolveConfig, type WikiServerConfig } from "./config.js";

const cfg = resolveConfig(process.argv.slice(2), process.env);

/** Emit one structured (or pretty) log line. */
function log(obj: Record<string, unknown>): void {
  if (cfg.logFormat === "json") {
    console.log(JSON.stringify(obj));
    return;
  }
  const { msg, ...rest } = obj;
  const tail = Object.entries(rest)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ` ${k}=${v}`)
    .join("");
  console.log(`[wiki-server] ${msg ?? ""}${tail}`);
}

for (const warning of configWarnings(cfg)) {
  console.warn(`[wiki-server] WARNING: ${warning}`);
}

/** Build the server options, selecting storage mode by `dataDir` presence (DESIGN §4/§7). */
function serverOptions(c: WikiServerConfig) {
  return {
    host: c.host,
    port: c.port,
    longPollTimeout: c.longPollTimeout,
    ...(c.storage === "file" ? { dataDir: c.dataDir } : {}),
  };
}

const server = new DurableStreamTestServer(serverOptions(cfg));
const baseUrl = await server.start();
log({
  msg: "wiki-server up",
  baseUrl,
  storage: cfg.storage,
  dataDir: cfg.storage === "file" ? cfg.dataDir : undefined,
});

let stopping = false;
/** Graceful shutdown: stop() drains connections, cancels long-polls/SSE, closes the store. */
function shutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  log({ msg: "shutting down", signal });
  server
    .stop()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(`[wiki-server] shutdown failed:`, err);
      process.exit(1);
    });
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => shutdown(signal));
}
