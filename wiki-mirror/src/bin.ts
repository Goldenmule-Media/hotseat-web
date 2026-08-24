#!/usr/bin/env node
/**
 * Standalone `bin` entry for `wiki-mirror`. Runs the library's {@link main} — resolving config
 * from flags/env/file and starting the mirror — and exits nonzero on a fatal boot error.
 */
import { HealthPortInUseError, main } from "./main.js";

main().catch((err: unknown) => {
  // A port already owned by another mirror is a PARKING condition, not a crash: exit 0 so a
  // supervisor (launchd's KeepAlive is `SuccessfulExit:false`) leaves us stopped instead of
  // respawning into the same collision every few seconds. Print the message, not the stack.
  if (err instanceof HealthPortInUseError) {
    console.error(err.message);
    process.exit(0);
  }
  console.error(err);
  process.exit(1);
});
