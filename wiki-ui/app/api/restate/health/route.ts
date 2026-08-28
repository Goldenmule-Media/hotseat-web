import { decideAnthropicAvailability } from "@/lib/server/anthropic";
import { checkRequestAuth } from "@/lib/server/wiki-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const auth = await checkRequestAuth(request.headers.get("authorization"));
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });

  // No argument: the availability check reads a literal process.env expression that the
  // build substitutes, and passing process.env through would defeat that substitution.
  return Response.json(decideAnthropicAvailability());
}
