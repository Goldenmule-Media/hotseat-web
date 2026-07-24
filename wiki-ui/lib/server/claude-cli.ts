/**
 * Server-only wrapper around the LOCAL `claude` CLI in print mode — the only LLM
 * transport in this app (never the Anthropic SDK/API). Ported from quiner's
 * runClaude with deliberate changes: non-detached children (no tools → no subprocess
 * tree; the child must die with the dev server), a stable scratch cwd outside any
 * repo (`--resume` continuity is cwd-keyed), and an always-on empty MCP config with
 * --strict-mcp-config so the spawned claude can never discover a project .mcp.json
 * and gain authenticated wiki write tools.
 *
 * Lives under lib/server/ — importing it from client code fails the build (node builtins).
 */

import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Every built-in tool, disallowed: the critic reads its prompt and writes text, nothing else. */
export const CRITIC_DISALLOWED_TOOLS: readonly string[] = [
  "Bash",
  "Write",
  "Edit",
  "Read",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "Task",
  "NotebookEdit",
  "TodoWrite",
];

const SCRATCH_DIR = join(homedir(), ".wiki", "spec-restatement", "scratch");
const MCP_CONFIG_PATH = join(SCRATCH_DIR, "mcp-config.json");

let scratchReady = false;

/** Stable scratch cwd (NOT per-call mkdtemp) + the empty MCP config, created at first use. */
export function ensureScratchDir(): { cwd: string; mcpConfigPath: string } {
  if (!scratchReady) {
    mkdirSync(SCRATCH_DIR, { recursive: true });
    writeFileSync(MCP_CONFIG_PATH, '{"mcpServers":{}}\n');
    scratchReady = true;
  }
  return { cwd: SCRATCH_DIR, mcpConfigPath: MCP_CONFIG_PATH };
}

/** `which claude`; null when the binary cannot be resolved (health treats that as unavailable). */
export function resolveClaudeBin(): string | null {
  try {
    const bin = execFileSync("which", ["claude"], { encoding: "utf-8" }).trim();
    return bin === "" ? null : bin;
  } catch {
    return null;
  }
}

export interface Availability {
  available: boolean;
  reason?: string;
}

export function decideAvailability(
  env: Record<string, string | undefined>,
  resolveBin: () => string | null,
): Availability {
  if (env.SPEC_RESTATE_CRITIC === "0") {
    return { available: false, reason: "disabled by SPEC_RESTATE_CRITIC=0" };
  }
  if (resolveBin() === null) {
    return { available: false, reason: "the claude binary could not be resolved on PATH" };
  }
  return { available: true };
}

export interface BuildArgsOptions {
  mcpConfigPath: string;
  disallowedTools?: readonly string[];
  resumeSessionId?: string;
}

export function buildArgs(prompt: string, opts: BuildArgsOptions): string[] {
  const args: string[] = [
    "--dangerously-skip-permissions",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
  ];
  if (opts.disallowedTools !== undefined && opts.disallowedTools.length > 0) {
    args.push("--disallowed-tools", opts.disallowedTools.join(","));
  }
  args.push("--mcp-config", opts.mcpConfigPath, "--strict-mcp-config");
  if (opts.resumeSessionId !== undefined) args.push("--resume", opts.resumeSessionId);
  args.push("-p", prompt);
  return args;
}

export interface RunClaudeOptions {
  resumeSessionId?: string;
  /** Defaults to {@link CRITIC_DISALLOWED_TOOLS}. */
  disallowedTools?: readonly string[];
  timeoutMs?: number;
  /** Wire a route's request.signal here — client disconnect kills the process. */
  signal?: AbortSignal;
  /** Incremental assistant text from the partial-message stream (for SSE re-emission). */
  onDelta?: (text: string) => void;
}

export interface RunClaudeResult {
  success: boolean;
  result: string;
  sessionId?: string;
  exitCode: number;
  timedOut: boolean;
  aborted: boolean;
}

