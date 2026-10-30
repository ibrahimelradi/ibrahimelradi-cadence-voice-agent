import "server-only";
import type { ServerCapabilities } from "@/lib/shared/config";

function read(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

function list(v: string): string[] {
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export const env = {
  openaiKey: () => read("OPENAI_API_KEY"),
  anthropicKey: () => read("ANTHROPIC_API_KEY"),
  elevenlabsKey: () => read("ELEVENLABS_API_KEY"),
  geminiKey: () => read("GEMINI_API_KEY"),
  groqKey: () => read("GROQ_API_KEY"),

  // Free-tier friendly models. When the first is overloaded or unavailable,
  // the next ones are tried in order.
  geminiModel: () => read("GEMINI_MODEL") ?? "gemini-3.8-flash",
  geminiFallbackModels: () => list(read("GEMINI_FALLBACK_MODELS") ?? "gemini-3.5-flash-lite,gemini-flash-latest"),
  // "low" keeps spoken replies quick on Gemini's thinking models; set "none" to unset.
  geminiReasoningEffort: () => {
    const v = read("GEMINI_REASONING_EFFORT") ?? "low";
    return v === "none" ? undefined : v;
  },
  groqModel: () => read("GROQ_MODEL") ?? "llama-3.3-70b-versatile",
  groqFallbackModels: () => list(read("GROQ_FALLBACK_MODELS") ?? "llama-3.1-8b-instant"),

  openaiBaseUrl: () => (read("OPENAI_BASE_URL") ?? "https://api.openai.com/v1").replace(/\/+$/, ""),
  geminiBaseUrl: () =>
    (read("GEMINI_BASE_URL") ?? "https://generativelanguage.googleapis.com/v1beta/openai").replace(/\/+$/, ""),
  elevenlabsBaseUrl: () => (read("ELEVENLABS_BASE_URL") ?? "https://api.elevenlabs.io").replace(/\/+$/, ""),

  realtimeModel: () => read("OPENAI_REALTIME_MODEL") ?? "gpt-realtime-2.1",
  realtimeTranscriptionModel: () =>
    read("OPENAI_REALTIME_TRANSCRIPTION_MODEL") ?? "gpt-4o-mini-transcribe",

  anthropicModel: () => read("ANTHROPIC_MODEL") ?? "claude-opus-5-5",
  anthropicEffort: () =>
    (read("ANTHROPIC_EFFORT") ?? "low") as "low" | "medium" | "high",

  openaiChatModel: () => read("OPENAI_CHAT_MODEL") ?? "gpt-5-mini",
  openaiReasoningEffort: () => read("OPENAI_REASONING_EFFORT"),
  openaiSttModel: () => read("OPENAI_STT_MODEL") ?? "gpt-4o-mini-transcribe",
  openaiTtsModel: () => read("OPENAI_TTS_MODEL") ?? "gpt-4o-mini-tts",

  elevenlabsTtsModel: () => read("ELEVENLABS_TTS_MODEL") ?? "eleven_flash_v2_5",
  elevenlabsSttModel: () => read("ELEVENLABS_STT_MODEL") ?? "scribe_v2",
  // "George" — a stock ElevenLabs voice available on every account.
  elevenlabsVoiceId: () =>
    read("ELEVENLABS_VOICE_ID") ?? "JBFqnCBsd6RMkjVDRZzb",

  allowedOrigins: () =>
    (read("ALLOWED_ORIGINS") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  disableRateLimit: () => read("DISABLE_RATE_LIMIT") === "1",
};

export function capabilities(): ServerCapabilities {
  const openai = !!env.openaiKey();
  const anthropic = !!env.anthropicKey();
  const eleven = !!env.elevenlabsKey();
  const gemini = !!env.geminiKey();
  const groq = !!env.groqKey();
  return {
    realtime: openai,
    llm: { anthropic, openai, gemini, groq },
    stt: { openai, elevenlabs: eleven },
    tts: { openai, elevenlabs: eleven },
    models: {
      realtime: env.realtimeModel(),
      anthropic: env.anthropicModel(),
      openai: env.openaiChatModel(),
      gemini: env.geminiModel(),
      groq: env.groqModel(),
    },
    elevenlabsDefaultVoiceId: env.elevenlabsVoiceId(),
  };
}
