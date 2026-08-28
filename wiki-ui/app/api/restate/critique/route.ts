import { runCritique, timeoutMsFromEnv, type CritiqueTurn, type SourceSection } from "@/lib/server/critic";
import { checkRequestAuth } from "@/lib/server/wiki-auth";

export const runtime = "nodejs";

interface CritiqueBody {
  section: SourceSection;
  restatement: string;
  history: readonly CritiqueTurn[];
}

function parseSection(raw: unknown): SourceSection | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { title, markdown } = raw as Record<string, unknown>;
  if (typeof title !== "string" || typeof markdown !== "string") return null;
  return { title, markdown };
}

/** Structural filtering is enough: a historical turn is replayed to the model as text, and
 *  buildCritiqueMessages drops whatever it cannot make a complete exchange out of. */
function parseHistory(raw: unknown): CritiqueTurn[] {
  if (!Array.isArray(raw)) return [];
  const turns: CritiqueTurn[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const turn = entry as Record<string, unknown>;
    const section = parseSection(turn.section);
    if (section === null || typeof turn.restatement !== "string") continue;
    if (turn.verdict === null || typeof turn.verdict !== "object") continue;
    turns.push({ section, restatement: turn.restatement, verdict: turn.verdict as CritiqueTurn["verdict"] });
  }
  return turns;
}

function parseBody(raw: unknown): CritiqueBody | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const section = parseSection(obj.section);
  if (section === null) return null;
  if (typeof obj.restatement !== "string" || obj.restatement.trim() === "") return null;
  // A tab left open across the deploy still posts a sessionId. Ignoring it starts that page
  // cold, which is what the first critique always did; rejecting it would break the studio.
  return { section, restatement: obj.restatement, history: parseHistory(obj.history) };
}

export async function POST(request: Request): Promise<Response> {
  const auth = await checkRequestAuth(request.headers.get("authorization"));
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });

  let body: CritiqueBody | null;
  try {
    body = parseBody(await request.json());
  } catch {
    body = null;
  }
  if (body === null) {
    return Response.json(
      { error: "expected { section: { title, markdown }, restatement, history? }" },
      { status: 400 },
    );
  }

  const out = await runCritique({
    ...body,
    timeoutMs: timeoutMsFromEnv(process.env, 5 * 60 * 1000),
    signal: request.signal,
  });
  if (!out.ok) return Response.json({ error: out.message }, { status: 502 });
  return Response.json({ verdict: out.verdict });
}
