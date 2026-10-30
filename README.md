# Cadence: AI Voice Agent

Cadence is a real-time voice assistant built with Next.js. You talk, it listens, thinks, and talks back, and you can interrupt it mid-sentence.

It has three conversation engines behind one interface:

| Engine | How it works | Best for |
|---|---|---|
| **Free** | The browser's built-in speech recognition and voices (Web Speech API) + a free-tier AI model (**Gemini** or **Groq**) | Trying it at no cost |
| **Realtime** (default) | Browser ⇄ OpenAI Realtime over **WebRTC**. Speech-to-speech in one model, with server-side semantic turn detection and native barge-in. | Lowest latency, most natural turn-taking |
| **Modular** | Browser VAD → **STT** (OpenAI or ElevenLabs) → **LLM** (Claude or OpenAI, streamed) → sentence-by-sentence **TTS** (OpenAI or ElevenLabs) | Choosing the brain and the voice separately, e.g. Claude + ElevenLabs |

## Quick start

```bash
npm install
cp .env.example .env.local   # add at least one key setup (see below)
npm run dev                   # http://localhost:3000
```

Microphone access requires a **secure context**: `localhost` works, and any other host must be served over HTTPS.

### Which keys do I need?

| You want | Set |
|---|---|
| **Free mode** | `GEMINI_API_KEY` (free at [aistudio.google.com](https://aistudio.google.com/apikey)) or `GROQ_API_KEY` (free at [console.groq.com](https://console.groq.com/keys)) |
| Realtime mode | `OPENAI_API_KEY` |
| Modular with Claude + OpenAI voice | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` |
| Modular with Claude + ElevenLabs voice | `ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY` |
| Modular, all OpenAI | `OPENAI_API_KEY` |

The app detects which keys are present (`GET /api/config` reports booleans only, never key values). It disables unavailable options in **Settings** and tells you exactly which variable is missing.

All tunables (models, effort, voices, base URLs, allowed origins, rate limiting) are documented in [`.env.example`](./.env.example). Defaults:

| Purpose | Default |
|---|---|
| Realtime model | `gpt-realtime-2.1` (transcripts via `gpt-4o-mini-transcribe`) |
| Claude model | `claude-opus-5-5`, `effort: low` for snappy spoken replies, server-side refusal fallback enabled |
| OpenAI chat model | `gpt-5-mini` |
| Gemini / Groq (Free mode) | `gemini-flash-latest` / `llama-3.3-70b-versatile` |
| OpenAI STT / TTS | `gpt-4o-mini-transcribe` / `gpt-4o-mini-tts` (style-steered via `instructions`) |
| ElevenLabs STT / TTS | `scribe_v2` / `eleven_flash_v2_5` |

## Features

- **Natural voice loop**: live mic capture, speech detection, streaming replies, and natural-sounding voices.
- **Interruptions (barge-in)**: just start talking, or press **Interrupt** / `Esc`. Realtime truncates server-side. Modular stops playback, cancels in-flight LLM and TTS requests, and keeps only the words actually spoken in the history.
- **Turn detection**: Patient, Balanced, or Quick. This maps to semantic-VAD eagerness in Realtime mode and to the silence window in Modular mode.
- **Live transcript**: streaming partials, an "interrupted" marker, copy and clear. It lives only in memory and is never stored.
- **Context**: multi-turn memory. A restarted Realtime session is seeded with the prior conversation.
- **Personality & language**: 5 speaking styles, custom instructions, 14 languages or auto-match, voice selection (Realtime voices, OpenAI TTS voices, or your ElevenLabs voice library), speaking rate, and mic environment (near/far-field noise reduction).
- **Controls**: Start/End (`Space`), Mute (`M`), Interrupt (`Esc`), Restart.
- **Resilience**: friendly messages for mic denied / missing / busy, insecure context, missing keys, provider auth or rate-limit or outage errors. Dropped WebRTC connections auto-reconnect (max 2 per minute). Speech-model hallucinations on silence are filtered out.
- **UI**: an animated orb with distinct listening, hearing, thinking, and speaking states; dark and light themes; responsive layout (side panel on desktop, bottom sheet on mobile); reduced-motion support.

## Free mode notes

- Works best in **Chrome or Edge**. Firefox has no built-in speech recognition, so the app tells you to switch browsers.
- In Chrome, speech recognition is processed by Google's servers, so it needs an internet connection.
- Voices come from your device, so quality varies. Edge's "Natural" voices and Chrome's "Google" voices usually sound best; pick one in Settings → Voice.
- The microphone pauses while the assistant talks so it doesn't hear itself. To cut in, tap the orb or press **Interrupt** (`Esc`).
- Free API tiers have daily request limits. When you hit one, the app shows the provider's rate-limit message.

## Architecture

```
src/
├─ app/api/
│  ├─ realtime/session   POST  mint a 120s OpenAI Realtime client secret (instructions built server-side)
│  ├─ chat               POST  stream LLM reply as NDJSON (Claude via @anthropic-ai/sdk; OpenAI, Gemini, Groq)
│  ├─ transcribe         POST  multipart WAV → text (OpenAI / ElevenLabs)
│  ├─ tts                POST  text → streamed MP3 (OpenAI / ElevenLabs)
│  ├─ voices             GET   list ElevenLabs voices
│  └─ config             GET   which providers are configured (booleans only)
├─ lib/server/           env, validation (zod), prompts, rate limiting, origin checks, provider adapters
├─ lib/client/
│  ├─ realtime-engine.ts WebRTC peer connection + `oai-events` data channel
│  ├─ pipeline-engine.ts AudioWorklet capture, VAD, STT → LLM → TTS, barge-in
│  ├─ browser-engine.ts  Free mode: Web Speech recognition + speechSynthesis
│  ├─ vad.ts             energy VAD with adaptive noise floor
│  ├─ player.ts          ordered, gapless clip playback (prefetches next sentence)
│  └─ sentences.ts       streaming sentence chunker (short first chunk for fast first word)
├─ hooks/useVoiceAgent.ts  state machine shared by both engines
└─ components/           Orb, Controls, Transcript, Settings, VoiceApp
```

**Latency notes for Modular mode:** the reply streams token by token, and the first sentence is sent to TTS as soon as it is complete. Later sentences are synthesized while earlier ones play. 450 ms of pre-roll audio is kept so the start of each utterance isn't clipped.

## Security

- API keys are read only on the server (`server-only` modules) and never reach the browser. Realtime uses short-lived ephemeral client secrets.
- Every request is validated with zod (sizes, enums, history length, audio type and size ≤ 10 MB).
- Same-origin enforcement on POST routes (`ALLOWED_ORIGINS` for extra origins).
- Per-IP sliding-window rate limits. These are in memory, so for multi-instance deployments swap `rateLimit()` in `src/lib/server/http.ts` for a shared store such as Redis or Upstash.
- Audio and transcripts are never persisted. Settings are stored in `localStorage`; the transcript is not.
- **Before exposing this publicly**, put authentication in front of it. As-is, anyone who can reach the app can spend your API credits, within the rate limits.

## Deployment

Works on any Node host (`npm run build && npm start`) or Vercel. Set the environment variables in your host's dashboard. HTTPS is required for the microphone. WebRTC needs outbound UDP; on locked-down networks the Realtime engine may fail to connect, and the app reports this. Use Modular mode there.

## Testing status

Verified locally:
- `tsc`, `eslint` and `next build` pass.
- API validation, missing-key errors, cross-origin rejection and rate limiting were exercised with curl.
- The **full Modular loop ran in headless Chromium with a fake microphone** against local stand-ins for the provider HTTP APIs. This covered VAD → WAV upload → streamed reply → sentence TTS → ordered playback, multi-turn context, **barge-in mid-reply**, the mobile layout and the light theme.
- The Claude request shape (model, effort, fallback beta, history normalization) was checked against a local stand-in for the Messages API.

**Not yet verified against live provider APIs** (no keys were available while building): OpenAI Realtime WebRTC, OpenAI / Anthropic / ElevenLabs responses, and voice quality. The integrations follow the current published API references. If a provider has renamed a model, override it via the env vars above.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Microphone access was blocked" | Click the lock icon in the address bar, allow the microphone, then **Try again**. |
| "needs a secure connection" | Use `http://localhost` or HTTPS. |
| Realtime "connection timed out" | The network blocks WebRTC/UDP. Switch to Modular in Settings. |
| Assistant interrupts itself on speakers | Use headphones, or set Microphone → *Laptop / room*. Browser echo cancellation is on by default. |
| "model … was not found" | Set `ANTHROPIC_MODEL` / `OPENAI_CHAT_MODEL` / `OPENAI_REALTIME_MODEL` to a model your account can use. |
