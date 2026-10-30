import {
  ApiError,
  assertSameOrigin,
  errorResponse,
  notConfigured,
  rateLimit,
  readJson,
} from "@/lib/server/http";
import { isProviderConfigured, normalizeHistory, providerEnvVar, streamReply } from "@/lib/server/llm";
import { buildSystemPrompt } from "@/lib/server/prompts";
import { chatSchema, parse } from "@/lib/server/schemas";

/**
 * Streams the assistant reply as NDJSON:
 *   {"t":"delta","text":"..."}  …  {"t":"done"}   or   {"t":"error",...}
 */
export async function POST(req: Request) {
  let input;
  try {
    assertSameOrigin(req);
    rateLimit(req, "chat", 40);
    input = parse(chatSchema, await readJson(req));
    if (!isProviderConfigured(input.provider)) {
      const label = { anthropic: "Anthropic", openai: "OpenAI", gemini: "Gemini", groq: "Groq" }[input.provider];
      throw notConfigured(label, providerEnvVar(input.provider));
    }
  } catch (err) {
    return errorResponse(err);
  }

  const history = (() => {
    try {
      return normalizeHistory(input.history);
    } catch (e) {
      return e as ApiError;
    }
  })();
  if (history instanceof ApiError) return errorResponse(history);

  const system = buildSystemPrompt(input);
  const enc = new TextEncoder();
  const line = (o: unknown) => enc.encode(JSON.stringify(o) + "\n");

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const text of streamReply({
          provider: input.provider,
          system,
          history,
          signal: req.signal,
        })) {
          controller.enqueue(line({ t: "delta", text }));
        }
        controller.enqueue(line({ t: "done" }));
      } catch (err) {
        if (!(err instanceof ApiError && err.code === "aborted")) {
          const e =
            err instanceof ApiError
              ? err
              : new ApiError(500, "internal_error", "The AI service failed unexpectedly.");
          if (!(err instanceof ApiError)) console.error("[api] chat error", err);
          try {
            controller.enqueue(line({ t: "error", code: e.code, message: e.message, provider: e.provider }));
          } catch {
            /* client gone */
          }
        }
      } finally {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
