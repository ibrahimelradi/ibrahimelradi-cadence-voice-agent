import "server-only";
import { z } from "zod";
import {
  LANGUAGES,
  LIMITS,
  OPENAI_TTS_VOICES,
  REALTIME_VOICES,
  STYLES,
} from "@/lib/shared/config";
import { ApiError } from "./http";

const languageCodes = LANGUAGES.map((l) => l.code) as [string, ...string[]];
const styleIds = STYLES.map((s) => s.id) as [string, ...string[]];

export const personaSchema = z.object({
  language: z.enum(languageCodes).default("auto"),
  style: z.enum(styleIds).default("natural"),
  persona: z.string().max(LIMITS.maxPersonaChars).default(""),
});

export const historySchema = z
  .array(
    z.object({
      role: z.enum(["user", "assistant"]),
      text: z.string().max(LIMITS.maxTurnChars),
    }),
  )
  .max(LIMITS.maxHistoryTurns);

export const realtimeSessionSchema = personaSchema.extend({
  voice: z.enum(REALTIME_VOICES).default("marin"),
  turnTaking: z.enum(["patient", "balanced", "quick"]).default("balanced"),
  micEnvironment: z.enum(["near", "far"]).default("near"),
  speechRate: z.number().min(0.8).max(1.2).default(1),
  history: historySchema.default([]),
});

export const chatSchema = personaSchema.extend({
  provider: z.enum(["anthropic", "openai", "gemini", "groq"]),
  history: historySchema.min(1),
});

export const ttsSchema = z.object({
  provider: z.enum(["openai", "elevenlabs"]),
  text: z.string().trim().min(1).max(LIMITS.maxTtsChars),
  previousText: z.string().max(LIMITS.maxTtsChars).optional(),
  language: z.enum(languageCodes).default("auto"),
  style: z.enum(styleIds).default("natural"),
  openaiVoice: z.enum(OPENAI_TTS_VOICES).default("marin"),
  elevenlabsVoiceId: z
    .string()
    .regex(/^[A-Za-z0-9]{0,64}$/, "Invalid ElevenLabs voice id")
    .default(""),
  speechRate: z.number().min(0.8).max(1.2).default(1),
});

export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new ApiError(
      400,
      "invalid_request",
      `Invalid request: ${issue?.path.join(".") || "body"} — ${issue?.message ?? "invalid"}`,
    );
  }
  return r.data;
}
