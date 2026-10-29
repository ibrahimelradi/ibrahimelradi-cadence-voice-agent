import { LANGUAGES, LIMITS } from "@/lib/shared/config";
import { env } from "@/lib/server/env";
import {
  ApiError,
  assertSameOrigin,
  errorResponse,
  notConfigured,
  rateLimit,
  upstreamError,
} from "@/lib/server/http";

const ALLOWED_TYPES = ["audio/wav", "audio/x-wav", "audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg"];

// Phrases speech models commonly hallucinate from silence / noise.
const HALLUCINATIONS = new Set([
  "thank you.",
  "thanks for watching!",
  "thanks for watching.",
  "thank you for watching.",
  "you",
  ".",
  "bye.",
  "subtitles by the amara.org community",
]);

/** Speech-to-text for the modular pipeline. Audio is never stored. */
export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    rateLimit(req, "transcribe", 60);

    const len = Number(req.headers.get("content-length") ?? 0);
    if (len > LIMITS.maxAudioBytes + 64 * 1024)
      throw new ApiError(413, "payload_too_large", "Audio clip is too large.");

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      throw new ApiError(400, "invalid_request", "Expected multipart form data.");
    }
    const file = form.get("audio");
    const provider = String(form.get("provider") ?? "openai");
    const language = String(form.get("language") ?? "auto");

    if (!(file instanceof Blob) || file.size === 0)
      throw new ApiError(400, "invalid_request", "Missing audio.");
    if (file.size > LIMITS.maxAudioBytes)
      throw new ApiError(413, "payload_too_large", "Audio clip is too large.");
    const baseType = file.type.split(";")[0]!;
    if (!ALLOWED_TYPES.includes(baseType))
      throw new ApiError(415, "unsupported_media", `Unsupported audio type: ${file.type || "unknown"}`);
    if (provider !== "openai" && provider !== "elevenlabs")
      throw new ApiError(400, "invalid_request", "Unknown speech-to-text provider.");
    if (!LANGUAGES.some((l) => l.code === language))
      throw new ApiError(400, "invalid_request", "Unknown language.");

    const ext = baseType.includes("wav") ? "wav" : baseType.split("/")[1];
    const upstream = new FormData();
    let res: Response;

    if (provider === "openai") {
      const key = env.openaiKey();
      if (!key) throw notConfigured("OpenAI", "OPENAI_API_KEY");
      upstream.append("file", file, `speech.${ext}`);
      upstream.append("model", env.openaiSttModel());
      upstream.append("response_format", "json");
      if (language !== "auto") upstream.append("language", language);
      res = await fetch(`${env.openaiBaseUrl()}/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: upstream,
        signal: AbortSignal.any([req.signal, AbortSignal.timeout(30_000)]),
      });
      if (!res.ok) throw await upstreamError("OpenAI", res);
    } else {
      const key = env.elevenlabsKey();
      if (!key) throw notConfigured("ElevenLabs", "ELEVENLABS_API_KEY");
      upstream.append("file", file, `speech.${ext}`);
      upstream.append("model_id", env.elevenlabsSttModel());
      upstream.append("tag_audio_events", "false");
      if (language !== "auto") upstream.append("language_code", language);
      res = await fetch(`${env.elevenlabsBaseUrl()}/v1/speech-to-text`, {
        method: "POST",
        headers: { "xi-api-key": key },
        body: upstream,
        signal: AbortSignal.any([req.signal, AbortSignal.timeout(30_000)]),
      });
      if (!res.ok) throw await upstreamError("ElevenLabs", res);
    }

    const data = (await res.json()) as { text?: string; language_code?: string };
    let text = (data.text ?? "").trim();
    if (HALLUCINATIONS.has(text.toLowerCase())) text = "";
    return Response.json(
      { text, language: data.language_code ?? null },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError")
      return errorResponse(new ApiError(504, "provider_timeout", "Speech recognition timed out."));
    if (err instanceof Error && err.name === "AbortError")
      return errorResponse(new ApiError(499, "aborted", "Request aborted."));
    return errorResponse(err);
  }
}
