import "server-only";
import type { ApiErrorBody } from "@/lib/shared/config";
import { env } from "./env";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public provider?: string,
  ) {
    super(message);
  }
}

export function errorResponse(err: unknown): Response {
  if (err instanceof ApiError) {
    const body: ApiErrorBody = {
      error: { code: err.code, message: err.message, provider: err.provider },
    };
    return Response.json(body, { status: err.status });
  }
  console.error("[api] unexpected error", err);
  const body: ApiErrorBody = {
    error: { code: "internal_error", message: "Something went wrong on the server." },
  };
  return Response.json(body, { status: 500 });
}

export function notConfigured(provider: string, envVar: string): ApiError {
  return new ApiError(
    503,
    "provider_not_configured",
    `${provider} is not configured. Set ${envVar} in your server environment.`,
    provider,
  );
}

/** Translate a non-2xx upstream provider response into an ApiError. */
export async function upstreamError(provider: string, res: Response, model?: string): Promise<ApiError> {
  let detail = "";
  try {
    const text = await res.text();
    try {
      let j = JSON.parse(text);
      if (Array.isArray(j)) j = j[0]; // Gemini wraps errors in an array
      detail =
        j?.error?.message ?? j?.detail?.message ?? j?.detail ?? j?.message ?? text;
    } catch {
      detail = text;
    }
  } catch {
    /* ignore */
  }
  detail = String(detail).replace(/\s+/g, " ").trim().slice(0, 300);
  const where = model ? ` (${model})` : "";
  console.error(`[api] ${provider}${where} upstream ${res.status}: ${detail}`);
  // Short provider reason, shown to the user to make problems diagnosable.
  const reason = detail ? ` ${provider} said: "${detail.slice(0, 160)}"` : "";

  if (res.status === 401 || res.status === 403 || /api[ _-]?key/i.test(detail))
    return new ApiError(502, "provider_auth", `${provider} rejected the API key. Check your credentials.${reason}`, provider);
  if (res.status === 429)
    return new ApiError(429, "provider_rate_limited", `${provider} is rate limiting requests or the free daily limit was reached. Try again shortly.${reason}`, provider);
  if (res.status === 404)
    return new ApiError(502, "provider_model", `${provider} model${where} isn't available to your key.${reason}`, provider);
  if (res.status >= 500)
    return new ApiError(502, "provider_unavailable", `${provider} is temporarily unavailable (error ${res.status}).${reason}`, provider);
  return new ApiError(502, "provider_error", `${provider} error${where}: ${detail || res.statusText}`, provider);
}

export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return req.headers.get("x-real-ip") ?? "local";
}

/**
 * Reject cross-site browser requests. Requests without an Origin header
 * (server-to-server, curl) are allowed through; they still need to pass
 * rate limiting. Configure ALLOWED_ORIGINS for deployments behind proxies.
 */
export function assertSameOrigin(req: Request) {
  const origin = req.headers.get("origin");
  if (!origin) return;
  const allowed = env.allowedOrigins();
  if (allowed.includes(origin)) return;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  try {
    if (new URL(origin).host === host) return;
  } catch {
    /* fallthrough */
  }
  throw new ApiError(403, "forbidden_origin", "Cross-origin requests are not allowed.");
}

// ---- In-memory sliding-window rate limiter ---------------------------------
// Good for a single instance. For multi-instance deployments, swap this for a
// shared store (e.g. Redis / Upstash) behind the same function signature.

const buckets = new Map<string, number[]>();
let lastSweep = Date.now();

export function rateLimit(req: Request, scope: string, limit: number, windowMs = 60_000) {
  if (env.disableRateLimit()) return;
  const now = Date.now();
  const key = `${scope}:${clientIp(req)}`;
  const hits = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) {
    throw new ApiError(429, "rate_limited", "Too many requests. Please slow down for a moment.");
  }
  hits.push(now);
  buckets.set(key, hits);

  if (now - lastSweep > 5 * 60_000) {
    lastSweep = now;
    for (const [k, v] of buckets) {
      if (!v.some((t) => now - t < windowMs)) buckets.delete(k);
    }
  }
}

export async function readJson(req: Request, maxBytes = 256 * 1024): Promise<unknown> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > maxBytes) throw new ApiError(413, "payload_too_large", "Request body is too large.");
  const text = await req.text();
  if (text.length > maxBytes) throw new ApiError(413, "payload_too_large", "Request body is too large.");
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid_json", "Request body must be valid JSON.");
  }
}
