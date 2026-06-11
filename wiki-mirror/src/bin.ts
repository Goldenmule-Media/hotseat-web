#!/usr/bin/env node
/**
 * Standalone `bin` entry for `wiki-mirror`. Runs the library's {@link main} — resolving config
 * from flags/env/file and starting the mirror — and exits nonzero on a fatal boot error.
 */
import { main } from "./main.js";

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
