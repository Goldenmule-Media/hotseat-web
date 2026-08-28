// Write the git branch + commit to .env.production.local so Next inlines them as NEXT_PUBLIC_*
// for the build badge. Amplify's AWS_* vars first (detached HEAD there), local git as fallback.
//
// It also carries SERVER-ONLY variables from the build environment into the build. Amplify
// exposes its console variables to the build but not to the SSR compute runtime, so a route
// handler reading process.env finds nothing unless the value is captured here. None of these
// names carries a NEXT_PUBLIC_ prefix, which is the only thing that would put them in front of
// a browser: they stay server-side. The tradeoff is real and deliberate — the value ends up
// inside the deployed build output, so this is the wrong home for a secret that must never sit
// in an artifact. Absent variables are skipped, so a local build writes none of them.
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function git(args, fallback) {
  try {
    return execSync(`git ${args}`, { cwd: root, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return fallback;
  }
}

const commit = process.env.AWS_COMMIT_ID || git("rev-parse HEAD", "unknown");
const branch = process.env.AWS_BRANCH || git("rev-parse --abbrev-ref HEAD", "unknown");
const time = new Date().toISOString();

/** Server-only names a route handler reads at request time. Never NEXT_PUBLIC_. */
const RUNTIME_PASSTHROUGH = ["ANTHROPIC_API_KEY", "WIKI_STREAM_BASE_URL", "WIKI_UI_CHAT_TIMEOUT_MS"];

const carried = RUNTIME_PASSTHROUGH.filter((name) => (process.env[name] ?? "") !== "");

const body =
  `NEXT_PUBLIC_BUILD_COMMIT=${commit}\n` +
  `NEXT_PUBLIC_BUILD_BRANCH=${branch}\n` +
  `NEXT_PUBLIC_BUILD_TIME=${time}\n` +
  carried.map((name) => `${name}=${process.env[name]}\n`).join("");

writeFileSync(join(root, ".env.production.local"), body);
// Names only. A build log is not a place to print a key.
console.log(
  `[write-build-info] ${branch}@${commit.slice(0, 7)} (${time})` +
    (carried.length > 0 ? ` — carried ${carried.join(", ")}` : " — no server-only variables in the build environment"),
);
