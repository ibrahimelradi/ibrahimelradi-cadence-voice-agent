// Shared (client + server) configuration types and option catalogs.
// Nothing in this file may reference secrets.

export type EngineKind = "realtime" | "pipeline" | "browser";
export type LlmProvider = "anthropic" | "openai" | "gemini" | "groq";
export type SpeechProvider = "openai" | "elevenlabs";
export type TurnTaking = "patient" | "balanced" | "quick";
export type MicEnvironment = "near" | "far";

export interface AgentSettings {
  engine: EngineKind;
  language: string; // BCP-47-ish code from LANGUAGES, or "auto"
  style: StyleId;
  /** Extra persona instructions supplied by the user. */
  persona: string;
  turnTaking: TurnTaking;
  micEnvironment: MicEnvironment;
  realtimeVoice: string;
  llmProvider: LlmProvider;
  sttProvider: SpeechProvider;
  ttsProvider: SpeechProvider;
  openaiTtsVoice: string;
  elevenlabsVoiceId: string;
  /** voiceURI of a speechSynthesis voice for Free mode ("" = best match). */
  browserVoice: string;
  speechRate: number; // 0.8 – 1.2
}

export const LANGUAGES: { code: string; label: string; native: string }[] = [
  { code: "auto", label: "Match the speaker", native: "Auto" },
  { code: "en", label: "English", native: "English" },
  { code: "es", label: "Spanish", native: "Español" },
  { code: "fr", label: "French", native: "Français" },
  { code: "de", label: "German", native: "Deutsch" },
  { code: "it", label: "Italian", native: "Italiano" },
  { code: "pt", label: "Portuguese", native: "Português" },
  { code: "nl", label: "Dutch", native: "Nederlands" },
  { code: "pl", label: "Polish", native: "Polski" },
  { code: "tr", label: "Turkish", native: "Türkçe" },
  { code: "ar", label: "Arabic", native: "العربية" },
  { code: "hi", label: "Hindi", native: "हिन्दी" },
  { code: "ja", label: "Japanese", native: "日本語" },
  { code: "ko", label: "Korean", native: "한국어" },
  { code: "zh", label: "Chinese", native: "中文" },
];

export const STYLES = [
  {
    id: "natural",
    label: "Natural",
    hint: "Relaxed and conversational",
    prompt:
      "Speak like a thoughtful, relaxed person in a real conversation. Vary your phrasing, use contractions, and keep it human.",
    voice: "Natural, relaxed conversational tone with gentle, varied intonation.",
  },
  {
    id: "professional",
    label: "Professional",
    hint: "Clear, composed, precise",
    prompt:
      "Speak like a composed, highly competent professional. Be precise and structured, but never stiff or robotic.",
    voice: "Clear, composed, confident professional delivery at a measured pace.",
  },
  {
    id: "concise",
    label: "Concise",
    hint: "Short answers, no filler",
    prompt:
      "Be extremely economical with words. Answer in one or two short sentences unless the user explicitly asks for more.",
    voice: "Crisp and efficient delivery, brisk but not rushed.",
  },
  {
    id: "warm",
    label: "Warm",
    hint: "Calm, kind, reassuring",
    prompt:
      "Be warm, patient and reassuring. Acknowledge feelings briefly when relevant, and keep a calm, kind tone.",
    voice: "Warm, soft and calm, with a reassuring, friendly smile in the voice.",
  },
  {
    id: "energetic",
    label: "Energetic",
    hint: "Upbeat and lively",
    prompt:
      "Be upbeat, curious and lively. Show genuine enthusiasm without exaggeration.",
    voice: "Upbeat, bright and energetic, with lively intonation.",
  },
] as const;

export type StyleId = (typeof STYLES)[number]["id"];

/** Voices accepted by the OpenAI Realtime API. */
export const REALTIME_VOICES = [
  "marin",
  "cedar",
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "sage",
  "shimmer",
  "verse",
] as const;

/** Voices accepted by OpenAI's /v1/audio/speech. */
export const OPENAI_TTS_VOICES = [
  "marin",
  "cedar",
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "nova",
  "onyx",
  "sage",
  "shimmer",
  "verse",
] as const;

export const TURN_TAKING: { id: TurnTaking; label: string; hint: string }[] = [
  { id: "patient", label: "Patient", hint: "Waits longer before replying" },
  { id: "balanced", label: "Balanced", hint: "Natural pauses" },
  { id: "quick", label: "Quick", hint: "Replies as soon as you pause" },
];

export const DEFAULT_SETTINGS: AgentSettings = {
  engine: "realtime",
  language: "auto",
  style: "natural",
  persona: "",
  turnTaking: "balanced",
  micEnvironment: "near",
  realtimeVoice: "marin",
  llmProvider: "anthropic",
  sttProvider: "openai",
  ttsProvider: "openai",
  openaiTtsVoice: "marin",
  elevenlabsVoiceId: "",
  browserVoice: "",
  speechRate: 1,
};

/** What the server reports about configured providers (never secrets). */
export interface ServerCapabilities {
  realtime: boolean;
  llm: Record<LlmProvider, boolean>;
  stt: Record<SpeechProvider, boolean>;
  tts: Record<SpeechProvider, boolean>;
  models: {
    realtime: string;
    anthropic: string;
    openai: string;
    gemini: string;
    groq: string;
  };
  elevenlabsDefaultVoiceId: string;
}

export const LLM_PROVIDERS: { id: LlmProvider; label: string; envVar: string; free: boolean }[] = [
  { id: "gemini", label: "Gemini", envVar: "GEMINI_API_KEY", free: true },
  { id: "groq", label: "Groq", envVar: "GROQ_API_KEY", free: true },
  { id: "anthropic", label: "Claude", envVar: "ANTHROPIC_API_KEY", free: false },
  { id: "openai", label: "OpenAI", envVar: "OPENAI_API_KEY", free: false },
];

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

export const LIMITS = {
  maxHistoryTurns: 40,
  maxTurnChars: 4000,
  maxPersonaChars: 1200,
  maxTtsChars: 1200,
  maxAudioBytes: 10 * 1024 * 1024,
} as const;

export interface ApiErrorBody {
  error: { code: string; message: string; provider?: string };
}
