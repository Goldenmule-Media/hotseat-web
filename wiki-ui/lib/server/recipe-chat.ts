/**
 * Server-only chat for the Recipe Studio: substitution questions, scaling, "what can I use
 * instead of buttermilk", asked against the recipe you are looking at.
 *
 * THE CHAT NEVER WRITES. It answers in prose and may attach a PROPOSAL — a list of ops that
 * are the model's own commands, by name and by argument. The studio applies a proposal to a
 * local copy and shows it; only an explicit Apply turns those ops into real mutations. That
 * is what "change it in memory" means here, and keeping the vocabulary identical to the
 * command surface is what stops what you approved from differing from what gets written.
 *
 * Every op is validated against {@link PROPOSABLE} before it leaves this module. A reply
 * naming a command that does not exist, or missing an id the command needs, is dropped
 * rather than passed on for the client to choke on — the prose answer still goes back.
 *
 * One claude session per PAGE, resumed, so a follow-up ("and if I halve it?") knows what
 * was just discussed. `claude --resume` mutates one on-disk session, so runs against it are
 * serialized, exactly as lib/server/critic.ts does.
 */
import { CRITIC_DISALLOWED_TOOLS, extractJson, runClaude } from "./claude-cli";

/**
 * The commands the chat may propose, and the argument each one needs to identify its
 * target. Deliberately a SUBSET of the model's surface: the chat changes a recipe's
 * content, and never its status, its files, or the order of anything.
 */
const PROPOSABLE: Readonly<Record<string, { idArg?: string; required: readonly string[] }>> = {
  addIngredient: { required: ["title"] },
  reviseIngredient: { idArg: "ingredientId", required: [] },
  removeIngredient: { idArg: "ingredientId", required: [] },
  addStep: { required: ["title", "markdown"] },
  reviseStep: { idArg: "stepId", required: ["markdown"] },
  removeStep: { idArg: "stepId", required: [] },
  addNote: { required: ["title", "markdown"] },
};

export interface ProposedOp {
  readonly command: string;
  readonly args: Record<string, unknown>;
}

export interface ChatReply {
  /** The answer, in prose. Always present — a proposal is optional. */
  readonly reply: string;
  /** What it would change, if anything. Nothing is written until the human applies it. */
  readonly proposal: readonly ProposedOp[];
  readonly sessionId?: string;
}

/** The recipe as the chat sees it: ids included, because a proposal has to name them. */
export interface RecipeSnapshot {
  readonly title: string;
  readonly ingredients: readonly {
    id: string;
    name: string;
    qty: string;
    unit: string;
    prep: string;
    group: string;
  }[];
  readonly steps: readonly { id: string; title: string; group: string; body: string }[];
}

const JSON_SHAPE =
  '{"reply": "<the answer, in prose>", "proposal": [{"command": "<one of the listed commands>", "args": {…}}]}';

const JSON_ONLY = "Reply with EXACTLY one JSON object and nothing else: no prose outside it, no code fence.";

export function chatPrompt(recipe: RecipeSnapshot, question: string, isFollowUp: boolean): string {
  const lines: string[] = [];
  if (!isFollowUp) {
    lines.push(
      "You are helping someone cook. They are looking at one recipe and will ask about substitutions,",
      "scaling, technique, and what to change. Answer like a cook who has made this: concrete, short,",
      "and willing to say when a substitution will actually change the result.",
      "",
      `You are a function, not a chat partner. ${JSON_ONLY} Shape:`,
      JSON_SHAPE,
      "",
      "reply: the answer itself, at most a short paragraph. If a substitution has a real cost — texture,",
      "rise, browning — say so in a clause, not a lecture. No preamble, no restating the question.",
      "",
      "proposal: OPTIONAL, and only when they asked for a CHANGE rather than an explanation. It is a list",
      "of edits to this recipe, each naming one command and its arguments. NOTHING IS WRITTEN by proposing:",
      "the human sees the change and decides. Propose the smallest set of edits that does what was asked.",
      "Omit `proposal` entirely, or send [], when the answer is just an answer.",
      "",
      "The commands you may propose, and nothing else:",
      "  addIngredient   {title, qty?, unit?, prep?, group?}          — a new ingredient",
      "  reviseIngredient{ingredientId, title?, qty?, unit?, prep?, group?} — change one; omitted fields are left alone",
      "  removeIngredient{ingredientId}",
      "  addStep         {title, markdown, group?}                     — title is a short imperative label",
      "  reviseStep      {stepId, markdown, title?}",
      "  removeStep      {stepId}",
      "  addNote         {title, markdown}                             — a dated note in the attempt log",
      "",
      "Use the ids exactly as given below. A quantity may be a number or a written form like \"1 1/4\".",
      "A DIVIDED ingredient is several rows, not one: if a change splits an amount between two uses,",
      "propose two ingredients, and the shopping list will add them back up on its own.",
      "",
    );
  } else {
    lines.push(
      `Same recipe, next question. ${JSON_ONLY} Same shape: ${JSON_SHAPE}`,
      "The recipe below is its CURRENT state, which may include edits applied since you last saw it.",
      "",
    );
  }
  lines.push("--- THE RECIPE ---", JSON.stringify(recipe, null, 1), "", "--- THE QUESTION ---", question.trim());
  return lines.join("\n");
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * One proposed op, or `null`. Rejects a command outside {@link PROPOSABLE}, a missing
 * target id, a missing required argument, and any argument that is not a primitive — a
 * proposal is a command call, and the command surface takes scalars and strings.
 */
export function validateOp(raw: unknown): ProposedOp | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const command = asString(obj.command);
  if (command === null) return null;
  const spec = PROPOSABLE[command];
  if (spec === undefined) return null;
  const args = obj.args;
  if (args === null || typeof args !== "object" || Array.isArray(args)) return null;
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") clean[key] = value;
  }
  if (spec.idArg !== undefined && asString(clean[spec.idArg]) === null) return null;
  for (const key of spec.required) if (asString(clean[key]) === null) return null;
  return { command, args: clean };
}