export function runClaude(prompt: string, opts: RunClaudeOptions = {}): Promise<RunClaudeResult> {
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
  const { cwd, mcpConfigPath } = ensureScratchDir();

  // Strip ANTHROPIC_API_KEY (subscription billing) and CLAUDECODE (nested-session
  // detection) from the child env.
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDECODE;

  const args = buildArgs(prompt, {
    mcpConfigPath,
    disallowedTools: opts.disallowedTools ?? CRITIC_DISALLOWED_TOOLS,
    resumeSessionId: opts.resumeSessionId,
  });

  return new Promise((resolvePromise) => {
    if (opts.signal?.aborted === true) {
      resolvePromise({ success: false, result: "aborted before start", exitCode: 1, timedOut: false, aborted: true });
      return;
    }

    const proc = spawn(resolveClaudeBin() ?? "claude", args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"] as const,
    });

    let lineBuffer = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let exitFallbackTimer: NodeJS.Timeout | undefined;
    let resultEvent: {
      subtype?: string;
      result?: string;
      session_id?: string;
      is_error?: boolean;
      errors?: string[];
    } | null = null;
    let initSessionId: string | undefined;
    let lastAssistantText = "";

    const kill = (sig: NodeJS.Signals): void => {
      try {
        proc.kill(sig);
      } catch {
        // already gone
      }
    };
    const killLadder = (): void => {
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), 5_000).unref();
    };

    const killTimer = setTimeout(() => {
      timedOut = true;
      killLadder();
    }, timeoutMs);
    killTimer.unref();

    const onAbort = (): void => killLadder();
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const settle = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      if (exitFallbackTimer) clearTimeout(exitFallbackTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      const aborted = opts.signal?.aborted === true;

      if (resultEvent) {
        const success = !resultEvent.is_error && resultEvent.subtype === "success" && exitCode === 0;
        // `||` on purpose: error-subtype result events carry result: "" with the
        // real message in errors[].
        const text =
          resultEvent.result ||
          lastAssistantText ||
          (resultEvent.errors?.length ? resultEvent.errors.join("; ") : "") ||
          stderr.trim();
        resolvePromise({ success, result: text, sessionId: resultEvent.session_id ?? initSessionId, exitCode, timedOut, aborted });
      } else {
        resolvePromise({
          success: false,
          result:
            lastAssistantText ||
            stderr.trim() ||
            (timedOut ? `claude timed out after ${timeoutMs}ms` : `claude exited with code ${exitCode} and no result event`),
          sessionId: initSessionId,
          exitCode,
          timedOut,
          aborted,
        });
      }
    };

    proc.stdout!.on("data", (data: Buffer) => {
      lineBuffer += data.toString();
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let parsed: any;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (parsed.type === "result") {
          resultEvent = parsed;
        } else if (parsed.type === "system" && parsed.subtype === "init") {
          // Captured so a session that dies before its result event (e.g. timeout)
          // is still resumable on the next attempt.
          if (typeof parsed.session_id === "string") initSessionId = parsed.session_id;
        } else if (parsed.type === "stream_event") {
          const delta = parsed.event?.delta;
          if (delta?.type === "text_delta" && typeof delta.text === "string") {
            opts.onDelta?.(delta.text);
          }
        } else if (parsed.type === "assistant") {
          const content = parsed.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "text" && block.text) lastAssistantText = block.text;
            }
          }
        }
      }
    });

    proc.stderr!.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("error", (err) => {
      resultEvent = null;
      stderr = stderr || `failed to spawn claude: ${err.message}`;
      settle(1);
    });

    proc.on("close", (code) => settle(code ?? 1));

    // Fallback: if something holds the stdout pipe open, 'close' never fires —
    // settle shortly after 'exit' with whatever we parsed.
    proc.on("exit", (code) => {
      exitFallbackTimer = setTimeout(() => settle(code ?? 1), 1_500);
    });
  });
}

// ── verdict extraction (pure; unit-tested) ──────────────────────────────────────

/** Extract the first top-level JSON object from a text reply. Throws if none parses. */
export function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object found in reply");
  return JSON.parse(text.slice(start, end + 1));
}

function stringList(raw: unknown): string[] {
  if (typeof raw === "string") return raw.trim() === "" ? [] : [raw];
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
}

export interface CritiqueVerdict {
  summary: string;
  /** Things the restatement missed, misunderstood, or distorted relative to the source. */
  gaps: string[];
  /** Ways the restatement genuinely improved on the source. */
  improvements: string[];
}

/** Lenient coercion; null when unusable (not an object, or no usable summary). */
export function validateCritiqueVerdict(raw: unknown): CritiqueVerdict | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.summary !== "string" || obj.summary.trim() === "") return null;
  return { summary: obj.summary, gaps: stringList(obj.gaps), improvements: stringList(obj.improvements) };
}

export type ReviewSeverity = "minor" | "major" | "critical";

export interface ReviewNote {
  title: string;
  markdown: string;
  severity: ReviewSeverity;
}

export interface ReviewVerdict {
  summary: string;
  notes: ReviewNote[];
}

function coerceSeverity(raw: unknown): ReviewSeverity {
  if (typeof raw === "string") {
    const s = raw.trim().toLowerCase();
    if (s === "major" || s === "critical") return s;
  }
  return "minor";
}

/** Lenient coercion; notes without usable title+markdown dropped; null when unusable. */
export function validateReviewVerdict(raw: unknown): ReviewVerdict | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.summary !== "string" || obj.summary.trim() === "") return null;
  const rawNotes = Array.isArray(obj.notes)
    ? obj.notes
    : obj.notes !== null && typeof obj.notes === "object"
      ? [obj.notes]
      : [];
  const notes: ReviewNote[] = [];
  for (const entry of rawNotes) {
    if (entry === null || typeof entry !== "object") continue;
    const note = entry as Record<string, unknown>;
    if (typeof note.title !== "string" || note.title.trim() === "") continue;
    if (typeof note.markdown !== "string" || note.markdown.trim() === "") continue;
    notes.push({ title: note.title, markdown: note.markdown, severity: coerceSeverity(note.severity) });
  }
  return { summary: obj.summary, notes };
}
