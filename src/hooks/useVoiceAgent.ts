"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_SETTINGS,
  LLM_PROVIDERS,
  type AgentSettings,
  type ChatTurn,
  type ServerCapabilities,
} from "@/lib/shared/config";
import { BrowserEngine } from "@/lib/client/browser-engine";
import { PipelineEngine } from "@/lib/client/pipeline-engine";
import { RealtimeEngine } from "@/lib/client/realtime-engine";
import {
  EngineError,
  type AgentError,
  type AgentStatus,
  type EngineEvents,
  type EntryPatch,
  type Levels,
  type TranscriptEntry,
  type VoiceEngine,
} from "@/lib/client/types";

const SETTINGS_KEY = "voice-agent:settings:v1";

function loadSettings(): AgentSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<AgentSettings>) };
  } catch {
    /* storage unavailable */
  }
  return DEFAULT_SETTINGS;
}

const llmEnvVar = (p: AgentSettings["llmProvider"]) => LLM_PROVIDERS.find((x) => x.id === p)!.envVar;

/** Why a configuration can't run, or null if it can. */
export function engineBlocker(s: AgentSettings, caps: ServerCapabilities | null): string | null {
  if (!caps) return null;
  if (s.engine === "realtime") {
    return caps.realtime ? null : "Realtime mode needs OPENAI_API_KEY on the server.";
  }
  if (s.engine === "browser") {
    if (caps.llm[s.llmProvider]) return null;
    return LLM_PROVIDERS.some((p) => caps.llm[p.id])
      ? `Choose an AI model that's configured, or add ${llmEnvVar(s.llmProvider)} on the server.`
      : "Free mode needs a free GEMINI_API_KEY (or GROQ_API_KEY) on the server.";
  }
  const missing: string[] = [];
  if (!caps.llm[s.llmProvider]) missing.push(llmEnvVar(s.llmProvider));
  if (!caps.stt[s.sttProvider]) missing.push(s.sttProvider === "openai" ? "OPENAI_API_KEY" : "ELEVENLABS_API_KEY");
  if (!caps.tts[s.ttsProvider]) missing.push(s.ttsProvider === "openai" ? "OPENAI_API_KEY" : "ELEVENLABS_API_KEY");
  const uniq = [...new Set(missing)];
  return uniq.length ? `Modular mode with these providers needs ${uniq.join(" and ")} on the server.` : null;
}

/** Choose a runnable configuration based on what the server has configured. */
function reconcile(s: AgentSettings, caps: ServerCapabilities): AgentSettings {
  const next = { ...s };
  if (!caps.llm[next.llmProvider]) {
    next.llmProvider = (["anthropic", "openai", "gemini", "groq"] as const).find((p) => caps.llm[p]) ?? next.llmProvider;
  }
  if (!caps.stt[next.sttProvider]) next.sttProvider = caps.stt.openai ? "openai" : "elevenlabs";
  if (!caps.tts[next.ttsProvider]) next.ttsProvider = caps.tts.openai ? "openai" : "elevenlabs";
  if (engineBlocker(next, caps)) {
    // Fall back to whichever engine the server can actually run.
    const runnable = (["realtime", "pipeline", "browser"] as const).find((e) => !engineBlocker({ ...next, engine: e }, caps));
    if (runnable) next.engine = runnable;
  }
  return next;
}

