import type { AgentSettings } from "@/lib/shared/config";
import { createAudioContext, encodeWav, getMicrophone, LevelMeter, readApiError } from "./audio";
import { ClipPlayer } from "./player";
import { cleanForSpeech, SentenceChunker } from "./sentences";
import { EngineError, type EngineEvents, type Levels, type VoiceEngine } from "./types";
import { EnergyVad, rmsOf, VAD_PRESETS } from "./vad";

const TAP_WORKLET = `
class MicTap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(1024); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) { this.port.postMessage(this.buf); this.buf = new Float32Array(1024); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor("mic-tap", MicTap);
`;

const PREROLL_MS = 450;

interface Turn {
  id: string;
  ac: AbortController;
  spoken: string;
  lastSpoken: string;
  ttsFailed: boolean;
}

const uid = () => crypto.randomUUID();

/**
 * Modular voice pipeline: client-side VAD → speech-to-text → streaming LLM
 * (Claude or OpenAI) → sentence-level text-to-speech (OpenAI or ElevenLabs).
 * Supports barge-in: speaking over the assistant cancels its reply.
 */
export class PipelineEngine implements VoiceEngine {
  private ctx: AudioContext | null = null;
  private mic: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private tap: AudioWorkletNode | null = null;
  private sink: GainNode | null = null;
  private inMeter: LevelMeter | null = null;
  private outMeter: LevelMeter | null = null;
  private player: ClipPlayer | null = null;
  private vad: EnergyVad;
  private stopped = false;
  private muted = false;

  private preroll: Float32Array[] = [];
  private prerollMs = 0;
  private recording: Float32Array[] | null = null;
  private userEntryId: string | null = null;
  private pendingTranscriptions = 0;
  private needsResponse = false;
  private turn: Turn | null = null;

  constructor(
    private settings: AgentSettings,
    private ev: EngineEvents,
  ) {
    this.vad = new EnergyVad(VAD_PRESETS[settings.turnTaking]);
  }

