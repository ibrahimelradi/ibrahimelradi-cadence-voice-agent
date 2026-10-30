"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useVoiceAgent } from "@/hooks/useVoiceAgent";
import type { AgentStatus } from "@/lib/client/types";
import { Controls } from "./Controls";
import { AlertIcon, CloseIcon, SlidersIcon, TranscriptIcon } from "./icons";
import { Orb } from "./Orb";
import { Settings, type Theme } from "./Settings";
import { IconButton, Transcript } from "./Transcript";

const THEME_KEY = "voice-agent:theme";

const STATUS_COPY: Record<AgentStatus, { title: string; hint: string }> = {
  idle: { title: "Ready when you are", hint: "Start a conversation. Your microphone is only on during a session." },
  connecting: { title: "Connecting", hint: "Setting up a secure voice session…" },
  listening: { title: "Listening", hint: "Go ahead — speak naturally." },
  hearing: { title: "Listening", hint: "Pause when you're done." },
  thinking: { title: "Thinking", hint: "" },
  speaking: { title: "Speaking", hint: "Start talking any time to interrupt." },
  error: { title: "Something went wrong", hint: "" },
};

const themeListeners = new Set<() => void>();
const themeStore = {
  get(): Theme {
    try {
      const t = JSON.parse(localStorage.getItem(THEME_KEY) ?? '"dark"');
      return t === "light" || t === "system" ? t : "dark";
    } catch {
      return "dark";
    }
  },
  set(t: Theme) {
    try {
      localStorage.setItem(THEME_KEY, JSON.stringify(t));
    } catch {
      /* ignore */
    }
    themeListeners.forEach((l) => l());
  },
  subscribe(l: () => void) {
    themeListeners.add(l);
    return () => themeListeners.delete(l);
  },
};

function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia(query);
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

