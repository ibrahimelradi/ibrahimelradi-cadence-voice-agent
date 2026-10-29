import type { AgentSettings } from "@/lib/shared/config";
import { createAudioContext, getMicrophone, LevelMeter, readApiError } from "./audio";
import { EngineError, type EngineEvents, type Levels, type VoiceEngine } from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any */
type ServerEvent = { type: string; [k: string]: any };

const IGNORED_ERROR_CODES = new Set(["response_cancel_not_active", "conversation_already_has_active_response"]);

/**
 * Speech-to-speech over the OpenAI Realtime API (WebRTC).
 * Audio flows browser <-> OpenAI directly; our server only mints a short-lived
 * client secret. Turn detection, barge-in and truncation are handled server-side.
 */
export class RealtimeEngine implements VoiceEngine {
  private ctx: AudioContext | null = null;
  private mic: MediaStream | null = null;
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private audioEl: HTMLAudioElement | null = null;
  private inMeter: LevelMeter | null = null;
  private outMeter: LevelMeter | null = null;
  private stopped = false;

  private userText = new Map<string, string>();
  private assistantText = new Map<string, string>();
  private currentAssistantId: string | null = null;
  private responseActive = false;
  private audioPlaying = false;
  private userSpeaking = false;
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private quietSince = 0;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private clearOpenTimer: () => void = () => {};

  constructor(
    private settings: AgentSettings,
    private ev: EngineEvents,
  ) {}

