#!/usr/bin/env node
// extract-wiki-trace.mjs — deterministic Claude-session JSONL → compact "wiki interaction trace".
//
// A session transcript is large (often 1–5 MB) and mostly noise for this purpose. This script walks
// it once and emits a small JSON object capturing ONLY what matters for reviewing how an agent used
// the wiki MCP: the human asks, and every `mcp__wiki__*` call in order — each paired with the model's
// stated intent/reasoning right before it, its (truncated) args, and its (truncated) result incl. the
// error flag. Plus interleaved non-wiki tool names (to show churn) and summary stats. No deps; Node ≥20.
//
// Usage:
//   node extract-wiki-trace.mjs <sessionId | /path/to/transcript.jsonl> [--project <substr>] [--out <path>]
//   node extract-wiki-trace.mjs --list [--limit 20]        # recent transcripts that used wiki tools
//
// Output: writes the trace JSON to --out (default: $TMPDIR/wiki-trace-<id>.json) and prints a
// human-readable summary to stdout, with the trace path on a line beginning "trace: ".

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const HOME = os.homedir();
const PROJECTS_DIR = path.join(HOME, ".claude", "projects");

// ---- wiki tool classification --------------------------------------------------------------------
const WIKI_PREFIX = "mcp__wiki__";
const READ_TOOLS = new Set([
  "describeMutations", "describePageType", "getPage", "tree", "renderPage", "outline",
  "symbols", "references", "search", "listWorkspaces", "listEmitters", "nextActions", "attention",
]);
// Anything else under mcp__wiki__ is treated as a write/mutation (createPage, mutatePage,
// mutatePageBatch, link, unlink, setPageTitle, reparent, archive*/unarchive*, createWorkspace,
// assignSerials, renameSymbol, configureEmitter, removeEmitter, …).

// ---- arg parsing -----------------------------------------------------------------------------------
const argv = process.argv.slice(2);
// maxInput is deliberately small: we want the STRUCTURE of each call (which commands, refs, levels,
// statuses, ids) — not the authored prose. Clipping long text fields keeps the trace readable in one
// pass while preserving every structural/affordance signal that matters for model optimization.
const opts = { project: null, out: null, list: false, limit: 20, maxInput: 240, maxResult: 700, maxIntent: 520 };
let target = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--list") opts.list = true;
  else if (a === "--project") opts.project = argv[++i];
  else if (a === "--out") opts.out = argv[++i];
  else if (a === "--limit") opts.limit = Number(argv[++i]) || 20;
  else if (a === "--max-input") opts.maxInput = Number(argv[++i]) || 700;
  else if (a === "--max-result") opts.maxResult = Number(argv[++i]) || 900;
  else if (a === "--max-intent") opts.maxIntent = Number(argv[++i]) || 600;
  else if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
  else if (!a.startsWith("--") && target == null) target = a;
}

function printHelp() {
  process.stdout.write(
    "extract-wiki-trace.mjs — compact a Claude session's wiki MCP usage into a review trace.\n\n" +
    "  node extract-wiki-trace.mjs <sessionId | transcript.jsonl> [--project <substr>] [--out <path>]\n" +
    "  node extract-wiki-trace.mjs --list [--limit 20]\n",
  );
}

// ---- helpers ---------------------------------------------------------------------------------------
function truncStr(s, n) {
  if (typeof s !== "string") return s;
  if (s.length <= n) return s;
  return s.slice(0, n) + `…[+${s.length - n} chars]`;
}
function deepTrunc(v, n, depth = 0) {
  if (v == null) return v;
  if (typeof v === "string") return truncStr(v, n);
  if (typeof v !== "object" || depth > 6) return v;
  if (Array.isArray(v)) {
    const cap = 40;
    const out = v.slice(0, cap).map((x) => deepTrunc(x, n, depth + 1));
    if (v.length > cap) out.push(`…[+${v.length - cap} more items]`);
    return out;
  }
  const out = {};
  for (const [k, val] of Object.entries(v)) out[k] = deepTrunc(val, n, depth + 1);
  return out;
}
// Flatten a message-content value (string | array of blocks) to plain text.
function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const b of content) {
    if (typeof b === "string") parts.push(b);
    else if (b && b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n");
}
function resultToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const b of content) {
      if (typeof b === "string") parts.push(b);
      else if (b && typeof b.text === "string") parts.push(b.text);
      else if (b) parts.push(JSON.stringify(b));
    }
    return parts.join("\n");
  }
  if (content == null) return "";
  return JSON.stringify(content);
}
function readLines(file) {
  const raw = fs.readFileSync(file, "utf8");
  return raw.split("\n");
}
function parseJsonl(file) {
  const recs = [];
  for (const line of readLines(file)) {
    const t = line.trim();
    if (!t) continue;
    try { recs.push(JSON.parse(t)); } catch { /* skip non-JSON line */ }
  }
  return recs;
}

