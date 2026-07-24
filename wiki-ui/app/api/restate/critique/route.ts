import { runCritique, timeoutMsFromEnv, type SourceSection } from "@/lib/server/critic";
import { checkRequestAuth } from "@/lib/server/wiki-auth";

export const runtime = "nodejs";

interface CritiqueBody {
  section: SourceSection;
  restatement: string;
  /** The page's critique session; every section and round resumes the same one. */
  sessionId?: string;
}

function parseBody(raw: unknown): CritiqueBody | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const s = obj.section;
  if (s === null || typeof s !== "object" || Array.isArray(s)) return null;
  const { title, markdown } = s as Record<string, unknown>;
  if (typeof title !== "string" || typeof markdown !== "string") return null;
  if (typeof obj.restatement !== "string" || obj.restatement.trim() === "") return null;
  if (obj.sessionId !== undefined && typeof obj.sessionId !== "string") return null;
  return {
    section: { title, markdown },
    restatement: obj.restatement,
    ...(typeof obj.sessionId === "string" ? { sessionId: obj.sessionId } : {}),
  };
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
    return Response.json({ error: "expected { section: { title, markdown }, restatement, sessionId? }" }, { status: 400 });
  }

  const out = await runCritique({
    ...body,
    timeoutMs: timeoutMsFromEnv(process.env, 5 * 60 * 1000),
    signal: request.signal,
  });
  if (!out.ok) return Response.json({ error: out.message }, { status: 502 });
  return Response.json({
    verdict: out.verdict,
    ...(out.sessionId !== undefined ? { sessionId: out.sessionId } : {}),
  });
}
