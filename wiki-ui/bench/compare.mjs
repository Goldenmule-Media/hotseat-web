// Compare two benchmark runs. Defaults to the two most recent under bench/results/.
//
//   node bench/compare.mjs [older.json] [newer.json] [--fail]
//
// Refuses to compare across fixture versions or CPU architectures: those are different axes,
// and putting them on one table produces a number that looks meaningful and isn't.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(HERE, "results");
const REGRESSION_PCT = 15;

const args = process.argv.slice(2);
const fail = args.includes("--fail");
const files = args.filter((a) => !a.startsWith("--"));

function latest(n) {
  const all = readdirSync(RESULTS).filter((f) => f.endsWith(".json")).sort();
  if (all.length < n) {
    console.error(`need ${n} runs in bench/results/, found ${all.length}`);
    process.exit(2);
  }
  return all.slice(-n).map((f) => join(RESULTS, f));
}

const [aPath, bPath] = files.length === 2 ? files : latest(2);
const a = JSON.parse(readFileSync(aPath, "utf8"));
const b = JSON.parse(readFileSync(bPath, "utf8"));

for (const [what, x, y] of [
  ["fixture version", a.fixture.fixtureVersion, b.fixture.fixtureVersion],
  ["architecture", a.machine.arch, b.machine.arch],
]) {
  if (x !== y) {
    console.error(`refusing to compare: ${what} differs (${x} vs ${y}) — these are not the same axis`);
    process.exit(2);
  }
}

const pad = (s, n) => String(s).padStart(n);
console.log(`\n  A  ${a.git.branch}@${a.git.commit.slice(0, 7)}${a.git.dirty ? "*" : ""}  ${a.startedAt}`);
console.log(`  B  ${b.git.branch}@${b.git.commit.slice(0, 7)}${b.git.dirty ? "*" : ""}  ${b.startedAt}`);
console.log(`     load at A ${a.machine.loadavg[0]}, at B ${b.machine.loadavg[0]}\n`);

let regressed = 0;
for (const sb of b.scenarios) {
  const sa = a.scenarios.find((s) => s.name === sb.name);
  if (sa === undefined) {
    console.log(`  ${sb.name}: new in B, nothing to compare`);
    continue;
  }
  console.log(`  ${sb.name}  (n=${sa.n} → ${sb.n})`);
  for (const [metric, stB] of Object.entries(sb.metrics)) {
    const stA = sa.metrics[metric];
    if (stA === undefined) continue;
    const delta = stB.p50 - stA.p50;
    const pct = stA.p50 === 0 ? 0 : (delta / stA.p50) * 100;
    const bad = pct > REGRESSION_PCT && Math.abs(delta) > 1;
    if (bad) regressed++;
    const flag = bad ? "  ← regression" : "";
    console.log(
      `    ${metric.padEnd(20)} p50 ${pad(stA.p50, 8)} → ${pad(stB.p50, 8)}   ${pad((delta >= 0 ? "+" : "") + delta.toFixed(1), 8)}  ${pad((pct >= 0 ? "+" : "") + pct.toFixed(0) + "%", 6)}${flag}`,
    );
  }
  console.log("");
}

if (regressed > 0) {
  console.log(`  ${regressed} metric(s) regressed by more than ${REGRESSION_PCT}%.\n`);
  if (fail) process.exit(1);
}
