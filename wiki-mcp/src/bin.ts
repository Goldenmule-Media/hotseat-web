#!/usr/bin/env node
/**
 * Standalone `bin` entry for `wiki-mcp` (DESIGN §6). Runs the library's {@link main}
 * over stdio with NO page types registered (a host injects real ones).
 *
 * This is kept SEPARATE from `./main` (the library) on purpose: `wiki-server` embeds
 * `wiki-mcp` by bundling it FROM SOURCE (DESIGN §10). When a bundler inlines many
 * modules into one file they all share that file's `import.meta.url`, so an
 * `import.meta.url === file://${process.argv[1]}` self-exec guard placed in the
 * library would match the HOST's argv and boot a second, rogue stdio server inside
 * the host. Housing the guard here — in a module the host never imports — prevents that.
 */
import { main } from "./main.js";

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
