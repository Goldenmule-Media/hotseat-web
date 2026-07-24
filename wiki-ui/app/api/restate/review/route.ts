import { runReview, timeoutMsFromEnv } from "@/lib/server/critic";
import { checkRequestAuth } from "@/lib/server/wiki-auth";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const auth = await checkRequestAuth(request.headers.get("authorization"));
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });

  let specMarkdown: string | null = null;
  try {
    const raw: unknown = await request.json();
    if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
      const value = (raw as Record<string, unknown>).specMarkdown;
      if (typeof value === "string" && value.trim() !== "") specMarkdown = value;
    }
  } catch {
    // fall through to 400
  }
  if (specMarkdown === null) {
    return Response.json({ error: "expected { specMarkdown: string }" }, { status: 400 });
  }

  const out = await runReview({
    specMarkdown,
    timeoutMs: timeoutMsFromEnv(process.env, 10 * 60 * 1000),
    signal: request.signal,
  });
  if (!out.ok) return Response.json({ error: out.message }, { status: 502 });
  return Response.json(out.verdict);
}
