import {
  chatTimeoutMsFromEnv,
  runRecipeChat,
  type ChatInput,
  type RecipeSnapshot,
} from "@/lib/server/recipe-chat";
import { checkRequestAuth } from "@/lib/server/wiki-auth";

export const runtime = "nodejs";

/** The recipe travels in FULL on every turn — the session is a convenience for follow-ups,
 *  never the source of truth for what the recipe currently says. */
function parseRecipe(raw: unknown): RecipeSnapshot | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.title !== "string") return null;
  if (!Array.isArray(obj.ingredients) || !Array.isArray(obj.steps)) return null;
  return obj as unknown as RecipeSnapshot;
}

function parseBody(raw: unknown): Omit<ChatInput, "timeoutMs" | "signal"> | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const recipe = parseRecipe(obj.recipe);
  if (recipe === null) return null;
  if (typeof obj.question !== "string" || obj.question.trim() === "") return null;
  return {
    recipe,
    question: obj.question,
    ...(typeof obj.sessionId === "string" ? { sessionId: obj.sessionId } : {}),
  };
}

export async function POST(request: Request): Promise<Response> {
  const auth = await checkRequestAuth(request.headers.get("authorization"));
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });

  let body: Omit<ChatInput, "timeoutMs" | "signal"> | null;
  try {
    body = parseBody(await request.json());
  } catch {
    body = null;
  }
  if (body === null) {
    return Response.json({ error: "expected { recipe, question, sessionId? }" }, { status: 400 });
  }

  const out = await runRecipeChat({
    ...body,
    timeoutMs: chatTimeoutMsFromEnv(process.env, 3 * 60 * 1000),
    signal: request.signal,
  });
  if (!out.ok) return Response.json({ error: out.message }, { status: 502 });
  return Response.json(out.value);
}
