/**
 * One JSON per run under bench/results/ (gitignored — timings are machine-dependent and a
 * committed series invites comparisons across machines that mean nothing). Raw samples are kept
 * alongside the summary so stats can be re-derived and bimodality spotted after the fact.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { cpus, arch, loadavg, platform, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sample } from "./lib/measure";
import { summarize, type Stats } from "./lib/stats";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(HERE, "results");

const METRICS = [
  "clickToPainted",
  "routeCommitMs",
  "toMarkdownMs",
  "describeMutationsMs",
  "renderMarkdownMs",
  "commitToPaint",
] as const;

export interface ScenarioResult {
  readonly name: string;
  readonly n: number;
  readonly metrics: Record<string, Stats>;
  readonly samples: readonly Sample[];
  readonly notes?: string;
  /** Scenario-specific detail that is not a per-navigation metric (e.g. cold boot records). */
  readonly extra?: unknown;
}

const scenarios: ScenarioResult[] = [];

export function record(name: string, samples: readonly Sample[], notes?: string, extra?: unknown): ScenarioResult {
  const metrics: Record<string, Stats> = {};
  for (const m of METRICS) metrics[m] = summarize(samples.map((s) => s[m]));
  const result: ScenarioResult = {
    name,
    n: samples.length,
    metrics,
    samples,
    ...(notes !== undefined ? { notes } : {}),
    ...(extra !== undefined ? { extra } : {}),
  };
  scenarios.push(result);
  return result;
}

function git(args: string): string {
  try {
    return execFileSync("git", args.split(" "), { cwd: HERE, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

/** A one-line-per-metric summary, so a run is readable without opening the JSON. */
export function printSummary(): void {
  for (const s of scenarios) {
    console.log(`\n  ${s.name}  (n=${s.n})${s.notes !== undefined ? `  — ${s.notes}` : ""}`);
    for (const [metric, st] of Object.entries(s.metrics)) {
      const p95 = s.n >= 20 ? `  p95 ${String(st.p95).padStart(8)}` : "";
      console.log(`    ${metric.padEnd(20)} p50 ${String(st.p50).padStart(8)}${p95}  min ${String(st.min).padStart(8)}  max ${String(st.max).padStart(8)}`);
    }
  }
}

export function write(fixture: Record<string, unknown>, browser: Record<string, unknown>, startedAt: string): string {
  mkdirSync(RESULTS, { recursive: true });
  const commit = git("rev-parse HEAD");
  const stamp = startedAt.replace(/[:.]/g, "-");
  const file = join(RESULTS, `${stamp}-${commit.slice(0, 7)}.json`);
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        startedAt,
        durationMs: Date.now() - Date.parse(startedAt),
        git: { commit, branch: git("rev-parse --abbrev-ref HEAD"), dirty: git("status --porcelain") !== "" },
        machine: { os: platform(), arch: arch(), cpus: cpus().length, totalMemMB: Math.round(totalmem() / 1e6), node: process.version, loadavg: loadavg().map((n) => Math.round(n * 100) / 100) },
        browser,
        fixture,
        // p95 needs a sample count that supports it; scenarios below 20 report p50/min/max only.
        scenarios,
      },
      null,
      2,
    )}\n`,
  );
  return file;
}
