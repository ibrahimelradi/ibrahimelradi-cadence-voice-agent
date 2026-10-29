import "server-only";
import type { ServerCapabilities } from "@/lib/shared/config";

function read(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

export const env = {
  openaiKey: () => read("OPENAI_API_KEY"),
  anthropicKey: () => read("ANTHROPIC_API_KEY"),
  elevenlabsKey: () => read("ELEVENLABS_API_KEY"),

  openaiBaseUrl: () => (read("OPENAI_BASE_URL") ?? "https://api.openai.com/v1").replace(/\/+$/, ""),
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
  return {
    realtime: openai,
    llm: { anthropic, openai },
    stt: { openai, elevenlabs: eleven },
    tts: { openai, elevenlabs: eleven },
    models: {
      realtime: env.realtimeModel(),
      anthropic: env.anthropicModel(),
      openai: env.openaiChatModel(),
    },
    elevenlabsDefaultVoiceId: env.elevenlabsVoiceId(),
  };
}
