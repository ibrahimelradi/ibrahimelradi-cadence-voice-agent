/**
 * Ordered, gapless playback of independently fetched audio clips (one per
 * sentence). Clips can be enqueued before their audio has arrived, so
 * synthesis of sentence N+1 overlaps playback of sentence N.
 */
export interface Clip {
  audio: Promise<ArrayBuffer>;
  onStart?: () => void;
}

export class ClipPlayer {
  private queue: Clip[] = [];
  private running = false;
  private current: AudioBufferSourceNode | null = null;
  private generation = 0;
  private idleResolvers: (() => void)[] = [];
  readonly output: GainNode;

  constructor(
    private ctx: AudioContext,
    private onError: (err: unknown) => void,
  ) {
    this.output = ctx.createGain();
    this.output.connect(ctx.destination);
  }

  get busy() {
    return this.running;
  }

  enqueue(clip: Clip) {
    this.queue.push(clip);
    if (!this.running) void this.run(this.generation);
  }

  /** Resolves once everything queued so far has played (or was stopped). */
  whenIdle(): Promise<void> {
    if (!this.running && !this.queue.length) return Promise.resolve();
    return new Promise((r) => this.idleResolvers.push(r));
  }

  stop() {
    this.generation++;
    this.queue = [];
    try {
      this.current?.stop();
    } catch {
      /* already stopped */
    }
    this.current = null;
    this.running = false;
    this.flushIdle();
  }

  private flushIdle() {
    const r = this.idleResolvers;
    this.idleResolvers = [];
    r.forEach((f) => f());
  }

  private async run(gen: number) {
    this.running = true;
    while (this.queue.length && gen === this.generation) {
      const clip = this.queue.shift()!;
      let buffer: AudioBuffer;
      try {
        const bytes = await clip.audio;
        if (gen !== this.generation) return;
        buffer = await this.ctx.decodeAudioData(bytes);
      } catch (err) {
        if (gen !== this.generation) return;
        this.onError(err);
        // Still surface the text even if audio failed.
        clip.onStart?.();
        continue;
      }
      if (gen !== this.generation) return;
      await new Promise<void>((resolve) => {
        const src = this.ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(this.output);
        src.onended = () => resolve();
        this.current = src;
        clip.onStart?.();
        src.start();
      });
      this.current = null;
    }
    if (gen === this.generation) {
      this.running = false;
      this.flushIdle();
    }
  }
}