/** At most this many edits in one proposal — a chat turn that wants to rewrite the whole
 *  recipe is a mistake, and reviewing twenty staged changes is not "in memory only". */
export const MAX_PROPOSAL_OPS = 12;

export function validateChatReply(raw: unknown): { reply: string; proposal: ProposedOp[] } | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const reply = asString(obj.reply);
  if (reply === null) return null;
  const proposed = Array.isArray(obj.proposal) ? obj.proposal : [];
  const proposal: ProposedOp[] = [];
  for (const item of proposed.slice(0, MAX_PROPOSAL_OPS)) {
    const op = validateOp(item);
    if (op !== null) proposal.push(op);
  }
  return { reply, proposal };
}

const sessionQueues = new Map<string, Promise<void>>();

/** `claude --resume <id>` mutates one on-disk session; concurrent runs would interleave it. */
function onSession<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
  const run = (sessionQueues.get(sessionId) ?? Promise.resolve()).then(task, task);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  sessionQueues.set(sessionId, tail);
  void tail.then(() => {
    if (sessionQueues.get(sessionId) === tail) sessionQueues.delete(sessionId);
  });
  return run;
}

export type ChatOutcome = { ok: true; value: ChatReply } | { ok: false; message: string };

export interface ChatInput {
  recipe: RecipeSnapshot;
  question: string;
  /** The PAGE's session — every turn about this recipe resumes the same one. */
  sessionId?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

async function attempt(input: ChatInput): Promise<{ outcome: ChatOutcome; retryFresh: boolean }> {
  const done = (outcome: ChatOutcome, retryFresh = false): { outcome: ChatOutcome; retryFresh: boolean } => ({
    outcome,
    retryFresh,
  });
  const run = await runClaude(chatPrompt(input.recipe, input.question, input.sessionId !== undefined), {
    resumeSessionId: input.sessionId,
    disallowedTools: CRITIC_DISALLOWED_TOOLS,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
  });
  if (!run.success) {
    const why = run.timedOut ? "timed out" : run.aborted ? "was cancelled" : `exited ${run.exitCode ?? "?"}`;
    return done({ ok: false, message: `the recipe chat ${why}` }, !run.aborted && !run.timedOut);
  }
  const parsed = validateChatReply(extractJson(run.result));
  if (parsed === null) return done({ ok: false, message: "the recipe chat replied with no usable answer" });
  return done({
    ok: true,
    value: { ...parsed, ...(run.sessionId !== undefined ? { sessionId: run.sessionId } : {}) },
  });
}

export async function runRecipeChat(input: ChatInput): Promise<ChatOutcome> {
  const resume = input.sessionId;
  if (resume === undefined) return (await attempt(input)).outcome;

  const first = await onSession(resume, () => attempt(input));
  if (!first.retryFresh) return first.outcome;
  // A dead session id (pruned, or opened under an older prompt contract) is not a failure:
  // the whole recipe travels in every request, so a fresh session re-opens with full context.
  return (await attempt({ ...input, sessionId: undefined })).outcome;
}

export function chatTimeoutMsFromEnv(env: Record<string, string | undefined>, fallbackMs: number): number {
  const raw = env.WIKI_UI_CHAT_TIMEOUT_MS;
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallbackMs;
}
