/**
 * Brings up the two processes the scenarios run against and tears them down again.
 *
 * Not Playwright's `webServer`: the fixture host must be seeded and READY before the Next
 * server starts, and it announces that over stdout rather than by opening a port.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE_URL, MIRROR_URL, NEXT_PORT, STREAM_PORT, STREAM_URL } from "./ports";

const UI = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = ".next-bench";

function git(args: string): string {
  try {
    return execFileSync("git", args.split(" "), { cwd: UI, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

/** Env the bench build BAKES IN, and that `next start` must be given again. */
function buildEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NEXT_DIST_DIR: DIST,
    NEXT_PUBLIC_WIKI_STREAM_BASE_URL: STREAM_URL,
    NEXT_PUBLIC_WIKI_NAMESPACE: process.env["BENCH_NAMESPACE"] ?? "default",
    NEXT_PUBLIC_WIKI_MIRROR_HEALTH_URL: MIRROR_URL,
    NEXT_PUBLIC_BUILD_COMMIT: git("rev-parse HEAD"),
    NEXT_PUBLIC_BUILD_BRANCH: git("rev-parse --abbrev-ref HEAD"),
  };
}

function newestMtime(dir: string): number {
  let newest = 0;
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else newest = Math.max(newest, statSync(full).mtimeMs);
    }
  };
  walk(dir);
  return newest;
}

/** The build dominates iteration time, so skip it when nothing it depends on has moved. */
function buildIsCurrent(): boolean {
  const stamp = join(UI, DIST, "BUILD_ID");
  if (!existsSync(stamp)) return false;
  const built = statSync(stamp).mtimeMs;
  const sources = ["app", "components", "lib"].map((d) => newestMtime(join(UI, d)));
  sources.push(statSync(join(UI, "next.config.mjs")).mtimeMs);
  return built > Math.max(...sources);
}

function run(cmd: string, args: readonly string[], env: NodeJS.ProcessEnv): void {
  execFileSync(cmd, args as string[], { cwd: UI, env, stdio: "inherit" });
}

/** Spawn `child` and resolve once its stdout emits a line matching `ready`. */
function waitForLine(child: ChildProcess, ready: RegExp, label: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`${label} did not become ready in ${timeoutMs}ms:\n${out}`)), timeoutMs);
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    child.stdout?.on("data", (b: Buffer) => {
      const chunk = b.toString();
      out += chunk;
      process.stdout.write(`[${label}] ${chunk}`);
      if (ready.test(out)) done();
    });
    child.stderr?.on("data", (b: Buffer) => {
      out += b.toString();
      process.stderr.write(`[${label}] ${b.toString()}`);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`${label} exited early (${code}):\n${out}`));
    });
  });
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`${url} never answered within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const env = buildEnv();

  const fixture = spawn(join(UI, "node_modules", ".bin", "tsx"), ["bench/fixture/server.ts"], {
    cwd: UI,
    env: { ...process.env, BENCH_STREAM_PORT: String(STREAM_PORT) },
  });
  await waitForLine(fixture, /^READY /m, "fixture", 180_000);

  if (process.env["BENCH_SKIP_BUILD"] === "1" || buildIsCurrent()) {
    console.log("[bench] reusing the existing .next-bench build");
  } else {
    console.log("[bench] building to .next-bench (the dev server's .next is untouched)");
    run("npm", ["run", "copy-pglite-assets"], env);
    run(join(UI, "node_modules", ".bin", "next"), ["build"], env);
  }

  const next = spawn(join(UI, "node_modules", ".bin", "next"), ["start", "-p", String(NEXT_PORT)], { cwd: UI, env });
  next.stdout?.on("data", (b: Buffer) => process.stdout.write(`[next] ${b.toString()}`));
  next.stderr?.on("data", (b: Buffer) => process.stderr.write(`[next] ${b.toString()}`));
  await waitForHttp(BASE_URL, 60_000);
  console.log(`[bench] ready — ui ${BASE_URL}, stream ${STREAM_URL}`);

  return async () => {
    next.kill("SIGTERM");
    fixture.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));
  };
}
