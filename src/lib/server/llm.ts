import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { ChatTurn, LlmProvider } from "@/lib/shared/config";
import { env } from "./env";
import { ApiError, notConfigured, upstreamError } from "./http";

/** Merge consecutive same-role turns and drop leading assistant turns. */
export function normalizeHistory(history: ChatTurn[]): ChatTurn[] {
  const out: ChatTurn[] = [];
  for (const t of history) {
    const text = t.text.trim();
    if (!text) continue;
    const last = out[out.length - 1];
    if (last && last.role === t.role) last.text += ` ${text}`;
    else if (out.length || t.role === "user") out.push({ role: t.role, text });
  }
  if (!out.length || out[out.length - 1]!.role !== "user") {
    throw new ApiError(400, "invalid_request", "The conversation must end with a user message.");
  }
  return out;
}

export interface StreamArgs {
  provider: LlmProvider;
  system: string;
  history: ChatTurn[];
  signal: AbortSignal;
}

/** Yields text deltas from the configured LLM provider. */
export function streamReply(args: StreamArgs): AsyncGenerator<string> {
  return args.provider === "anthropic" ? streamAnthropic(args) : streamOpenAI(args);
}

// ---- Anthropic (Claude) -----------------------------------------------------

// Models that accept the server-side `fallbacks: "default"` form on the Claude API.
const FALLBACK_MODELS = new Set([
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-fable-5-1",
  "claude-sonnet-5-5",
]);

let anthropicClient: Anthropic | null = null;

async function* streamAnthropic({ system, history, signal }: StreamArgs): AsyncGenerator<string> {
  const apiKey = env.anthropicKey();
  if (!apiKey) throw notConfigured("Anthropic", "ANTHROPIC_API_KEY");
  anthropicClient ??= new Anthropic({ apiKey, maxRetries: 1, timeout: 60_000 });

  const model = env.anthropicModel();
  const useFallbacks = FALLBACK_MODELS.has(model);

  try {
    const stream = anthropicClient.beta.messages.stream(
      {
        model,
        max_tokens: 4096,
        system,
        // Spoken replies are short; low effort keeps time-to-first-word low.
        output_config: { effort: env.anthropicEffort() },
        messages: history.map((t) => ({ role: t.role, content: t.text })),
        ...(useFallbacks
          ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
          : {}),
      },
      { signal },
    );

    let emitted = false;
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        emitted = true;
        yield event.delta.text;
      }
    }
    const final = await stream.finalMessage();
    if (final.stop_reason === "refusal") {
      yield (emitted ? " " : "") + "I'm not able to help with that one. Is there something else I can do?";
    }
  } catch (err) {
    throw mapAnthropicError(err, signal);
  }
}

function mapAnthropicError(err: unknown, signal: AbortSignal): unknown {
  if (signal.aborted || err instanceof Anthropic.APIUserAbortError) return new ApiError(499, "aborted", "Request aborted.");
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError)
    return new ApiError(502, "provider_auth", "Anthropic rejected the API key. Check ANTHROPIC_API_KEY.", "Anthropic");
  if (err instanceof Anthropic.NotFoundError)
    return new ApiError(502, "provider_model", `Anthropic model "${env.anthropicModel()}" was not found. Check ANTHROPIC_MODEL.`, "Anthropic");
  if (err instanceof Anthropic.RateLimitError)
    return new ApiError(429, "provider_rate_limited", "Anthropic is rate limiting requests. Try again shortly.", "Anthropic");
  if (err instanceof Anthropic.BadRequestError)
    return new ApiError(502, "provider_error", `Anthropic error: ${err.message}`, "Anthropic");
  if (err instanceof Anthropic.InternalServerError || err instanceof Anthropic.APIConnectionError)
    return new ApiError(502, "provider_unavailable", "Anthropic is temporarily unavailable.", "Anthropic");
  if (err instanceof Anthropic.APIError)
    return new ApiError(502, "provider_error", `Anthropic error: ${err.message}`, "Anthropic");
  return err;
}

// ---- OpenAI -----------------------------------------------------------------

async function* streamOpenAI({ system, history, signal }: StreamArgs): AsyncGenerator<string> {
  const key = env.openaiKey();
  if (!key) throw notConfigured("OpenAI", "OPENAI_API_KEY");
  const effort = env.openaiReasoningEffort();

  let res: Response;
  try {
    res = await fetch(`${env.openaiBaseUrl()}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: env.openaiChatModel(),
        stream: true,
        max_completion_tokens: 4096,
        ...(effort ? { reasoning_effort: effort } : {}),
        messages: [
          { role: "system", content: system },
          ...history.map((t) => ({ role: t.role, content: t.text })),
        ],
      }),
      signal,
    });
  } catch (err) {
    if (signal.aborted) throw new ApiError(499, "aborted", "Request aborted.");
    console.error("[api] OpenAI connection error", err);
    throw new ApiError(502, "provider_unavailable", "Could not reach OpenAI.", "OpenAI");
  }
  if (!res.ok || !res.body) throw await upstreamError("OpenAI", res);

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return;
        try {
          const j = JSON.parse(data);
          if (j.error) throw new ApiError(502, "provider_error", `OpenAI error: ${j.error.message}`, "OpenAI");
          const delta: string | undefined = j.choices?.[0]?.delta?.content;
          if (delta) yield delta;
        } catch (e) {
          if (e instanceof ApiError) throw e;
        }
      }
    }
  } catch (err) {
    if (signal.aborted) throw new ApiError(499, "aborted", "Request aborted.");
    throw err;
  } finally {
    reader.releaseLock();
  }
}
