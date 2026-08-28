import {
  chatTimeoutMsFromEnv,
  runRecipeChat,
  type ChatTurn,
  type ProposedOp,
  type RecipeSnapshot,
} from "@/lib/server/recipe-chat";
import { checkRequestAuth } from "@/lib/server/wiki-auth";

export const runtime = "nodejs";

/** The recipe travels in FULL on every turn, and so does the history: the server keeps no
 *  conversation state, which is what lets more than one instance answer the same tab. */
function parseRecipe(raw: unknown): RecipeSnapshot | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.title !== "string") return null;
  if (!Array.isArray(obj.ingredients) || !Array.isArray(obj.steps)) return null;
  return obj as unknown as RecipeSnapshot;
}

/** Structural filtering is enough: a historical op is replayed to the model as text and is
 *  never executed, and a reply's live proposal is validated again on the way back out. */
function parseHistory(raw: unknown): ChatTurn[] {
  if (!Array.isArray(raw)) return [];
  const turns: ChatTurn[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const turn = entry as Record<string, unknown>;
    if (typeof turn.question !== "string" || typeof turn.reply !== "string") continue;
    turns.push({
      question: turn.question,
      reply: turn.reply,
      proposal: Array.isArray(turn.proposal) ? (turn.proposal as ProposedOp[]) : [],
    });
  }
  return turns;
}

interface ChatBody {
  recipe: RecipeSnapshot;
  question: string;
  history: readonly ChatTurn[];
}

function parseBody(raw: unknown): ChatBody | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const recipe = parseRecipe(obj.recipe);
  if (recipe === null) return null;
  if (typeof obj.question !== "string" || obj.question.trim() === "") return null;
  // A tab left open across the deploy still posts a sessionId. Ignoring it degrades that
  // conversation to a fresh one; rejecting it would break the chat outright.
  return { recipe, question: obj.question, history: parseHistory(obj.history) };
}

export async function POST(request: Request): Promise<Response> {
  const auth = await checkRequestAuth(request.headers.get("authorization"));
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });

  let body: ChatBody | null;
  try {
    body = parseBody(await request.json());
  } catch {
    body = null;
  }
  if (body === null) {
    return Response.json({ error: "expected { recipe, question, history? }" }, { status: 400 });
  }

  const out = await runRecipeChat({
    ...body,
    timeoutMs: chatTimeoutMsFromEnv(process.env, 3 * 60 * 1000),
    signal: request.signal,
  });
  if (!out.ok) return Response.json({ error: out.message }, { status: 502 });
  return Response.json(out.value);
}
