import { runCritique, sseData, timeoutMsFromEnv, type SourceSection } from "@/lib/server/critic";
import { checkRequestAuth } from "@/lib/server/wiki-auth";

export const runtime = "nodejs";

interface CritiqueBody {
  sections: SourceSection[];
  restatement: string;
  sessionId?: string;
}

function parseBody(raw: unknown): CritiqueBody | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.sections) || obj.sections.length === 0) return null;
  const sections: SourceSection[] = [];
  for (const entry of obj.sections) {
    if (entry === null || typeof entry !== "object") return null;
    const s = entry as Record<string, unknown>;
    if (typeof s.title !== "string" || typeof s.markdown !== "string") return null;
    sections.push({ title: s.title, markdown: s.markdown });
  }
  if (typeof obj.restatement !== "string" || obj.restatement.trim() === "") return null;
  if (obj.sessionId !== undefined && typeof obj.sessionId !== "string") return null;
  return {
    sections,
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
    return Response.json(
      { error: "expected { sections: [{ title, markdown }, …], restatement, sessionId? }" },
      { status: 400 },
    );
  }
  const { sections, restatement, sessionId } = body;
  const timeoutMs = timeoutMsFromEnv(process.env, 5 * 60 * 1000);
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (event: object): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(sseData(event)));
        } catch {
          closed = true; // client went away mid-stream
        }
      };
      void runCritique({
        sections,
        restatement,
        sessionId,
        timeoutMs,
        signal: request.signal,
        onDelta: (text) => send({ type: "delta", text }),
      })
        .then((out) => {
          send(out.ok ? { type: "verdict", verdict: out.verdict, sessionId: out.sessionId } : { type: "error", message: out.message });
        })
        .catch((err: unknown) => {
          send({ type: "error", message: err instanceof Error ? err.message : String(err) });
        })
        .finally(() => {
          closed = true;
          try {
            controller.close();
          } catch {
            // already closed
          }
        });
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
    },
  });
}
