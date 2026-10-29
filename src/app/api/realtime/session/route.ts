import { env } from "@/lib/server/env";
import {
  ApiError,
  assertSameOrigin,
  errorResponse,
  notConfigured,
  rateLimit,
  readJson,
  upstreamError,
} from "@/lib/server/http";
import { buildSystemPrompt, historyAppendix } from "@/lib/server/prompts";
import { parse, realtimeSessionSchema } from "@/lib/server/schemas";

const EAGERNESS = { patient: "low", balanced: "auto", quick: "high" } as const;

/**
 * Mints a short-lived OpenAI Realtime client secret. The browser uses it to
 * open a WebRTC connection directly with OpenAI; the real API key never
 * leaves the server.
 */
export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    rateLimit(req, "realtime-session", 12);
    const key = env.openaiKey();
    if (!key) throw notConfigured("OpenAI", "OPENAI_API_KEY");

    const input = parse(realtimeSessionSchema, await readJson(req));
    const instructions =
      buildSystemPrompt(input) + historyAppendix(input.history);

    const session = {
      type: "realtime",
      model: env.realtimeModel(),
      instructions,
      output_modalities: ["audio"],
      audio: {
        input: {
          noise_reduction: { type: input.micEnvironment === "far" ? "far_field" : "near_field" },
          transcription: {
            model: env.realtimeTranscriptionModel(),
            ...(input.language !== "auto" ? { language: input.language } : {}),
          },
          turn_detection: {
            type: "semantic_vad",
            eagerness: EAGERNESS[input.turnTaking],
            create_response: true,
            interrupt_response: true,
          },
        },
        output: {
          voice: input.voice,
          speed: input.speechRate,
        },
      },
    };

    const res = await fetch(`${env.openaiBaseUrl()}/realtime/client_secrets`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        expires_after: { anchor: "created_at", seconds: 120 },
        session,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw await upstreamError("OpenAI", res);

    const data = (await res.json()) as { value?: string; expires_at?: number };
    if (!data.value) {
      throw new ApiError(502, "provider_error", "OpenAI did not return a session token.", "OpenAI");
    }
    return Response.json(
      {
        clientSecret: data.value,
        expiresAt: data.expires_at,
        model: session.model,
        callsUrl: `${env.openaiBaseUrl()}/realtime/calls`,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      return errorResponse(new ApiError(504, "provider_timeout", "OpenAI took too long to respond.", "OpenAI"));
    }
    return errorResponse(err);
  }
}