export function useVoiceAgent() {
  const [status, setStatus] = useState<AgentStatus>("idle");
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [error, setError] = useState<AgentError | null>(null);
  const [notice, setNotice] = useState<AgentError | null>(null);
  const [muted, setMutedState] = useState(false);
  const [settings, setSettingsState] = useState<AgentSettings>(DEFAULT_SETTINGS);
  const [caps, setCaps] = useState<ServerCapabilities | null>(null);
  const [capsError, setCapsError] = useState(false);
  const [settingsDirty, setSettingsDirty] = useState(false);

  const engineRef = useRef<VoiceEngine | null>(null);
  const entriesRef = useRef<TranscriptEntry[]>([]);
  const settingsRef = useRef(settings);
  const statusRef = useRef<AgentStatus>("idle");
  const reconnects = useRef<number[]>([]);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const active = status !== "idle" && status !== "error";

  // ---- Settings & capabilities ---------------------------------------------
  useEffect(() => {
    const local = loadSettings();
    settingsRef.current = local;

    let cancelled = false;
    fetch("/api/config")
      .then((r) => (r.ok ? (r.json() as Promise<ServerCapabilities>) : Promise.reject()))
      .then((c) => {
        if (cancelled) return;
        setCaps(c);
        const fixed = reconcile(settingsRef.current, c);
        settingsRef.current = fixed;
        setSettingsState(fixed);
      })
      .catch(() => {
        if (cancelled) return;
        setCapsError(true);
        setSettingsState(settingsRef.current);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const updateSettings = useCallback((patch: Partial<AgentSettings>) => {
    const next = { ...settingsRef.current, ...patch };
    settingsRef.current = next;
    setSettingsState(next);
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
    if (statusRef.current !== "idle" && statusRef.current !== "error") setSettingsDirty(true);
  }, []);

  // ---- Transcript store -----------------------------------------------------
  const upsert = useCallback((p: EntryPatch) => {
    const list = entriesRef.current;
    const i = list.findIndex((e) => e.id === p.id);
    let next: TranscriptEntry[];
    if (i === -1) {
      if (p.final && !p.text?.trim()) return;
      next = [...list, { text: "", final: false, at: Date.now(), ...p }];
    } else {
      const merged = { ...list[i]!, ...p };
      // Drop user turns that turned out to be silence / noise.
      if (merged.final && !merged.text.trim()) next = list.filter((_, j) => j !== i);
      else next = list.map((e, j) => (j === i ? merged : e));
    }
    entriesRef.current = next;
    setEntries(next);
  }, []);

  const history = useCallback((): ChatTurn[] => {
    return entriesRef.current
      .filter((e) => e.final && e.text.trim() && e.text !== "…")
      .map((e) => ({ role: e.role, text: e.text.trim() }));
  }, []);

  const showNotice = useCallback((e: AgentError) => {
    setNotice(e);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 7000);
  }, []);

  // ---- Lifecycle -------------------------------------------------------------
  const setStatusBoth = useCallback((s: AgentStatus) => {
    statusRef.current = s;
    setStatus(s);
  }, []);

  const teardown = useCallback(() => {
    engineRef.current?.stop();
    engineRef.current = null;
  }, []);

  const startRef = useRef<() => Promise<void>>(async () => {});

  const handleFatal = useCallback(
    (e: AgentError) => {
      teardown();
      // Auto-reconnect a dropped connection (at most twice per minute).
      if (e.code === "connection_lost") {
        const now = Date.now();
        reconnects.current = reconnects.current.filter((t) => now - t < 60_000);
        if (reconnects.current.length < 2) {
          reconnects.current.push(now);
          showNotice({ code: "reconnecting", message: "Connection dropped — reconnecting…", fatal: false });
          void startRef.current();
          return;
        }
      }
      setError(e);
      setStatusBoth("error");
    },
    [setStatusBoth, showNotice, teardown],
  );

  const start = useCallback(async () => {
    if (engineRef.current) return;
    const s = settingsRef.current;
    const blocker = engineBlocker(s, caps);
    if (blocker) {
      setError({ code: "provider_not_configured", message: blocker, fatal: true, action: "settings" });
      setStatusBoth("error");
      return;
    }
    setError(null);
    setSettingsDirty(false);

    const events: EngineEvents = {
      status: (st) => engineRef.current === engine && setStatusBoth(st),
      upsert: (p) => engineRef.current === engine && upsert(p),
      error: (e) => {
        if (engineRef.current !== engine) return;
        if (e.fatal) handleFatal(e);
        else showNotice(e);
      },
      history,
    };
    const engine: VoiceEngine =
      s.engine === "realtime"
        ? new RealtimeEngine(s, events)
        : s.engine === "browser"
          ? new BrowserEngine(s, events)
          : new PipelineEngine(s, events);
    engineRef.current = engine;
    setMutedState(false);

    try {
      await engine.start();
    } catch (err) {
      if (engineRef.current !== engine) return;
      const info: AgentError =
        err instanceof EngineError
          ? err.info
          : { code: "start_failed", message: "Couldn't start the voice session.", fatal: true, action: "retry" };
      console.error("[agent] start failed", err);
      teardown();
      setError({ ...info, fatal: true });
      setStatusBoth("error");
    }
  }, [caps, handleFatal, history, setStatusBoth, showNotice, teardown, upsert]);

  useEffect(() => {
    startRef.current = start;
  }, [start]);

  const stop = useCallback(() => {
    teardown();
    setMutedState(false);
    setSettingsDirty(false);
    setStatusBoth("idle");
  }, [setStatusBoth, teardown]);

  const restart = useCallback(async () => {
    teardown();
    setStatusBoth("idle");
    await start();
  }, [setStatusBoth, start, teardown]);

  const toggleMute = useCallback(() => {
    setMutedState((m) => {
      const next = !m;
      engineRef.current?.setMuted(next);
      return next;
    });
  }, []);

  const interrupt = useCallback(() => engineRef.current?.interrupt(), []);

  const clearTranscript = useCallback(() => {
    entriesRef.current = [];
    setEntries([]);
  }, []);

  const dismissError = useCallback(() => {
    setError(null);
    if (statusRef.current === "error") setStatusBoth("idle");
  }, [setStatusBoth]);

  const getLevels = useCallback((): Levels => engineRef.current?.levels() ?? { input: 0, output: 0 }, []);

  useEffect(() => () => engineRef.current?.stop(), []);

  return {
    status,
    active,
    entries,
    error,
    notice,
    muted,
    settings,
    settingsDirty,
    caps,
    capsError,
    start,
    stop,
    restart,
    toggleMute,
    interrupt,
    clearTranscript,
    dismissError,
    dismissNotice: () => setNotice(null),
    updateSettings,
    getLevels,
  };
}

export type VoiceAgent = ReturnType<typeof useVoiceAgent>;
