import type { ChatTurn } from "@/lib/shared/config";

export type AgentStatus =
  | "idle"
  | "connecting"
  | "listening" // session live, waiting for the user
  | "hearing" // user is speaking
  | "thinking" // waiting on transcription / model
  | "speaking" // assistant audio is playing
  | "error";

export interface TranscriptEntry {
  id: string;
  role: "user" | "assistant";
  text: string;
  final: boolean;
  interrupted?: boolean;
  at: number;
}

export type EntryPatch = Pick<TranscriptEntry, "id" | "role"> &
  Partial<Omit<TranscriptEntry, "id" | "role" | "at">>;

export type ErrorAction = "retry" | "settings" | "permissions";

export interface AgentError {
  code: string;
  message: string;
  /** Fatal errors end the session; non-fatal ones are shown as a notice. */
  fatal: boolean;
  action?: ErrorAction;
}

export interface EngineEvents {
  status(s: AgentStatus): void;
  upsert(patch: EntryPatch): void;
  error(e: AgentError): void;
  /** Completed conversation so far (final, non-empty turns). */
  history(): ChatTurn[];
}

export interface Levels {
  input: number; // 0..1
  output: number; // 0..1
}

export interface VoiceEngine {
  start(): Promise<void>;
  stop(): void;
  setMuted(muted: boolean): void;
  /** Stop the assistant mid-sentence. */
  interrupt(): void;
  levels(): Levels;
}

export class EngineError extends Error {
  constructor(public info: AgentError) {
    super(info.message);
  }
}
