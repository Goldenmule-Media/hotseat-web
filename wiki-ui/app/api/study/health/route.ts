import { decideAvailability, resolveClaudeBin, type Availability } from "@/lib/server/claude-cli";
import { checkRequestAuth } from "@/lib/server/wiki-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROBE_TTL_MS = 30_000;

let cached: { value: Availability; at: number } | null = null;

export async function GET(request: Request): Promise<Response> {
  const auth = await checkRequestAuth(request.headers.get("authorization"));
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });

  if (cached === null || Date.now() - cached.at > PROBE_TTL_MS) {
    cached = { value: decideAvailability(process.env, resolveClaudeBin), at: Date.now() };
  }
  return Response.json(cached.value);
}
