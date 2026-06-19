// Write the git branch + commit to .env.production.local so Next inlines them as NEXT_PUBLIC_*
// for the build badge. Amplify's AWS_* vars first (detached HEAD there), local git as fallback.
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

const body =
  `NEXT_PUBLIC_BUILD_COMMIT=${commit}\n` +
  `NEXT_PUBLIC_BUILD_BRANCH=${branch}\n` +
  `NEXT_PUBLIC_BUILD_TIME=${time}\n`;

writeFileSync(join(root, ".env.production.local"), body);
console.log(`[write-build-info] ${branch}@${commit.slice(0, 7)} (${time})`);
