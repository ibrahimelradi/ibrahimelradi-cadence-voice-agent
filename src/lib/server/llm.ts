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
  return args.provider === "anthropic" ? streamAnthropic(args) : streamChatCompletions(args);
}

/** Providers served through an OpenAI-compatible Chat Completions endpoint. */
interface CompatProvider {
  name: string;
  envVar: string;
  key: () => string | undefined;
  url: () => string;
  model: () => string;
  effort: () => string | undefined;
  maxTokensParam: "max_tokens" | "max_completion_tokens";
}

const COMPAT: Record<Exclude<LlmProvider, "anthropic">, CompatProvider> = {
  openai: {
    name: "OpenAI",
    envVar: "OPENAI_API_KEY",
    key: env.openaiKey,
    url: () => `${env.openaiBaseUrl()}/chat/completions`,
    model: env.openaiChatModel,
    effort: env.openaiReasoningEffort,
    maxTokensParam: "max_completion_tokens",
  },
  gemini: {
    name: "Gemini",
    envVar: "GEMINI_API_KEY",
    key: env.geminiKey,
    url: () => "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    model: env.geminiModel,
    effort: env.geminiReasoningEffort,
    maxTokensParam: "max_tokens",
  },
  groq: {
    name: "Groq",
    envVar: "GROQ_API_KEY",
    key: env.groqKey,
    url: () => "https://api.groq.com/openai/v1/chat/completions",
    model: env.groqModel,
    effort: () => undefined,
    maxTokensParam: "max_tokens",
  },
};

export function isProviderConfigured(provider: LlmProvider): boolean {
  return provider === "anthropic" ? !!env.anthropicKey() : !!COMPAT[provider].key();
}

export function providerEnvVar(provider: LlmProvider): string {
  return provider === "anthropic" ? "ANTHROPIC_API_KEY" : COMPAT[provider].envVar;
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

// ---- OpenAI-compatible (OpenAI, Gemini, Groq) --------------------------------

async function* streamChatCompletions({ provider, system, history, signal }: StreamArgs): AsyncGenerator<string> {
  const p = COMPAT[provider as Exclude<LlmProvider, "anthropic">];
  const key = p.key();
  if (!key) throw notConfigured(p.name, p.envVar);
  const effort = p.effort();

  let res: Response;
  try {
    res = await fetch(p.url(), {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: p.model(),
        stream: true,
        [p.maxTokensParam]: 4096,
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
    console.error(`[api] ${p.name} connection error`, err);
    throw new ApiError(502, "provider_unavailable", `Could not reach ${p.name}.`, p.name);
  }
  if (!res.ok || !res.body) throw await upstreamError(p.name, res);

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
          if (j.error) throw new ApiError(502, "provider_error", `${p.name} error: ${j.error.message}`, p.name);
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