// ---- --list mode -----------------------------------------------------------------------------------
function listWikiSessions() {
  if (!fs.existsSync(PROJECTS_DIR)) { console.error(`no projects dir at ${PROJECTS_DIR}`); process.exit(1); }
  const rows = [];
  for (const proj of fs.readdirSync(PROJECTS_DIR)) {
    if (opts.project && !proj.includes(opts.project)) continue;
    const dir = path.join(PROJECTS_DIR, proj);
    let entries;
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const f of entries) {
      if (!f.endsWith(".jsonl")) continue;
      const full = path.join(dir, f);
      let stat, raw;
      try { stat = fs.statSync(full); raw = fs.readFileSync(full, "utf8"); } catch { continue; }
      const count = (raw.match(/mcp__wiki__/g) || []).length;
      // The static tool catalog mentions each wiki tool ~twice; real usage pushes the count well above
      // that floor. Require a margin so we don't list sessions that merely had wiki tools available.
      if (count <= 60) continue;
      rows.push({ id: f.replace(/\.jsonl$/, ""), project: proj, mtime: stat.mtimeMs, hits: count, bytes: stat.size });
    }
  }
  rows.sort((a, b) => b.mtime - a.mtime);
  const top = rows.slice(0, opts.limit);
  if (top.length === 0) { console.log("(no transcripts with substantial wiki usage found)"); return; }
  console.log(`# transcripts with wiki usage (most recent first, top ${top.length}):\n`);
  for (const r of top) {
    const when = new Date(r.mtime).toISOString().replace("T", " ").slice(0, 16);
    console.log(`${r.id}  [${when}]  ~${r.hits} wiki refs  ${(r.bytes / 1024 / 1024).toFixed(1)}MB`);
    console.log(`    project: ${r.project}`);
  }
}

// ---- resolve a transcript path from a session id or path -------------------------------------------
function resolveTranscript(t) {
  if (!t) { console.error("error: provide a sessionId or transcript path, or use --list"); process.exit(2); }
  if (t.endsWith(".jsonl") && fs.existsSync(t)) return t;
  if (fs.existsSync(t) && fs.statSync(t).isFile()) return t;
  // treat as a session id
  if (!fs.existsSync(PROJECTS_DIR)) { console.error(`no projects dir at ${PROJECTS_DIR}`); process.exit(1); }
  const matches = [];
  for (const proj of fs.readdirSync(PROJECTS_DIR)) {
    if (opts.project && !proj.includes(opts.project)) continue;
    const candidate = path.join(PROJECTS_DIR, proj, `${t}.jsonl`);
    if (fs.existsSync(candidate)) matches.push(candidate);
  }
  if (matches.length === 0) {
    console.error(`error: no transcript found for "${t}"${opts.project ? ` (project filter: ${opts.project})` : ""}.`);
    console.error(`hint: run with --list to see sessions that used the wiki.`);
    process.exit(3);
  }
  if (matches.length > 1) {
    console.error(`warning: multiple transcripts matched "${t}"; using the first:\n  ${matches.join("\n  ")}`);
  }
  return matches[0];
}

