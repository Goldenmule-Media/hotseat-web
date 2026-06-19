// Capture the git branch + commit at build time and write them to `.env.production.local`
// so Next inlines them into the client bundle as NEXT_PUBLIC_* (the engine runs in the
// browser, so build info has to ride along as public env). This is what powers the build
// badge in the sidebar foot, letting you confirm WHICH commit a deploy is actually serving.
//
// Source of truth, in order: AWS Amplify's injected build vars (AWS_COMMIT_ID / AWS_BRANCH),
// then a local `git` call as a fallback for `npm run build` off-CI. Amplify checks out a
// detached HEAD, so AWS_BRANCH is the only reliable branch name there.
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