function applyTheme(t: Theme) {
  const resolved =
    t === "system" ? (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark") : t;
  document.documentElement.dataset.theme = resolved;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", resolved === "light" ? "#f7f7f5" : "#0a0a0b");
}

export function VoiceApp() {
  const agent = useVoiceAgent();
  const { status, active, muted, entries, error, notice } = agent;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const isWide = useMediaQuery("(min-width: 1024px)");
  // null = follow the default (open on wide screens, closed on small ones)
  const [transcriptPref, setTranscriptPref] = useState<boolean | null>(null);
  const transcriptOpen = transcriptPref ?? isWide;
  const setTranscriptOpen = (v: boolean | ((p: boolean) => boolean)) =>
    setTranscriptPref(typeof v === "function" ? v(transcriptOpen) : v);
  const theme = useSyncExternalStore(themeStore.subscribe, themeStore.get, () => "dark" as Theme);

  useEffect(() => {
    applyTheme(theme);
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const on = () => applyTheme("system");
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [theme]);

  const changeTheme = useCallback((t: Theme) => themeStore.set(t), []);

  const primary = useCallback(() => {
    if (active) agent.stop();
    else void agent.start();
  }, [active, agent]);

  // Keyboard: Space start/end, M mute, Esc interrupt.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (settingsOpen || el.closest("input, textarea, select, [contenteditable]")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === "Space" && !el.closest("button")) {
        e.preventDefault();
        primary();
      } else if (e.key === "m" || e.key === "M") {
        if (active) agent.toggleMute();
      } else if (e.key === "Escape") {
        agent.interrupt();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, agent, primary, settingsOpen]);

  const copy = STATUS_COPY[status];
  const title = muted && active ? "Muted" : copy.title;
  const hint =
    muted && active
      ? "Unmute to keep talking."
      : status === "speaking" && agent.settings.engine === "browser"
        ? "Tap the orb or press Interrupt to cut in."
        : copy.hint;
  const latest = [...entries].reverse().find((e) => e.text.trim());
  const showCaption = active && !(isWide && transcriptOpen) && latest;

  const orbLabel = !active
    ? "Start conversation"
    : status === "speaking"
      ? "Interrupt the assistant"
      : "Voice activity";
  const onOrb = () => {
    if (!active && status !== "connecting") void agent.start();
    else if (status === "speaking") agent.interrupt();
  };

  const engineLabel = { realtime: "Realtime", pipeline: "Modular", browser: "Free" }[agent.settings.engine];

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-bg text-fg">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Header */}
        <header className="flex h-14 shrink-0 items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-2.5">
            <span className="h-2.5 w-2.5 rounded-full bg-fg" aria-hidden />
            <span className="text-[14px] font-semibold tracking-[-0.01em]">Cadence</span>
          </div>

          <div className="flex items-center gap-1.5">
            <ConnectionPill status={status} engine={engineLabel} />
            <span className="mx-1 h-5 w-px bg-line" aria-hidden />
            <IconButton
              label={transcriptOpen ? "Hide transcript" : "Show transcript"}
              onClick={() => setTranscriptOpen((v) => !v)}
              active={transcriptOpen}
            >
              <TranscriptIcon width={18} height={18} />
            </IconButton>
            <IconButton label="Settings" onClick={() => setSettingsOpen(true)}>
              <SlidersIcon width={18} height={18} />
            </IconButton>
          </div>
        </header>

        {/* Stage */}
        <main className="relative flex min-h-0 flex-1 flex-col items-center justify-center px-6">
          <div className="flex w-full flex-1 items-center justify-center min-h-0">
            <Orb status={status} getLevels={agent.getLevels} muted={muted} onClick={onOrb} label={orbLabel} />
          </div>

          <div className="mb-6 flex min-h-[112px] w-full max-w-xl flex-col items-center text-center">
            {status === "error" && error ? (
              <ErrorPanel
                message={error.message}
                action={error.action}
                onRetry={() => void agent.start()}
                onSettings={() => setSettingsOpen(true)}
                onDismiss={agent.dismissError}
              />
            ) : (
              <>
                <h1 key={title} className="animate-fade-up text-[22px] font-medium tracking-[-0.02em] sm:text-[26px]">
                  {title}
                  {status === "thinking" && <ThinkingDots />}
                </h1>
                {showCaption ? (
                  <p
                    className={[
                      "mt-3 line-clamp-2 max-w-lg text-[15px] leading-relaxed",
                      latest.role === "user" ? "text-fg-subtle" : "text-fg-muted",
                    ].join(" ")}
                  >
                    {latest.text.length > 180 ? "…" + latest.text.slice(-180) : latest.text}
                  </p>
                ) : (
                  hint && <p className="mt-3 max-w-sm text-[14px] leading-relaxed text-fg-subtle">{hint}</p>
                )}
                {agent.settingsDirty && active && (
                  <button
                    type="button"
                    onClick={() => void agent.restart()}
                    className="mt-3 text-[12.5px] text-fg-muted underline decoration-line-strong underline-offset-4 hover:text-fg"
                  >
                    Settings changed — restart to apply
                  </button>
                )}
              </>
            )}
          </div>
        </main>

        {/* Notices */}
        <div className="pointer-events-none relative h-0">
          {notice && (
            <div className="absolute inset-x-0 bottom-3 flex justify-center px-4">
              <div
                role="status"
                className="animate-fade-up pointer-events-auto flex max-w-md items-start gap-2.5 rounded-xl border border-line bg-elevated px-3.5 py-2.5 text-[13px] text-fg-muted shadow-[0_12px_40px_-12px_rgba(0,0,0,0.5)]"
              >
                <AlertIcon width={16} height={16} className="mt-px shrink-0 text-warn" />
                <span className="leading-snug">{notice.message}</span>
                <button
                  type="button"
                  onClick={agent.dismissNotice}
                  aria-label="Dismiss"
                  className="-mr-1 shrink-0 text-fg-subtle hover:text-fg"
                >
                  <CloseIcon width={14} height={14} />
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Controls */}
        <footer className="shrink-0 px-4 pt-3 pb-[max(env(safe-area-inset-bottom),28px)]">
          <Controls
            status={status}
            active={active}
            muted={muted}
            onPrimary={primary}
            onMute={agent.toggleMute}
            onInterrupt={agent.interrupt}
            onRestart={() => void agent.restart()}
          />
        </footer>
      </div>

      {/* Transcript: side panel on wide screens, sheet on small screens */}
      {isWide ? (
        <aside
          className={[
            "shrink-0 overflow-hidden border-l border-line bg-surface transition-[width] duration-[420ms] ease-out-soft",
            transcriptOpen ? "w-[380px]" : "w-0 border-l-0",
          ].join(" ")}
          inert={!transcriptOpen}
        >
          <div className="h-full w-[380px]">
            <Transcript entries={entries} onClear={agent.clearTranscript} />
          </div>
        </aside>
      ) : (
        <>
          <div
            aria-hidden
            onClick={() => setTranscriptOpen(false)}
            className={[
              "fixed inset-0 z-30 bg-[var(--scrim)] transition-opacity duration-300",
              transcriptOpen ? "opacity-100" : "pointer-events-none opacity-0",
            ].join(" ")}
          />
          <aside
            inert={!transcriptOpen}
            className={[
              "fixed inset-x-0 bottom-0 z-40 h-[78dvh] rounded-t-2xl border-t border-line bg-surface",
              "transition-transform duration-[420ms] ease-out-soft",
              transcriptOpen ? "translate-y-0" : "translate-y-full",
            ].join(" ")}
          >
            <Transcript entries={entries} onClear={agent.clearTranscript} onClose={() => setTranscriptOpen(false)} />
          </aside>
        </>
      )}

      <Settings
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={agent.settings}
        caps={agent.caps}
        capsError={agent.capsError}
        update={agent.updateSettings}
        dirty={agent.settingsDirty}
        active={active}
        onApply={() => {
          setSettingsOpen(false);
          void agent.restart();
        }}
        theme={theme}
        onTheme={changeTheme}
      />
    </div>
  );
}

