import "server-only";
import { LANGUAGES, STYLES, type ChatTurn, type StyleId } from "@/lib/shared/config";

export function languageName(code: string): string | null {
  if (code === "auto") return null;
  return LANGUAGES.find((l) => l.code === code)?.label ?? null;
}

export function styleOf(id: string) {
  return STYLES.find((s) => s.id === id) ?? STYLES[0];
}

interface PromptInput {
  language: string;
  style: StyleId | string;
  persona: string;
}

/**
 * System prompt for a spoken assistant. Everything the model writes is read
 * aloud, so the prompt focuses on speakable output.
 */
export function buildSystemPrompt({ language, style, persona }: PromptInput): string {
  const lang = languageName(language);
  const s = styleOf(style);
  const parts = [
    "You are a voice assistant having a live, spoken conversation with the user through their microphone and speakers. Everything you write is converted to speech.",
    "",
    "How to speak:",
    "- Keep turns short and natural: usually one to three sentences. Offer to go deeper rather than lecturing.",
    "- Write for the ear. No markdown, bullet points, headings, emoji, URLs or code blocks. Spell out symbols and say numbers the way a person would.",
    "- When something has several parts, say how many there are and walk through them conversationally.",
    "- Don't open every reply the same way and don't repeat the user's question back. Avoid filler like \"Great question\".",
    "- If the user's words seem garbled or cut off by speech recognition, make a sensible guess or briefly ask them to repeat.",
    "- If you don't know something or can't access live information, say so plainly instead of guessing.",
    "- Remember everything said earlier in the conversation and handle follow-ups naturally.",
    "",
    `Personality: ${s.prompt}`,
    lang
      ? `Language: always respond in ${lang}, even if the user switches language, unless they explicitly ask you to change.`
      : "Language: respond in the same language the user is speaking. If they switch languages, switch with them.",
  ];
  const extra = persona.trim();
  if (extra) {
    parts.push("", "Additional instructions from the user (follow them unless they conflict with the rules above):", extra);
  }
  return parts.join("\n");
}

/** Prior turns, folded into instructions when a realtime session is restarted. */
export function historyAppendix(history: ChatTurn[]): string {
  if (!history.length) return "";
  const lines = history
    .slice(-20)
    .map((t) => `${t.role === "user" ? "User" : "You"}: ${t.text.replace(/\s+/g, " ").trim()}`);
  return [
    "",
    "This is a resumed conversation. Here is what was said so far (for context only, don't repeat it):",
    ...lines,
  ].join("\n");
}
