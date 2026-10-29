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
import { styleOf } from "@/lib/server/prompts";
import { parse, ttsSchema } from "@/lib/server/schemas";

/** Text-to-speech for the modular pipeline. Streams MP3 back to the client. */
export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    rateLimit(req, "tts", 180);
    const input = parse(ttsSchema, await readJson(req, 16 * 1024));
    const signal = AbortSignal.any([req.signal, AbortSignal.timeout(30_000)]);
    let res: Response;

    if (input.provider === "openai") {
      const key = env.openaiKey();
      if (!key) throw notConfigured("OpenAI", "OPENAI_API_KEY");
      res = await fetch(`${env.openaiBaseUrl()}/audio/speech`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: env.openaiTtsModel(),
          voice: input.openaiVoice,
          input: input.text,
          instructions: styleOf(input.style).voice,
          response_format: "mp3",
          speed: input.speechRate,
        }),
        signal,
      });
      if (!res.ok || !res.body) throw await upstreamError("OpenAI", res);
    } else {
      const key = env.elevenlabsKey();
      if (!key) throw notConfigured("ElevenLabs", "ELEVENLABS_API_KEY");
      const voiceId = input.elevenlabsVoiceId || env.elevenlabsVoiceId();
      const model = env.elevenlabsTtsModel();
      // language_code is rejected by the multilingual_v2 family.
      const supportsLanguageCode = !model.startsWith("eleven_multilingual");
      res = await fetch(
        `${env.elevenlabsBaseUrl()}/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=mp3_44100_128`,
        {
          method: "POST",
          headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" },
          body: JSON.stringify({
            text: input.text,
            model_id: model,
            ...(input.previousText ? { previous_text: input.previousText } : {}),
            ...(supportsLanguageCode && input.language !== "auto" ? { language_code: input.language } : {}),
            voice_settings: {
              stability: input.style === "energetic" ? 0.35 : 0.5,
              similarity_boost: 0.75,
              speed: input.speechRate,
            },
          }),
          signal,
        },
      );
      if (!res.ok || !res.body) throw await upstreamError("ElevenLabs", res);
    }

    return new Response(res.body, {
      headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" },
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError")
      return errorResponse(new ApiError(504, "provider_timeout", "Speech synthesis timed out."));
    if (err instanceof Error && err.name === "AbortError")
      return errorResponse(new ApiError(499, "aborted", "Request aborted."));
    return errorResponse(err);
  }
}
