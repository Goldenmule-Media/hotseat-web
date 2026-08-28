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
 * ONE Messages API call per turn, and no session. The earlier design spawned the `claude`
 * CLI and resumed one session per page, which is why it carried a lock, a dead-session
 * retry, and a per-page prompt contract. `messages.create` is stateless, so the client
 * sends the prior turns back and this module assembles them into `messages[]`.
 *
 * The mitigation apparatus disappears because the threat does. The CLI's skip-permissions
 * flag, CRITIC_DISALLOWED_TOOLS, the always-on empty --mcp-config plus --strict-mcp-config,
 * the scratch cwd, and the stripped child env all existed because a spawned `claude` could
 * otherwise discover a project .mcp.json and acquire authenticated wiki write tools. A
 * messages.create call with NO `tools` parameter has no tool access at all: no filesystem,
 * no MCP, no subprocess. That is a genuine reduction in attack surface rather than a
 * relocation of it. What does NOT change is validateOp's allowlist, which was never about
 * the transport.
 *
 * Billing moves from a Claude subscription to API credits FOR THE RECIPE CHAT ONLY.
 * lib/server/claude-cli.ts deliberately deletes ANTHROPIC_API_KEY from the child env so the
 * CLI bills the subscription, and that line stays. Setting the key for wiki-ui does not
 * alter what the Restate and Study critics bill.
 */
import type Anthropic from "@anthropic-ai/sdk";

import { anthropicClient, CHAT_MODEL, describeAnthropicError } from "./anthropic";

/**
 * The commands the chat may propose, and the argument each one needs to identify its
 * target. Deliberately a SUBSET of the model's surface: the chat changes a recipe's
 * content, and never its status, its files, or the order of anything.
 */
interface CommandSpec {
  /** The argument naming the row this command acts on. */
  readonly idArg?: string;
  /** Arguments the command cannot act without. */
  readonly required: readonly string[];
  /** Arguments it may carry. */
  readonly optional: readonly string[];
  /** A revision must actually revise something: at least one non-id argument. Without this a
   *  bare `{ingredientId}` validates, renders as "Change butter", and then fails on Apply
   *  because the engine refuses a mutation that changes no field. */
  readonly mustChange?: true;
}

const PROPOSABLE: Readonly<Record<string, CommandSpec>> = {
  addIngredient: { required: ["title"], optional: ["qty", "unit", "prep", "group"] },
  reviseIngredient: {
    idArg: "ingredientId",
    required: [],
    optional: ["title", "qty", "unit", "prep", "group"],
    mustChange: true,
  },
  removeIngredient: { idArg: "ingredientId", required: [], optional: [] },
  addStep: { required: ["title", "markdown"], optional: ["group"] },
  reviseStep: { idArg: "stepId", required: ["markdown"], optional: ["title", "group"] },
  removeStep: { idArg: "stepId", required: [], optional: [] },
  addNote: { required: ["title", "markdown"], optional: [] },
};

/** Every argument one command accepts, id first. */
function argKeysOf(spec: CommandSpec): string[] {
  return [...(spec.idArg === undefined ? [] : [spec.idArg]), ...spec.required, ...spec.optional];
}

/** The command names the schema constrains the model to, derived so the two cannot drift. */
export function proposableCommands(): string[] {
  return Object.keys(PROPOSABLE);
}

export interface ProposedOp {
  readonly command: string;
  readonly args: Record<string, unknown>;
}