// ---- main extraction -------------------------------------------------------------------------------
function extract(transcriptPath) {
  const recs = parseJsonl(transcriptPath);
  const bytes = fs.statSync(transcriptPath).size;

  const trace = {
    schema: "wiki-trace/v1",
    meta: {
      sessionId: null, transcriptPath, projectPath: null, gitBranch: null,
      records: recs.length, generatedFromBytes: bytes,
    },
    stats: {
      wikiCalls: 0, wikiWrites: 0, wikiReads: 0, errors: 0,
      callsByTool: {}, errorsByTool: {}, retriesAfterError: 0,
      sidechainCalls: 0, userPromptCount: 0, maxReadStreak: 0,
    },
    userPrompts: [],
    timeline: [],
  };

  const pending = new Map(); // tool_use_id -> timeline entry awaiting its result
  let lastText = null;       // most-recent assistant text block (stated action)
  let lastThinking = null;   // most-recent assistant thinking block (reasoning)
  let otherSince = [];       // non-wiki tool names since the previous wiki call
  let curReadStreak = 0;
  let prevWiki = null;       // previous wiki timeline entry (for retry-after-error detection)
  let recordIndex = -1;

  for (const r of recs) {
    recordIndex++;
    if (r.sessionId && !trace.meta.sessionId) trace.meta.sessionId = r.sessionId;
    if (r.cwd && !trace.meta.projectPath) trace.meta.projectPath = r.cwd;
    if (r.gitBranch && !trace.meta.gitBranch) trace.meta.gitBranch = r.gitBranch;

    if (r.type === "assistant") {
      const blocks = r.message?.content;
      if (!Array.isArray(blocks)) continue;
      for (const b of blocks) {
        if (b.type === "thinking" && typeof b.thinking === "string") lastThinking = b.thinking;
        else if (b.type === "text" && typeof b.text === "string") lastText = b.text;
        else if (b.type === "tool_use") {
          const name = b.name || "";
          if (name.startsWith(WIKI_PREFIX)) {
            const tool = name.slice(WIKI_PREFIX.length);
            const kind = READ_TOOLS.has(tool) ? "read" : "write";
            const entry = {
              seq: trace.timeline.length,
              recordIndex,
              ts: r.timestamp || null,
              isSidechain: !!r.isSidechain,
              kind,
              tool,
              intent: lastText ? truncStr(lastText, opts.maxIntent) : null,
              reasoning: lastThinking ? truncStr(lastThinking, opts.maxIntent) : null,
              input: deepTrunc(b.input ?? {}, opts.maxInput),
              result: null, // filled when the tool_result arrives
              otherToolsSince: otherSince.length ? otherSince.slice(0, 30) : undefined,
            };
            trace.timeline.push(entry);
            pending.set(b.id, entry);

            // stats
            trace.stats.wikiCalls++;
            if (kind === "read") { trace.stats.wikiReads++; curReadStreak++; }
            else { trace.stats.wikiWrites++; curReadStreak = 0; }
            trace.stats.maxReadStreak = Math.max(trace.stats.maxReadStreak, curReadStreak);
            if (entry.isSidechain) trace.stats.sidechainCalls++;
            trace.stats.callsByTool[tool] = (trace.stats.callsByTool[tool] || 0) + 1;
            if (prevWiki && prevWiki.result?.isError && prevWiki.tool === tool) trace.stats.retriesAfterError++;
            prevWiki = entry;
            otherSince = [];
          } else {
            // non-wiki tool: record its bare name as churn context for the next wiki call
            const short = name.startsWith("mcp__") ? name : name.split("__").pop();
            otherSince.push(short);
          }
        }
      }
    } else if (r.type === "user") {
      const content = r.message?.content;
      const isToolResultOnly = Array.isArray(content) && content.length > 0 && content.every((b) => b && b.type === "tool_result");
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b && b.type === "tool_result" && pending.has(b.tool_use_id)) {
            const entry = pending.get(b.tool_use_id);
            const text = resultToText(b.content);
            const isErr = !!b.is_error;
            entry.result = { isError: isErr, length: text.length, text: truncStr(text, opts.maxResult) };
            if (isErr) {
              trace.stats.errors++;
              trace.stats.errorsByTool[entry.tool] = (trace.stats.errorsByTool[entry.tool] || 0) + 1;
            }
            pending.delete(b.tool_use_id);
          }
        }
      }
      // capture genuine human prompts (not tool results, not system-injected meta)
      if (!r.isMeta && !isToolResultOnly && !r.isSidechain) {
        let text = contentToText(content).trim();
        // Unwrap slash-command envelopes: keep the command + its args (the real intent), drop the chrome.
        const cmd = text.match(/<command-name>([^<]*)<\/command-name>/);
        if (cmd) {
          const cargs = (text.match(/<command-args>([^<]*)<\/command-args>/) || [, ""])[1].trim();
          text = `/${cmd[1].replace(/^\//, "").trim()}${cargs ? " " + cargs : ""}`.trim();
        }
        // drop harness-injected envelopes (notifications, reminders, command stdout) and bare meta cmds
        const isHarness = /^<(local-command|task-notification|system-reminder|command-message|command-stdout)/.test(text);
        if (text && !isHarness && text !== "/clear" && text !== "/compact") {
          trace.userPrompts.push({ seq: trace.userPrompts.length, ts: r.timestamp || null, text: truncStr(text, 1000) });
        }
      }
    }
  }
  trace.stats.userPromptCount = trace.userPrompts.length;
  return trace;
}

// ---- run -------------------------------------------------------------------------------------------
if (opts.list) { listWikiSessions(); process.exit(0); }

const transcriptPath = resolveTranscript(target);
const trace = extract(transcriptPath);
const id = trace.meta.sessionId || path.basename(transcriptPath, ".jsonl");
const outPath = opts.out || path.join(os.tmpdir(), `wiki-trace-${id}.json`);
fs.writeFileSync(outPath, JSON.stringify(trace, null, 2));

// human-readable summary (the SKILL spine parses the `trace:` line for the path)
const s = trace.stats;
const topTools = Object.entries(s.callsByTool).sort((a, b) => b[1] - a[1]).slice(0, 8)
  .map(([k, v]) => `${k}×${v}`).join(", ");
const errTools = Object.entries(s.errorsByTool).sort((a, b) => b[1] - a[1])
  .map(([k, v]) => `${k}×${v}`).join(", ") || "none";
console.log(`trace: ${outPath}`);
console.log(`session: ${id}`);
console.log(`project: ${trace.meta.projectPath || "?"}   branch: ${trace.meta.gitBranch || "?"}   records: ${trace.meta.records}`);
console.log(`wiki calls: ${s.wikiCalls} (writes ${s.wikiWrites}, reads ${s.wikiReads})   errors: ${s.errors}   retries-after-error: ${s.retriesAfterError}   max-read-streak: ${s.maxReadStreak}   sidechain: ${s.sidechainCalls}`);
console.log(`user prompts: ${s.userPromptCount}`);
console.log(`top tools: ${topTools}`);
console.log(`errors by tool: ${errTools}`);