  async start() {
    this.ev.status("connecting");
    // Create the AudioContext synchronously inside the user gesture.
    this.ctx = createAudioContext();
    this.mic = await getMicrophone();
    if (this.stopped) return this.cleanup();
    this.inMeter = new LevelMeter(this.ctx, this.ctx.createMediaStreamSource(this.mic));

    const tokenRes = await fetch("/api/realtime/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        voice: this.settings.realtimeVoice,
        language: this.settings.language,
        style: this.settings.style,
        persona: this.settings.persona,
        turnTaking: this.settings.turnTaking,
        micEnvironment: this.settings.micEnvironment,
        speechRate: this.settings.speechRate,
        history: this.ev.history().slice(-20),
      }),
    });
    if (!tokenRes.ok) {
      const e = await readApiError(tokenRes, "Couldn't start a voice session.");
      throw new EngineError({
        ...e,
        fatal: true,
        action: e.code === "provider_not_configured" ? "settings" : "retry",
      });
    }
    const { clientSecret, callsUrl } = (await tokenRes.json()) as { clientSecret: string; callsUrl: string };
    if (this.stopped) return this.cleanup();

    const pc = new RTCPeerConnection();
    this.pc = pc;

    const audioEl = document.createElement("audio");
    audioEl.autoplay = true;
    audioEl.setAttribute("playsinline", "");
    this.audioEl = audioEl;

    pc.ontrack = (e) => {
      const [stream] = e.streams;
      if (!stream || !this.ctx) return;
      audioEl.srcObject = stream;
      void audioEl.play().catch(() => {});
      this.outMeter?.disconnect();
      this.outMeter = new LevelMeter(this.ctx, this.ctx.createMediaStreamSource(stream));
    };
    pc.onconnectionstatechange = () => this.onConnectionState();

    for (const track of this.mic.getAudioTracks()) pc.addTrack(track, this.mic);

    const dc = pc.createDataChannel("oai-events");
    this.dc = dc;
    dc.onmessage = (e) => {
      try {
        this.handle(JSON.parse(e.data));
      } catch (err) {
        console.warn("[realtime] bad event", err);
      }
    };
    let openTimer: ReturnType<typeof setTimeout> | undefined;
    const opened = new Promise<void>((resolve, reject) => {
      openTimer = setTimeout(() => reject(new Error("timeout")), 15_000);
      dc.onopen = () => {
        clearTimeout(openTimer);
        resolve();
      };
    });
    opened.catch(() => {}); // awaited below; avoid an unhandled rejection if we bail out early
    this.clearOpenTimer = () => clearTimeout(openTimer);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    let sdpRes: Response;
    try {
      sdpRes = await fetch(callsUrl, {
        method: "POST",
        body: offer.sdp,
        headers: { Authorization: `Bearer ${clientSecret}`, "Content-Type": "application/sdp" },
      });
    } catch {
      throw new EngineError({
        code: "network",
        message: "Couldn't reach the voice service. Check your connection and try again.",
        fatal: true,
        action: "retry",
      });
    }
    if (!sdpRes.ok) {
      const detail = await sdpRes.text().catch(() => "");
      console.error("[realtime] SDP exchange failed", sdpRes.status, detail);
      throw new EngineError({
        code: "realtime_connect_failed",
        message: `The voice service refused the connection (${sdpRes.status}).`,
        fatal: true,
        action: "retry",
      });
    }
    if (this.stopped) return this.cleanup();
    await pc.setRemoteDescription({ type: "answer", sdp: await sdpRes.text() });

    try {
      await opened;
    } catch {
      throw new EngineError({
        code: "realtime_timeout",
        message: "The voice connection timed out. Your network may be blocking WebRTC.",
        fatal: true,
        action: "retry",
      });
    }
    if (this.stopped) return this.cleanup();
    this.ev.status("listening");
    this.watchdog = setInterval(() => this.checkSpeakingDone(), 200);
  }

  private send(event: object) {
    if (this.dc?.readyState === "open") this.dc.send(JSON.stringify(event));
  }

  private handle(e: ServerEvent) {
    switch (e.type) {
      case "input_audio_buffer.speech_started": {
        this.userSpeaking = true;
        if (this.responseActive || this.audioPlaying) this.markInterrupted();
        if (e.item_id) {
          this.userText.set(e.item_id, "");
          this.ev.upsert({ id: e.item_id, role: "user", text: "", final: false });
        }
        this.ev.status("hearing");
        break;
      }
      case "input_audio_buffer.speech_stopped":
        this.userSpeaking = false;
        this.ev.status("thinking");
        break;

      case "conversation.item.input_audio_transcription.delta": {
        const text = (this.userText.get(e.item_id) ?? "") + (e.delta ?? "");
        this.userText.set(e.item_id, text);
        this.ev.upsert({ id: e.item_id, role: "user", text, final: false });
        break;
      }
      case "conversation.item.input_audio_transcription.completed":
        this.userText.set(e.item_id, e.transcript ?? "");
        this.ev.upsert({ id: e.item_id, role: "user", text: (e.transcript ?? "").trim(), final: true });
        break;
      case "conversation.item.input_audio_transcription.failed":
        this.ev.upsert({ id: e.item_id, role: "user", text: "…", final: true });
        break;

      case "response.created":
        this.responseActive = true;
        if (!this.userSpeaking) this.ev.status("thinking");
        break;

      case "response.output_audio_transcript.delta":
      case "response.output_text.delta": {
        const id = e.item_id as string;
        this.currentAssistantId = id;
        const text = (this.assistantText.get(id) ?? "") + (e.delta ?? "");
        this.assistantText.set(id, text);
        this.ev.upsert({ id, role: "assistant", text, final: false });
        break;
      }
      case "response.output_audio_transcript.done":
      case "response.output_text.done": {
        const id = e.item_id as string;
        const text = e.transcript ?? e.text ?? this.assistantText.get(id) ?? "";
        this.assistantText.set(id, text);
        this.ev.upsert({ id, role: "assistant", text, final: true });
        break;
      }

      case "output_audio_buffer.started":
        this.audioPlaying = true;
        this.quietSince = 0;
        this.ev.status("speaking");
        break;
      case "output_audio_buffer.stopped":
      case "output_audio_buffer.cleared":
        this.audioPlaying = false;
        if (!this.userSpeaking && !this.responseActive) this.ev.status("listening");
        break;

      case "response.done": {
        this.responseActive = false;
        const status = e.response?.status;
        if (status === "cancelled" && this.currentAssistantId) {
          this.ev.upsert({ id: this.currentAssistantId, role: "assistant", final: true, interrupted: true });
        } else if (status === "failed") {
          const msg = e.response?.status_details?.error?.message ?? "The assistant couldn't respond.";
          this.ev.error({ code: "response_failed", message: msg, fatal: false });
        }
        if (!this.audioPlaying && !this.userSpeaking) this.ev.status("listening");
        break;
      }

      case "error": {
        const code = e.error?.code ?? "realtime_error";
        if (IGNORED_ERROR_CODES.has(code)) break;
        console.warn("[realtime] server error", e.error);
        this.ev.error({ code, message: e.error?.message ?? "The voice service reported an error.", fatal: false });
        break;
      }
    }
  }

  /** Fallback in case output_audio_buffer events are not delivered. */
  private checkSpeakingDone() {
    if (!this.audioPlaying || this.responseActive) return;
    const out = this.outMeter?.level() ?? 0;
    const now = performance.now();
    if (out > 0.05) {
      this.quietSince = 0;
      return;
    }
    if (!this.quietSince) this.quietSince = now;
    else if (now - this.quietSince > 1500) {
      this.audioPlaying = false;
      if (!this.userSpeaking) this.ev.status("listening");
    }
  }

  private markInterrupted() {
    if (this.currentAssistantId) {
      this.ev.upsert({ id: this.currentAssistantId, role: "assistant", final: true, interrupted: true });
    }
  }

  private onConnectionState() {
    const state = this.pc?.connectionState;
    if (this.stopped) return;
    if (state === "failed" || state === "closed") {
      this.fail();
    } else if (state === "disconnected") {
      this.disconnectTimer ??= setTimeout(() => {
        this.disconnectTimer = null;
        if (this.pc?.connectionState === "disconnected") this.fail();
      }, 5000);
    } else if (state === "connected" && this.disconnectTimer) {
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
    }
  }

  private fail() {
    this.ev.error({
      code: "connection_lost",
      message: "The voice connection dropped.",
      fatal: true,
      action: "retry",
    });
  }

  interrupt() {
    if (!this.responseActive && !this.audioPlaying) return;
    this.send({ type: "response.cancel" });
    this.send({ type: "output_audio_buffer.clear" });
    this.markInterrupted();
    this.audioPlaying = false;
    this.responseActive = false;
    this.ev.status("listening");
  }

  setMuted(muted: boolean) {
    this.mic?.getAudioTracks().forEach((t) => (t.enabled = !muted));
  }

  levels(): Levels {
    return { input: this.inMeter?.level() ?? 0, output: this.outMeter?.level() ?? 0 };
  }

  stop() {
    this.stopped = true;
    this.cleanup();
  }

  private cleanup() {
    this.clearOpenTimer();
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
    this.watchdog = this.disconnectTimer = null;
    try {
      this.dc?.close();
    } catch {
      /* noop */
    }
    if (this.pc) {
      this.pc.ontrack = null;
      this.pc.onconnectionstatechange = null;
      this.pc.getSenders().forEach((s) => s.track?.stop());
      this.pc.close();
    }
    this.mic?.getTracks().forEach((t) => t.stop());
    if (this.audioEl) {
      this.audioEl.pause();
      this.audioEl.srcObject = null;
    }
    this.inMeter?.disconnect();
    this.outMeter?.disconnect();
    void this.ctx?.close().catch(() => {});
    this.dc = this.pc = this.mic = this.audioEl = this.ctx = null;
    this.inMeter = this.outMeter = null;
  }
}