function ConnectionPill({ status, engine }: { status: AgentStatus; engine: string }) {
  const map: Record<string, { label: string; dot: string; pulse?: boolean }> = {
    idle: { label: "Ready", dot: "bg-fg-subtle" },
    connecting: { label: "Connecting", dot: "bg-warn", pulse: true },
    error: { label: "Offline", dot: "bg-danger" },
  };
  const m = map[status] ?? { label: `Live · ${engine}`, dot: "bg-ok" };
  return (
    <span
      className="flex h-7 items-center gap-2 rounded-full border border-line px-2.5 text-[12px] text-fg-muted"
      role="status"
      aria-label={`Connection: ${m.label}`}
    >
      <span className="relative flex h-1.5 w-1.5">
        {m.pulse && <span className={`absolute inset-0 animate-ping rounded-full ${m.dot} opacity-60`} />}
        <span className={`relative h-1.5 w-1.5 rounded-full ${m.dot}`} />
      </span>
      <span className="hidden sm:inline">{m.label}</span>
    </span>
  );
}

function ThinkingDots() {
  return (
    <span className="ml-1 inline-flex gap-[3px] align-middle" aria-hidden>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1 w-1 animate-pulse rounded-full bg-fg-muted"
          style={{ animationDelay: `${i * 160}ms` }}
        />
      ))}
    </span>
  );
}

function ErrorPanel({
  message,
  action,
  onRetry,
  onSettings,
  onDismiss,
}: {
  message: string;
  action?: "retry" | "settings" | "permissions";
  onRetry: () => void;
  onSettings: () => void;
  onDismiss: () => void;
}) {
  return (
    <div role="alert" className="animate-fade-up flex flex-col items-center">
      <div className="flex items-center gap-2 text-[15px] font-medium text-danger">
        <AlertIcon width={18} height={18} />
        <span>Couldn&apos;t continue</span>
      </div>
      <p className="mt-2 max-w-md text-[14px] leading-relaxed text-fg-muted">{message}</p>
      <div className="mt-4 flex gap-2">
        {action === "settings" ? (
          <button type="button" onClick={onSettings} className="h-9 rounded-lg bg-inverse-bg px-4 text-[13px] font-medium text-inverse-fg hover:opacity-90">
            Open settings
          </button>
        ) : (
          <button type="button" onClick={onRetry} className="h-9 rounded-lg bg-inverse-bg px-4 text-[13px] font-medium text-inverse-fg hover:opacity-90">
            Try again
          </button>
        )}
        <button type="button" onClick={onDismiss} className="h-9 rounded-lg border border-line px-4 text-[13px] text-fg-muted hover:bg-hover hover:text-fg">
          Dismiss
        </button>
      </div>
    </div>
  );
}