export interface ChatReply {
  /** The answer, in prose. Always present — a proposal is optional. */
  readonly reply: string;
  /** What it would change, if anything. Nothing is written until the human applies it. */
  readonly proposal: readonly ProposedOp[];
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

/**
 * A constrained decode, not a request for good behaviour. `args` is one flat bag of every key
 * any command takes, because the API wants additionalProperties:false on every object; WHICH
 * keys a given command needs is {@link validateOp}'s judgement, not the schema's.
 */
/**
 * One schema branch per command, so `args` carries exactly the arguments THAT command takes.
 *
 * A single flat `args` bag holding every key any command accepts does not work: it gives the
 * model no signal about which keys belong to which command, and a live turn produced
 * `reviseIngredient {ingredientId, stepId}` — a step argument on an ingredient command, and
 * no actual change. Branching per command makes the wrong key unrepresentable rather than
 * merely invalid.
 */
function commandBranch(name: string, spec: CommandSpec): Record<string, unknown> {
  const keys = argKeysOf(spec);
  return {
    type: "object",
    properties: {
      command: { const: name },
      args: {
        type: "object",
        properties: Object.fromEntries(keys.map((key) => [key, { type: "string" }])),
        required: [...(spec.idArg === undefined ? [] : [spec.idArg]), ...spec.required],
        additionalProperties: false,
      },
    },
    required: ["command", "args"],
    additionalProperties: false,
  };
}

export const CHAT_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string" },
    proposal: {
      type: "array",
      items: { anyOf: Object.entries(PROPOSABLE).map(([name, spec]) => commandBranch(name, spec)) },
    },
  },
  required: ["reply", "proposal"],
  additionalProperties: false,
} as const;

/** Role, JSON semantics and the command contract. Constant across every turn, because with
 *  a messages array the contract no longer belongs to whichever turn happened to be first. */
export function chatSystemPrompt(): string {
  return [
    "You are helping someone cook. They are looking at one recipe and will ask about substitutions,",
    "scaling, technique, and what to change. Answer like a cook who has made this: concrete, short,",
    "and willing to say when a substitution will actually change the result.",
    "",
    "You are a function, not a chat partner. You return one object with two fields, `reply` and",
    "`proposal`.",
    "",
    "reply: the answer itself, at most a short paragraph. If a substitution has a real cost — texture,",
    "rise, browning — say so in a clause, not a lecture. No preamble, no restating the question.",
    "",
    "proposal: OPTIONAL, and only when they asked for a CHANGE rather than an explanation. It is a list",
    "of edits to this recipe, each naming one command and its arguments. NOTHING IS WRITTEN by proposing:",
    "the human sees the change and decides. Propose the smallest set of edits that does what was asked.",
    "Send [] when the answer is just an answer.",
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
    'Use the ids exactly as given. A quantity may be a number or a written form like "1 1/4".',
    "A DIVIDED ingredient is several rows, not one: if a change splits an amount between two uses,",
    "propose two ingredients, and the shopping list will add them back up on its own.",
  ].join("\n");
}

/** The recipe travels here and nowhere else: exactly once per request, in the last message. */
export function chatUserTurn(recipe: RecipeSnapshot, question: string): string {
  return [
    "The recipe below is its CURRENT state, which may include edits applied since you last saw it.",
    "",
    "--- THE RECIPE ---",
    JSON.stringify(recipe, null, 1),
    "",
    "--- THE QUESTION ---",
    question.trim(),
  ].join("\n");
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
  // Keep only primitives, and only arguments THIS command takes — a stray `stepId` on an
  // ingredient command is noise to drop, not grounds to throw the whole edit away.
  const allowed = new Set(argKeysOf(spec));
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (!allowed.has(key)) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") clean[key] = value;
  }
  if (spec.idArg !== undefined && asString(clean[spec.idArg]) === null) return null;
  for (const key of spec.required) if (asString(clean[key]) === null) return null;
  if (spec.mustChange === true && !spec.optional.some((key) => clean[key] !== undefined)) return null;
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

/** One earlier exchange, as the client kept it. */
export interface ChatTurn {
  readonly question: string;
  readonly reply: string;
  readonly proposal: readonly ProposedOp[];
}

export const MAX_HISTORY_TURNS = 6;

/** A remembered turn is a couple of sentences; anything longer is a client that has gone
 *  wrong, and history is not worth an unbounded request. */
