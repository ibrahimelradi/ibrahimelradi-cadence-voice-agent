import { connection } from "next/server";
import { env } from "@/lib/server/env";
import { errorResponse, notConfigured, rateLimit, upstreamError } from "@/lib/server/http";

interface ElevenVoice {
  voice_id: string;
  name: string;
  labels?: Record<string, string>;
  category?: string;
}

/** Lists the ElevenLabs voices available to the configured account. */
export async function GET(req: Request) {
  await connection();
  try {
    rateLimit(req, "voices", 20);
    const key = env.elevenlabsKey();
    if (!key) throw notConfigured("ElevenLabs", "ELEVENLABS_API_KEY");
    const res = await fetch(`${env.elevenlabsBaseUrl()}/v1/voices`, {
      headers: { "xi-api-key": key },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw await upstreamError("ElevenLabs", res);
    const data = (await res.json()) as { voices?: ElevenVoice[] };
    const voices = (data.voices ?? []).map((v) => ({
      id: v.voice_id,
      name: v.name,
      description: [v.labels?.accent, v.labels?.gender, v.labels?.description ?? v.labels?.descriptive]
        .filter(Boolean)
        .join(" · "),
    }));
    return Response.json({ voices });
  } catch (err) {
    return errorResponse(err);
  }
}
