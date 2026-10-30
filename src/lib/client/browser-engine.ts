import type { AgentSettings, TurnTaking } from "@/lib/shared/config";
import { createAudioContext, getMicrophone, LevelMeter, readApiError } from "./audio";
import { cleanForSpeech, SentenceChunker } from "./sentences";
import { EngineError, type AgentError, type EngineEvents, type Levels, type VoiceEngine } from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Recognition = any;

const SILENCE_MS: Record<TurnTaking, number> = { patient: 1500, balanced: 950, quick: 600 };

const LANG_TAGS: Record<string, string> = {
  en: "en-US", es: "es-ES", fr: "fr-FR", de: "de-DE", it: "it-IT", pt: "pt-BR", nl: "nl-NL",
  pl: "pl-PL", tr: "tr-TR", ar: "ar-SA", hi: "hi-IN", ja: "ja-JP", ko: "ko-KR", zh: "zh-CN",
};

export function speechLangTag(code: string): string {
  return LANG_TAGS[code] ?? (typeof navigator !== "undefined" ? navigator.language : "en-US");
}

function recognitionCtor(): (new () => Recognition) | null {
  if (typeof window === "undefined") return null;
  const w = window as any;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function browserSpeechSupported(): boolean {
  return !!recognitionCtor() && typeof window !== "undefined" && "speechSynthesis" in window;
}

/** speechSynthesis voices load asynchronously in some browsers. */
export function loadVoices(timeoutMs = 1500): Promise<SpeechSynthesisVoice[]> {
  const synth = window.speechSynthesis;
  const now = synth.getVoices();
  if (now.length) return Promise.resolve(now);
  return new Promise((resolve) => {
    const done = () => {
      synth.removeEventListener("voiceschanged", done);
      resolve(synth.getVoices());
    };
    synth.addEventListener("voiceschanged", done);
    setTimeout(done, timeoutMs);
  });
}

/** Rank voices so the most natural-sounding one for the language wins. */
export function pickVoice(voices: SpeechSynthesisVoice[], langTag: string, preferredURI: string) {
  const chosen = voices.find((v) => v.voiceURI === preferredURI);
  if (chosen) return chosen;
  const base = langTag.split("-")[0]!.toLowerCase();
  const score = (v: SpeechSynthesisVoice) => {
    let s = 0;
    if (v.lang.toLowerCase() === langTag.toLowerCase()) s += 4;
    if (/natural|neural|online/i.test(v.name)) s += 3;
    if (/google|premium|enhanced|siri/i.test(v.name)) s += 2;
    if (!v.localService) s += 1;
    return s;
  };
  return (
    voices
      .filter((v) => v.lang.toLowerCase().startsWith(base))
      .sort((a, b) => score(b) - score(a))[0] ?? null
  );
}

interface Turn {
  id: string;
  ac: AbortController;
  spoken: string;
  pending: number;
  streamDone: boolean;
  voiceFailed?: boolean;
}

const uid = () => crypto.randomUUID();

/**
 * Free mode: the browser's built-in speech recognition (Web Speech API) and
 * speech synthesis, with replies streamed from a free-tier LLM via /api/chat.
 * No paid speech services are involved.
 */
export class BrowserEngine implements VoiceEngine {
  private rec: Recognition | null = null;
  private ctx: AudioContext | null = null;
  private mic: MediaStream | null = null;
  private inMeter: LevelMeter | null = null;
  private voice: SpeechSynthesisVoice | null = null;
  private lang: string;

  private stopped = false;
  private muted = false;
  private wantListening = false;
  private finalText = "";
  private interimText = "";
  private userEntryId: string | null = null;
  private endTimer: ReturnType<typeof setTimeout> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private turn: Turn | null = null;
  private speakingSince = 0;

  constructor(
    private settings: AgentSettings,
    private ev: EngineEvents,
  ) {
    this.lang = speechLangTag(settings.language);
  }

  async start() {
    this.ev.status("connecting");
    const Ctor = recognitionCtor();
    if (!Ctor || !("speechSynthesis" in window)) {
      throw new EngineError({
        code: "unsupported",
        message: "Free mode uses your browser's built-in speech recognition, which needs Chrome, Edge or Safari.",
        fatal: true,
        action: "settings",
      });
    }
    this.ctx = createAudioContext();
    this.mic = await getMicrophone(); // asks for permission and drives the orb's level meter
    if (this.stopped) return this.cleanup();
    this.inMeter = new LevelMeter(this.ctx, this.ctx.createMediaStreamSource(this.mic));

    this.voice = pickVoice(await loadVoices(), this.lang, this.settings.browserVoice);
    if (this.stopped) return this.cleanup();
    window.speechSynthesis.cancel();

    const rec: Recognition = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = this.lang;
    rec.maxAlternatives = 1;
    rec.onresult = (e: any) => this.onResult(e);
    rec.onerror = (e: any) => this.onRecError(e.error);
    rec.onend = () => this.onRecEnd();
    this.rec = rec;

    this.resumeListening();
    this.ev.status("listening");
  }

  // ---- Recognition -----------------------------------------------------------

  private resumeListening() {
    if (this.stopped || this.muted) return;
    this.wantListening = true;
    try {
      this.rec?.start();
    } catch {
      /* already started */
    }
  }

  private pauseListening() {
    this.wantListening = false;
    try {
      this.rec?.abort();
    } catch {
      /* noop */
    }
  }

  private onRecEnd() {
    // Browsers end recognition after silence or ~60s; keep it going while live.
    if (!this.wantListening || this.stopped) return;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.wantListening || this.stopped) return;
      try {
        this.rec?.start();
      } catch {
        /* already running */
      }
    }, 120);
  }

  private onRecError(code: string) {
    if (code === "no-speech" || code === "aborted") return;
    let info: AgentError;
    if (code === "not-allowed" || code === "service-not-allowed") {
      info = {
        code: "mic_denied",
        message: "Speech recognition was blocked. Allow microphone access for this site, then try again.",
        fatal: true,
        action: "permissions",
      };
    } else if (code === "audio-capture") {
      info = { code: "mic_missing", message: "No microphone was found. Connect one and try again.", fatal: true, action: "retry" };
    } else if (code === "network") {
      info = {
        code: "network",
        message: "Your browser's speech recognition needs an internet connection. Check it and try again.",
        fatal: true,
        action: "retry",
      };
    } else if (code === "language-not-supported") {
      info = {
        code: "language_unsupported",
        message: "Your browser can't recognise speech in this language. Pick another one in Settings.",
        fatal: true,
        action: "settings",
      };
    } else {
      info = { code: `speech_${code}`, message: "Speech recognition stopped unexpectedly.", fatal: false };
    }
    if (info.fatal) this.wantListening = false;
    this.ev.error(info);
  }

  private onResult(e: any) {
    if (this.stopped || this.muted || this.turn) return;
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) this.finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    this.interimText = interim;
    const text = `${this.finalText} ${interim}`.replace(/\s+/g, " ").trim();
    if (!text) return;

    if (!this.userEntryId) {
      this.userEntryId = uid();
      this.ev.status("hearing");
    }
    this.ev.upsert({ id: this.userEntryId, role: "user", text, final: false });

    if (this.endTimer) clearTimeout(this.endTimer);
    this.endTimer = setTimeout(() => this.finishUserTurn(), SILENCE_MS[this.settings.turnTaking]);
  }

  private finishUserTurn() {
    this.endTimer = null;
    const id = this.userEntryId;
    const text = `${this.finalText} ${this.interimText}`.replace(/\s+/g, " ").trim();
    this.finalText = this.interimText = "";
    this.userEntryId = null;
    if (!id) return;
    this.ev.upsert({ id, role: "user", text, final: true });
    if (!text) {
      this.ev.status("listening");
      return;
    }
    // Stop listening while the assistant talks so it doesn't hear itself.
    this.pauseListening();
    void this.respond();
  }

  // ---- Reply -----------------------------------------------------------------

  private async respond() {
    const turn: Turn = { id: uid(), ac: new AbortController(), spoken: "", pending: 0, streamDone: false };
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
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
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
          }
        }
      }
      for (const s of chunker.flush()) this.speak(s, turn);
      turn.streamDone = true;
      this.maybeFinishTurn(turn);
      // Some browsers occasionally drop the final "end" event; don't get stuck speaking.
      const watchdog = setInterval(() => {
        if (this.turn !== turn) return clearInterval(watchdog);
        const synth = window.speechSynthesis;
        if (!synth.speaking && !synth.pending) {
          clearInterval(watchdog);
          turn.pending = 0;
          this.maybeFinishTurn(turn);
        }
      }, 1000);
    } catch (err) {
      if (turn.ac.signal.aborted || this.stopped) return;
      window.speechSynthesis.cancel();
      this.endTurn(turn, true);
      this.ev.error(
        err instanceof EngineError
          ? err.info
          : { code: "network", message: "Network error. Check your connection.", fatal: false, action: "retry" },
      );
    }
  }

  private speak(sentence: string, turn: Turn) {
    const text = cleanForSpeech(sentence);
    if (!text || this.turn !== turn) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = this.voice?.lang ?? this.lang;
    if (this.voice) u.voice = this.voice;
    u.rate = this.settings.speechRate;
    turn.pending++;
    let started = false;
    const show = () => {
      turn.spoken = turn.spoken ? `${turn.spoken} ${text}` : text;
      this.ev.upsert({ id: turn.id, role: "assistant", text: turn.spoken, final: false });
    };
    u.onstart = () => {
      if (this.turn !== turn) return;
      started = true;
      show();
      if (!this.speakingSince) this.speakingSince = performance.now();
      this.ev.status("speaking");
    };
    u.onend = () => {
      if (this.turn !== turn) return;
      if (!started) show();
      turn.pending--;
      this.maybeFinishTurn(turn);
    };
    u.onerror = (e: SpeechSynthesisErrorEvent) => {
      if (this.turn !== turn) return;
      if (!started) {
        // The voice failed (no voices installed, blocked audio…): still show the words.
        show();
        if (e.error !== "interrupted" && e.error !== "canceled" && !turn.voiceFailed) {
          turn.voiceFailed = true;
          this.ev.error({
            code: "voice_unavailable",
            message: "Your browser couldn't play the voice, so replies are shown as text. Try Chrome or Edge, or pick another voice in Settings.",
            fatal: false,
            action: "settings",
          });
        }
      }
      turn.pending--;
      this.maybeFinishTurn(turn);
    };
    window.speechSynthesis.speak(u);
  }

  private maybeFinishTurn(turn: Turn) {
    if (this.turn !== turn || !turn.streamDone || turn.pending > 0) return;
    this.endTurn(turn, false);
  }

  private endTurn(turn: Turn, interrupted: boolean) {
    if (this.turn !== turn) return;
    this.turn = null;
    this.speakingSince = 0;
    if (turn.spoken) {
      this.ev.upsert({ id: turn.id, role: "assistant", text: turn.spoken, final: true, interrupted: interrupted || undefined });
    }
    if (this.stopped) return;
    this.ev.status("listening");
    this.resumeListening();
  }

  // ---- Controls --------------------------------------------------------------

  interrupt() {
    const turn = this.turn;
    if (!turn) return;
    turn.ac.abort();
    window.speechSynthesis.cancel();
    this.endTurn(turn, true);
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    this.mic?.getAudioTracks().forEach((t) => (t.enabled = !muted));
    if (muted) {
      if (this.endTimer) clearTimeout(this.endTimer);
      this.endTimer = null;
      if (this.userEntryId) this.ev.upsert({ id: this.userEntryId, role: "user", text: "", final: true });
      this.userEntryId = null;
      this.finalText = this.interimText = "";
      this.pauseListening();
    } else if (!this.turn) {
      this.resumeListening();
    }
  }

  levels(): Levels {
    const input = this.muted || this.turn ? 0 : (this.inMeter?.level() ?? 0);
    // speechSynthesis exposes no audio stream, so animate the orb with a speech-like rhythm.
    let output = 0;
    if (this.speakingSince) {
      const t = (performance.now() - this.speakingSince) / 1000;
      output = 0.32 + 0.18 * Math.sin(t * 9.1) * Math.sin(t * 2.3 + 0.7) + 0.08 * Math.sin(t * 17.3);
    }
    return { input, output: Math.max(0, output) };
  }

  stop() {
    this.stopped = true;
    this.turn?.ac.abort();
    this.turn = null;
    this.cleanup();
  }

  private cleanup() {
    this.wantListening = false;
    if (this.endTimer) clearTimeout(this.endTimer);
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.endTimer = this.restartTimer = null;
    if (this.rec) {
      this.rec.onresult = this.rec.onerror = this.rec.onend = null;
      try {
        this.rec.abort();
      } catch {
        /* noop */
      }
    }
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    this.inMeter?.disconnect();
    this.mic?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close().catch(() => {});
    this.rec = this.ctx = this.mic = this.inMeter = null;
    this.speakingSince = 0;
  }
}