const MAX_HISTORY_CHARS = 2000;

function clip(text: string): string {
  return text.length > MAX_HISTORY_CHARS ? text.slice(0, MAX_HISTORY_CHARS) : text;
}

/**
 * The conversation as the model sees it. Roles are assigned here, so a client sends pairs
 * and structurally cannot inject a system or assistant turn.
 *
 * Each past turn replays as the bare question and the model's own JSON. Replaying the output
 * format keeps the model in distribution, and it carries a PENDING UNAPPLIED proposal along
 * with it: the studio holds the base recipe rather than the overlaid one, so a prose-only
 * history would lose the staged edit and break "and the sugar too?".
 */
export function buildMessages(
  recipe: RecipeSnapshot,
  question: string,
  history: readonly ChatTurn[],
): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = [];
  for (const turn of history.slice(-MAX_HISTORY_TURNS)) {
    const asked = asString(turn?.question);
    const answered = asString(turn?.reply);
    if (asked === null || answered === null) continue;
    messages.push({ role: "user", content: clip(asked) });
    messages.push({
      role: "assistant",
      content: JSON.stringify({
        reply: clip(answered),
        proposal: Array.isArray(turn.proposal) ? turn.proposal : [],
      }),
    });
  }
  messages.push({ role: "user", content: chatUserTurn(recipe, question) });
  return messages;
}

export type ChatOutcome = { ok: true; value: ChatReply } | { ok: false; message: string };

export type CreateMessage = (
  params: Anthropic.MessageCreateParamsNonStreaming,
  options?: Anthropic.RequestOptions,
) => Promise<Anthropic.Message>;

export interface ChatInput {
  recipe: RecipeSnapshot;
  question: string;
  history?: readonly ChatTurn[];
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Test seam. The route never sets this. */
  create?: CreateMessage;
}

const DEFAULT_TIMEOUT_MS = 3 * 60 * 1000;

function clientCreate(): CreateMessage | null {
  const client = anthropicClient();
  if (client === null) return null;
  return (params, options) => client.messages.create(params, options);
}

export async function runRecipeChat(input: ChatInput): Promise<ChatOutcome> {
  const create = input.create ?? clientCreate();
  if (create === null) {
    return { ok: false, message: "the recipe chat is not configured (ANTHROPIC_API_KEY is not set)" };
  }

  let response: Anthropic.Message;
  try {
    response = await create(
      {
        model: CHAT_MODEL,
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        system: chatSystemPrompt(),
        messages: buildMessages(input.recipe, input.question, input.history ?? []),
        output_config: { format: { type: "json_schema", schema: CHAT_OUTPUT_SCHEMA } },
      },
      { signal: input.signal, timeout: input.timeoutMs ?? DEFAULT_TIMEOUT_MS },
    );
  } catch (err) {
    return { ok: false, message: `the recipe chat ${describeAnthropicError(err)}` };
  }

  if (response.stop_reason === "refusal") return { ok: false, message: "the recipe chat declined to answer" };
  if (response.stop_reason === "max_tokens") {
    return { ok: false, message: "the recipe chat ran past its length limit" };
  }

  const noAnswer = { ok: false as const, message: "the recipe chat replied with no usable answer" };
  // Adaptive thinking usually puts a thinking block first, so find the text block, never index it.
  const text = response.content.find((block) => block.type === "text");
  if (text === undefined) return noAnswer;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.text);
  } catch {
    return noAnswer;
  }
  const value = validateChatReply(parsed);
  return value === null ? noAnswer : { ok: true, value };
}

/** Becomes the SDK's per-request `timeout`, in milliseconds, which is the unit the TypeScript
 *  SDK already takes. */
export function chatTimeoutMsFromEnv(env: Record<string, string | undefined>, fallbackMs: number): number {
  const raw = env.WIKI_UI_CHAT_TIMEOUT_MS;
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallbackMs;
}
