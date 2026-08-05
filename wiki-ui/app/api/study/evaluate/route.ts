import { evalTimeoutMsFromEnv, runTermEvaluation } from "@/lib/server/study-critic";
import { checkRequestAuth } from "@/lib/server/wiki-auth";

export const runtime = "nodejs";

interface EvaluateBody {
  term: string;
  definition: string;
  context?: string;
  subject?: string;
}

function parseBody(raw: unknown): EvaluateBody | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.term !== "string" || obj.term.trim() === "") return null;
  if (typeof obj.definition !== "string" || obj.definition.trim() === "") return null;
  if (obj.context !== undefined && typeof obj.context !== "string") return null;
  if (obj.subject !== undefined && typeof obj.subject !== "string") return null;
  return {
    term: obj.term,
    definition: obj.definition,
    ...(typeof obj.context === "string" ? { context: obj.context } : {}),
    ...(typeof obj.subject === "string" ? { subject: obj.subject } : {}),
  };
}

export async function POST(request: Request): Promise<Response> {
  const auth = await checkRequestAuth(request.headers.get("authorization"));
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });

  let body: EvaluateBody | null;
  try {
    body = parseBody(await request.json());
  } catch {
    body = null;
  }
  if (body === null) {
    return Response.json({ error: "expected { term, definition, context?, subject? }" }, { status: 400 });
  }

  const out = await runTermEvaluation({
    ...body,
    timeoutMs: evalTimeoutMsFromEnv(process.env, 5 * 60 * 1000),
    signal: request.signal,
  });
  if (!out.ok) return Response.json({ error: out.message }, { status: 502 });
  return Response.json({ verdict: out.verdict });
}
