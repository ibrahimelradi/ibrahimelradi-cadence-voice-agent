import type { TurnTaking } from "@/lib/shared/config";

export interface VadOptions {
  /** Silence needed before a turn is considered finished. */
  silenceMs: number;
  /** Speech needed before we decide the user started talking. */
  onsetMs: number;
  /** Minimum voiced audio for an utterance to count (filters clicks / coughs). */
  minSpeechMs: number;
  maxUtteranceMs: number;
}

export const VAD_PRESETS: Record<TurnTaking, VadOptions> = {
  patient: { silenceMs: 1200, onsetMs: 140, minSpeechMs: 280, maxUtteranceMs: 30_000 },
  balanced: { silenceMs: 800, onsetMs: 120, minSpeechMs: 250, maxUtteranceMs: 30_000 },
  quick: { silenceMs: 520, onsetMs: 100, minSpeechMs: 220, maxUtteranceMs: 30_000 },
};

export type VadEvent = "start" | "end" | "discard" | null;

/**
 * Energy-based voice activity detector with an adaptive noise floor.
 * Robust enough for headsets and laptops when combined with the browser's
 * built-in noise suppression and echo cancellation.
 */
export class EnergyVad {
  private floor = 0.004;
  private speaking = false;
  private aboveMs = 0;
  private belowMs = 0;
  private voicedMs = 0;
  private totalMs = 0;
  /** Raise the bar while the assistant is talking so echo leakage doesn't trigger barge-in. */
  sensitivityBoost = 1;
  /** Require longer sustained speech to count (used for barge-in). */
  onsetScale = 1;

  constructor(public opts: VadOptions) {}

  get isSpeaking() {
    return this.speaking;
  }

  reset() {
    this.speaking = false;
    this.aboveMs = this.belowMs = this.voicedMs = this.totalMs = 0;
  }

  /** Feed one frame of RMS energy covering `ms` milliseconds. */
  push(rms: number, ms: number): VadEvent {
    const start = Math.max(0.012, this.floor * 3.2) * this.sensitivityBoost;
    const keep = Math.max(0.007, this.floor * 2);

    if (!this.speaking) {
      if (rms <= start) {
        // Track the ambient noise floor from non-speech frames only:
        // fall quickly, rise slowly.
        const k = rms < this.floor ? 0.2 : 0.015;
        this.floor = Math.min(0.03, this.floor + (rms - this.floor) * k);
      }

      if (rms > start) {
        this.aboveMs += ms;
        if (this.aboveMs >= this.opts.onsetMs * this.onsetScale) {
          this.speaking = true;
          this.voicedMs = this.aboveMs;
          this.totalMs = this.aboveMs;
          this.belowMs = 0;
          return "start";
        }
      } else {
        this.aboveMs = Math.max(0, this.aboveMs - ms * 0.5);
      }
      return null;
    }

    this.totalMs += ms;
    if (rms > keep) {
      this.voicedMs += ms;
      this.belowMs = 0;
    } else {
      this.belowMs += ms;
    }

    if (this.belowMs >= this.opts.silenceMs || this.totalMs >= this.opts.maxUtteranceMs) {
      const enough = this.voicedMs >= this.opts.minSpeechMs;
      this.speaking = false;
      this.aboveMs = this.belowMs = 0;
      return enough ? "end" : "discard";
    }
    return null;
  }
}

export function rmsOf(frame: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i]! * frame[i]!;
  return Math.sqrt(sum / frame.length);
}
