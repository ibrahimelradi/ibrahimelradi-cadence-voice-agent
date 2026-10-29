/**
 * Incrementally splits streamed LLM text into speakable chunks. The first
 * chunk is allowed to be short so speech can start as early as possible.
 */
export class SentenceChunker {
  private buf = "";
  private emitted = 0;

  push(text: string): string[] {
    this.buf += text;
    const out: string[] = [];
    while (true) {
      const cut = this.findCut();
      if (cut < 0) break;
      const piece = this.buf.slice(0, cut).trim();
      this.buf = this.buf.slice(cut);
      if (piece) {
        out.push(piece);
        this.emitted++;
      }
    }
    return out;
  }

  flush(): string[] {
    const rest = this.buf.trim();
    this.buf = "";
    return rest ? [rest] : [];
  }

  private findCut(): number {
    const minLen = this.emitted === 0 ? 12 : 40;
    // Sentence end: terminal punctuation followed by whitespace, or CJK punctuation.
    const re = /([.!?…]+["')\]]?\s+)|([。！？]+)|(\n+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(this.buf))) {
      const end = m.index + m[0].length;
      if (end >= minLen) return end;
    }
    // Very long run without a sentence end: break at a clause boundary.
    if (this.buf.length > 160) {
      const clause = this.buf.lastIndexOf(", ", 160);
      if (clause > 40) return clause + 2;
    }
    return -1;
  }
}

/** Remove markdown artifacts so they aren't read aloud. */
export function cleanForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*|__|\*|#{1,6}\s/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}
