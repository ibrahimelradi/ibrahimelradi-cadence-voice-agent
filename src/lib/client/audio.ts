import { EngineError } from "./types";

/** Ask for the microphone and translate browser errors into helpful messages. */
export async function getMicrophone(): Promise<MediaStream> {
  if (typeof window !== "undefined" && !window.isSecureContext) {
    throw new EngineError({
      code: "insecure_context",
      message: "Microphone access needs a secure connection. Open the app over HTTPS or on localhost.",
      fatal: true,
    });
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new EngineError({
      code: "unsupported",
      message: "This browser doesn't support microphone capture. Try a recent Chrome, Edge, Safari or Firefox.",
      fatal: true,
    });
  }
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
  } catch (err) {
    const name = (err as DOMException)?.name;
    if (name === "NotAllowedError" || name === "SecurityError") {
      throw new EngineError({
        code: "mic_denied",
        message: "Microphone access was blocked. Allow it in your browser's site settings, then try again.",
        fatal: true,
        action: "permissions",
      });
    }
    if (name === "NotFoundError" || name === "OverconstrainedError") {
      throw new EngineError({
        code: "mic_missing",
        message: "No microphone was found. Connect one and try again.",
        fatal: true,
        action: "retry",
      });
    }
    if (name === "NotReadableError" || name === "AbortError") {
      throw new EngineError({
        code: "mic_busy",
        message: "Your microphone is being used by another app. Close it and try again.",
        fatal: true,
        action: "retry",
      });
    }
    throw new EngineError({
      code: "mic_error",
      message: "Couldn't start the microphone.",
      fatal: true,
      action: "retry",
    });
  }
}

export function createAudioContext(): AudioContext {
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctor({ latencyHint: "interactive" });
  void ctx.resume().catch(() => {});
  return ctx;
}

/** Smoothed RMS level meter (0..1) over an AnalyserNode. */
export class LevelMeter {
  private analyser: AnalyserNode;
  private data: Float32Array<ArrayBuffer>;
  private smoothed = 0;

  constructor(ctx: AudioContext, source: AudioNode) {
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0.2;
    this.data = new Float32Array(this.analyser.fftSize);
    source.connect(this.analyser);
  }

  get node(): AnalyserNode {
    return this.analyser;
  }

  level(): number {
    this.analyser.getFloatTimeDomainData(this.data);
    let sum = 0;
    for (let i = 0; i < this.data.length; i++) sum += this.data[i]! * this.data[i]!;
    const rms = Math.sqrt(sum / this.data.length);
    // Perceptual-ish mapping: -60 dBFS → 0, -10 dBFS → 1.
    const db = 20 * Math.log10(rms + 1e-8);
    const v = Math.min(1, Math.max(0, (db + 60) / 50));
    const k = v > this.smoothed ? 0.5 : 0.15;
    this.smoothed += (v - this.smoothed) * k;
    return this.smoothed;
  }

  disconnect() {
    try {
      this.analyser.disconnect();
    } catch {
      /* noop */
    }
  }
}

/** Downsample mono Float32 PCM and encode it as a 16-bit WAV blob. */
export function encodeWav(chunks: Float32Array[], inputRate: number, targetRate = 16000): Blob {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const ratio = inputRate / targetRate;
  const outLen = Math.floor(total / ratio);
  const pcm = new Int16Array(outLen);

  // Flatten lazily while averaging each output sample's source window.
  let chunkIdx = 0;
  let chunkPos = 0;
  let consumed = 0;
  for (let i = 0; i < outLen; i++) {
    const end = Math.floor((i + 1) * ratio);
    let acc = 0;
    let n = 0;
    while (consumed < end && chunkIdx < chunks.length) {
      acc += chunks[chunkIdx]![chunkPos]!;
      n++;
      consumed++;
      chunkPos++;
      if (chunkPos >= chunks[chunkIdx]!.length) {
        chunkIdx++;
        chunkPos = 0;
      }
    }
    const s = Math.max(-1, Math.min(1, n ? acc / n : 0));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }

  const buffer = new ArrayBuffer(44 + pcm.byteLength);
  const v = new DataView(buffer);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  v.setUint32(4, 36 + pcm.byteLength, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, targetRate, true);
  v.setUint32(28, targetRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, pcm.byteLength, true);
  new Int16Array(buffer, 44).set(pcm);
  return new Blob([buffer], { type: "audio/wav" });
}

export async function readApiError(res: Response, fallback: string) {
  try {
    const j = (await res.json()) as { error?: { code?: string; message?: string } };
    return { code: j.error?.code ?? `http_${res.status}`, message: j.error?.message ?? fallback };
  } catch {
    return { code: `http_${res.status}`, message: fallback };
  }
}
