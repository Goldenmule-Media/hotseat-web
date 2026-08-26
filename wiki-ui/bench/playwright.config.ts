import { defineConfig, devices } from "@playwright/test";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE_URL } from "./ports";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Chromium only, and that is sufficient rather than a shortcut: wiki-ui requires a
 * `{type:"module"}` SharedWorker and refuses anything else outright (lib/host-client.ts), which
 * rules out Playwright's WebKit and its patched Firefox. Cross-engine comparison is not the goal.
 *
 * One worker, no parallelism, no retries — a timing run must not contend for CPU with itself,
 * and a retried sample is a fabricated one.
 */
export default defineConfig({
  testDir: HERE,
  testMatch: /.*\.bench\.spec\.ts/,
  globalSetup: "./global-setup.ts",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 300_000,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    headless: true,
    launchOptions: {
      // A backgrounded renderer gets throttled timers and rAF, which is exactly what we measure.
      args: [
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows",
      ],
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
