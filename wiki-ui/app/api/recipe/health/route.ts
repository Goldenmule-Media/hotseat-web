import { decideAnthropicAvailability } from "@/lib/server/anthropic";
import { checkRequestAuth } from "@/lib/server/wiki-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const auth = await checkRequestAuth(request.headers.get("authorization"));
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });

  return Response.json(decideAnthropicAvailability());
}