  async start() {
    this.ev.status("connecting");
    this.ctx = createAudioContext();
    if (!this.ctx.audioWorklet) {
      throw new EngineError({
        code: "unsupported",
        message: "This browser doesn't support real-time audio processing. Try a recent Chrome, Edge, Safari or Firefox.",
        fatal: true,
      });
    }
    this.mic = await getMicrophone();
    if (this.stopped) return this.cleanup();

    const url = URL.createObjectURL(new Blob([TAP_WORKLET], { type: "application/javascript" }));
    try {
      await this.ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    if (this.stopped) return this.cleanup();

    const ctx = this.ctx;
    this.source = ctx.createMediaStreamSource(this.mic);
    this.inMeter = new LevelMeter(ctx, this.source);
    this.tap = new AudioWorkletNode(ctx, "mic-tap", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
    this.sink = ctx.createGain();
    this.sink.gain.value = 0; // keep the worklet pulled by the graph without audible output
    this.source.connect(this.tap).connect(this.sink).connect(ctx.destination);
    this.tap.port.onmessage = (e: MessageEvent<Float32Array>) => this.onFrame(e.data);

    this.player = new ClipPlayer(ctx, (err) => this.onTtsError(err));
    this.outMeter = new LevelMeter(ctx, this.player.output);

    this.ev.status("listening");
  }

  // ---- Capture & turn detection --------------------------------------------

  private onFrame(frame: Float32Array) {
    if (this.stopped || this.muted || !this.ctx) return;
    const ms = (frame.length / this.ctx.sampleRate) * 1000;

    if (this.recording) {
      this.recording.push(frame);
    } else {
      this.preroll.push(frame);
      this.prerollMs += ms;
      while (this.prerollMs > PREROLL_MS && this.preroll.length > 1) {
        const f = this.preroll.shift()!;
        this.prerollMs -= (f.length / this.ctx.sampleRate) * 1000;
      }
    }

    const assistantAudible = !!this.player?.busy;
    this.vad.sensitivityBoost = assistantAudible ? 2.2 : 1;
    this.vad.onsetScale = assistantAudible ? 2.2 : 1;

    const evt = this.vad.push(rmsOf(frame), ms);
    if (evt === "start") this.onSpeechStart();
    else if (evt === "end") void this.onSpeechEnd(true);
    else if (evt === "discard") void this.onSpeechEnd(false);
  }

  private onSpeechStart() {
    this.recording = this.preroll;
    this.preroll = [];
    this.prerollMs = 0;
    if (this.turn) this.cancelTurn();
    this.userEntryId = uid();
    this.ev.upsert({ id: this.userEntryId, role: "user", text: "", final: false });
    this.ev.status("hearing");
  }

  private async onSpeechEnd(keep: boolean) {
    const chunks = this.recording ?? [];
    this.recording = null;
    const id = this.userEntryId;
    this.userEntryId = null;
    if (!id) return;

    if (!keep) {
      this.ev.upsert({ id, role: "user", text: "", final: true }); // removed by the store
      this.maybeRespond();
      return;
    }

    this.ev.status("thinking");
    this.pendingTranscriptions++;
    let text = "";
    try {
      text = await this.transcribe(encodeWav(chunks, this.ctx!.sampleRate));
    } catch (err) {
      if (this.stopped) return;
      this.ev.upsert({ id, role: "user", text: "", final: true });
      this.ev.error(toAgentError(err, "Couldn't understand that audio."));
      return;
    } finally {
      this.pendingTranscriptions--;
    }
    if (this.stopped) return;

    this.ev.upsert({ id, role: "user", text, final: true });
    if (text) this.needsResponse = true;
    this.maybeRespond();
  }

  /** Respond once the user has finished and every utterance is transcribed. */
  private maybeRespond() {
    if (this.vad.isSpeaking || this.pendingTranscriptions > 0) return;
    if (this.needsResponse && !this.turn) void this.respond();
    else this.settle();
  }

  private settle() {
    if (this.stopped || this.vad.isSpeaking) return;
    if (this.turn) return;
    if (this.pendingTranscriptions > 0) this.ev.status("thinking");
    else this.ev.status("listening");
  }

  private async transcribe(wav: Blob): Promise<string> {
    const form = new FormData();
    form.append("audio", wav, "speech.wav");
    form.append("provider", this.settings.sttProvider);
    form.append("language", this.settings.language);
    const res = await fetch("/api/transcribe", { method: "POST", body: form });
    if (!res.ok) {
      const e = await readApiError(res, "Speech recognition failed.");
      throw new EngineError({ ...e, fatal: false, action: e.code === "provider_not_configured" ? "settings" : undefined });
    }
    const data = (await res.json()) as { text: string };
    return data.text.trim();
  }

  // ---- Response generation & speech ----------------------------------------

  private async respond() {
    this.needsResponse = false;
    const turn: Turn = { id: uid(), ac: new AbortController(), spoken: "", lastSpoken: "", ttsFailed: false };
    this.turn = turn;
    this.ev.status("thinking");
    const chunker = new SentenceChunker();

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: turn.ac.signal,
        body: JSON.stringify({
          provider: this.settings.llmProvider,
          language: this.settings.language,
          style: this.settings.style,
          persona: this.settings.persona,
          history: this.ev.history().slice(-40),
        }),
      });
      if (!res.ok || !res.body) {
        const e = await readApiError(res, "The AI service is unavailable.");
        throw new EngineError({ ...e, fatal: false, action: e.code === "provider_not_configured" ? "settings" : "retry" });
      }

      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      let done = false;
      while (!done) {
        const { value, done: eof } = await reader.read();
        if (eof) break;
        buf += value;
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          const msg = JSON.parse(line) as { t: string; text?: string; code?: string; message?: string };
          if (msg.t === "delta" && msg.text) {
            for (const s of chunker.push(msg.text)) this.speak(s, turn);
          } else if (msg.t === "error") {
            throw new EngineError({ code: msg.code ?? "llm_error", message: msg.message ?? "The AI service failed.", fatal: false, action: "retry" });
          } else if (msg.t === "done") {
            done = true;
          }
        }
      }
      for (const s of chunker.flush()) this.speak(s, turn);

