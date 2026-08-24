#!/usr/bin/env node
/**
 * Assemble the portable `wiki-mirror` artifact: a folder you copy to any Mac with `node` on it.
 *
 *   build/wiki-mirror-portable/
 *     wiki-mirror.mjs      the whole mirror + engine, importing nothing but node: builtins
 *     models/              the built wiki-models bundles, loaded by absolute path at runtime
 *     install-agent.sh     installs it as a launchd user agent
 *     README.md            how to run it
 *   build/wiki-mirror-portable.tar.gz
 *
 * The schema is a SNAPSHOT: page types live in wiki-models, so an artifact renders whatever the
 * models looked like when it was built. Rebuild after changing them.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "..");
const outRoot = join(packageRoot, "build");
const outDir = join(outRoot, "wiki-mirror-portable");

const run = (command, args, cwd) => {
  process.stdout.write(`  $ ${command} ${args.join(" ")}\n`);
  execFileSync(command, args, { cwd, stdio: ["ignore", "inherit", "inherit"] });
};

console.log("wiki-mirror: building the portable artifact");
rmSync(outRoot, { recursive: true, force: true });
mkdirSync(join(outDir, "models"), { recursive: true });

// 1. The single-file mirror.
run("npm", ["run", "build:portable", "-w", "wiki-mirror"], repoRoot);
cpSync(join(packageRoot, "dist-portable", "bin.mjs"), join(outDir, "wiki-mirror.mjs"));

// 2. The schema, as loose files. Shared chunks travel too: the entry bundles import them
//    relatively, and the loader skips whatever isn't a bundle.
run("npm", ["run", "build", "-w", "wiki-models"], repoRoot);
const modelsDist = join(repoRoot, "wiki-models", "dist");
const bundles = readdirSync(modelsDist).filter((f) => f.endsWith(".js"));
if (bundles.length === 0) throw new Error(`no built model bundles in ${modelsDist}`);
for (const file of bundles) cpSync(join(modelsDist, file), join(outDir, "models", file));

// 3. The installer + its docs.
cpSync(join(packageRoot, "scripts", "install-agent.sh"), join(outDir, "install-agent.sh"));
chmodSync(join(outDir, "install-agent.sh"), 0o755);
const version = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version;
writeFileSync(join(outDir, "README.md"), readme(version), "utf8");

// 4. One archive to copy around. `-C` so the tar unpacks as a single folder.
run("tar", ["-czf", join(outRoot, "wiki-mirror-portable.tar.gz"), "-C", outRoot, "wiki-mirror-portable"]);

const sizeMb = (path) => (readFileSync(path).byteLength / 1024 / 1024).toFixed(1);
console.log(`\n  ${outDir}`);
console.log(`  wiki-mirror.mjs  ${sizeMb(join(outDir, "wiki-mirror.mjs"))} MB`);
console.log(`  models/          ${bundles.length} files`);
console.log(`  ${join(outRoot, "wiki-mirror-portable.tar.gz")}  ${sizeMb(join(outRoot, "wiki-mirror-portable.tar.gz"))} MB\n`);

function readme(version) {
  return `# wiki-mirror ${version} (portable)

The local Markdown mirror: it tails a wiki-server's Durable Stream and writes the deterministic
Markdown tree into a checkout on this machine. Everything is in this folder — the only
requirement is **Node 20+** (\`node --version\`).

## Run it once, by hand

\`\`\`sh
node wiki-mirror.mjs login --stream-url https://your-wiki.example.com   # opens a browser
node wiki-mirror.mjs --models= --models-dir ./models
\`\`\`

\`--models=\` (empty) clears any bare package specifiers in your config file: this artifact has no
node_modules, so its schema must come from \`--models-dir\`.

## Run it as a background service

\`\`\`sh
./install-agent.sh --mode portable        # a launchd user agent, started at login
./install-agent.sh --status
./install-agent.sh --restart              # after editing the config
./install-agent.sh --uninstall
\`\`\`

## Configure it

Per-machine, at \`~/.wiki/wiki-mirror.config.json\` (one file, shared by every project on this
Mac). Roots must be **absolute**, and each workspace needs its **own** root:

\`\`\`json
{
  "streamBaseUrl": "https://your-wiki.example.com",
  "namespace": "default",
  "emitters": [
    { "workspaceId": "ws:...", "root": "/Users/you/projects/thing/docs" }
  ]
}
\`\`\`

It is read once at startup — restart after editing. \`GET http://127.0.0.1:4440/_mirror/status\`
reports what it is doing, and \`/_mirror/workspaces\` lists the workspaces you could mirror.

## The schema is a snapshot

Page types live in \`models/\`, frozen at build time. If the wiki gains a new page type, pages of
that type render as a notice until you copy over a newer artifact.
`;
}