      await this.player!.whenIdle();
      if (this.turn !== turn) return;
      if (turn.spoken) this.ev.upsert({ id: turn.id, role: "assistant", text: turn.spoken, final: true });
      this.turn = null;
      this.maybeRespond();
    } catch (err) {
      if (turn.ac.signal.aborted || this.stopped) return;
      this.player?.stop();
      if (turn.spoken) {
        this.ev.upsert({ id: turn.id, role: "assistant", text: turn.spoken, final: true, interrupted: true });
      }
      if (this.turn === turn) this.turn = null;
      this.ev.error(toAgentError(err, "The assistant couldn't respond."));
      this.settle();
    }
  }

  private speak(sentence: string, turn: Turn) {
    const text = cleanForSpeech(sentence);
    if (!text || this.turn !== turn) return;
    const previousText = turn.lastSpoken;
    turn.lastSpoken = text;

    const audio = fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: turn.ac.signal,
      body: JSON.stringify({
        provider: this.settings.ttsProvider,
        text,
        previousText: previousText || undefined,
        language: this.settings.language,
        style: this.settings.style,
        openaiVoice: this.settings.openaiTtsVoice,
        elevenlabsVoiceId: this.settings.elevenlabsVoiceId,
        speechRate: this.settings.speechRate,
      }),
    }).then(async (res) => {
      if (!res.ok) {
        const e = await readApiError(res, "Voice synthesis failed.");
        throw new EngineError({ ...e, fatal: false, action: e.code === "provider_not_configured" ? "settings" : undefined });
      }
      return res.arrayBuffer();
    });
    audio.catch(() => {}); // handled by the player

    this.player!.enqueue({
      audio,
      onStart: () => {
        if (this.turn !== turn) return;
        turn.spoken = turn.spoken ? `${turn.spoken} ${text}` : text;
        this.ev.upsert({ id: turn.id, role: "assistant", text: turn.spoken, final: false });
        if (!this.vad.isSpeaking) this.ev.status("speaking");
      },
    });
  }

  private onTtsError(err: unknown) {
    const turn = this.turn;
    if (!turn || turn.ac.signal.aborted || turn.ttsFailed) return;
    turn.ttsFailed = true;
    const e = toAgentError(err, "Voice synthesis failed.");
    this.ev.error({ ...e, message: `${e.message} Showing the reply as text.` });
  }

  private cancelTurn() {
    const turn = this.turn;
    if (!turn) return;
    this.turn = null;
    turn.ac.abort();
    this.player?.stop();
    // Cut off before saying anything: the user's question is still unanswered.
    if (!turn.spoken) this.needsResponse = true;
    if (turn.spoken) {
      this.ev.upsert({ id: turn.id, role: "assistant", text: turn.spoken, final: true, interrupted: true });
    }
  }

  // ---- Controls ------------------------------------------------------------

  interrupt() {
    if (!this.turn) return;
    this.cancelTurn();
    this.needsResponse = false; // explicit stop: don't answer automatically
    this.settle();
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    this.mic?.getAudioTracks().forEach((t) => (t.enabled = !muted));
    if (muted && this.vad.isSpeaking) {
      this.vad.reset();
      void this.onSpeechEnd(false);
    }
  }

  levels(): Levels {
    return { input: this.muted ? 0 : (this.inMeter?.level() ?? 0), output: this.outMeter?.level() ?? 0 };
  }

  stop() {
    this.stopped = true;
    this.turn?.ac.abort();
    this.turn = null;
    this.cleanup();
  }

  private cleanup() {
    this.player?.stop();
    if (this.tap) this.tap.port.onmessage = null;
    for (const n of [this.source, this.tap, this.sink]) {
      try {
        n?.disconnect();
      } catch {
        /* noop */
      }
    }
    this.inMeter?.disconnect();
    this.outMeter?.disconnect();
    this.mic?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close().catch(() => {});
    this.ctx = this.mic = this.source = this.tap = this.sink = null;
    this.inMeter = this.outMeter = this.player = null;
  }
}

function toAgentError(err: unknown, fallback: string) {
  if (err instanceof EngineError) return err.info;
  if (err instanceof TypeError) {
    return { code: "network", message: "Network error. Check your connection.", fatal: false, action: "retry" as const };
  }
  return { code: "unknown", message: fallback, fatal: false };
}
