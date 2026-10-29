"use client";

import { useEffect, useState } from "react";
import {
  LANGUAGES,
  LIMITS,
  OPENAI_TTS_VOICES,
  REALTIME_VOICES,
  STYLES,
  TURN_TAKING,
  type AgentSettings,
  type ServerCapabilities,
} from "@/lib/shared/config";
import { engineBlocker } from "@/hooks/useVoiceAgent";
import { CheckIcon, CloseIcon } from "./icons";

export type Theme = "dark" | "light" | "system";

interface Props {
  open: boolean;
  onClose: () => void;
  settings: AgentSettings;
  caps: ServerCapabilities | null;
  capsError: boolean;
  update: (p: Partial<AgentSettings>) => void;
  dirty: boolean;
  active: boolean;
  onApply: () => void;
  theme: Theme;
  onTheme: (t: Theme) => void;
}

interface ElevenVoice {
  id: string;
  name: string;
  description: string;
}

export function Settings(props: Props) {
  const { open, onClose, settings: s, caps, update } = props;
  const [elevenVoices, setElevenVoices] = useState<ElevenVoice[] | null>(null);
  const [elevenError, setElevenError] = useState<string | null>(null);

  const needsEleven = s.engine === "pipeline" && s.ttsProvider === "elevenlabs" && !!caps?.tts.elevenlabs;
  useEffect(() => {
    if (!open || !needsEleven || elevenVoices) return;
    let cancelled = false;
    fetch("/api/voices")
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j?.error?.message ?? "Couldn't load voices.");
        return j as { voices: ElevenVoice[] };
      })
      .then((j) => !cancelled && setElevenVoices(j.voices))
      .catch((e: Error) => !cancelled && setElevenError(e.message));
    return () => {
      cancelled = true;
    };
  }, [open, needsEleven, elevenVoices]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const blocker = engineBlocker(s, caps);

  return (
    <>
      <div
        onClick={onClose}
        aria-hidden
        className={[
          "fixed inset-0 z-40 bg-[var(--scrim)] backdrop-blur-[2px] transition-opacity duration-300",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        ].join(" ")}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        aria-hidden={!open}
        inert={!open}
        className={[
          "fixed inset-y-0 right-0 z-50 flex w-full max-w-[440px] flex-col border-l border-line bg-surface",
          "transition-transform duration-[420ms] ease-out-soft",
          open ? "translate-x-0" : "translate-x-full",
        ].join(" ")}
      >
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-line px-6">
          <h2 className="text-[14px] font-medium">Settings</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            className="grid h-9 w-9 place-items-center rounded-lg text-fg-muted hover:bg-hover hover:text-fg"
          >
            <CloseIcon width={18} height={18} />
          </button>
        </header>

        <div className="scroll-quiet flex-1 overflow-y-auto px-6 pb-10">
          {props.capsError && (
            <p className="mt-6 rounded-lg bg-danger-bg px-3 py-2.5 text-[13px] text-danger">
              Couldn&apos;t reach the server to check which providers are configured.
            </p>
          )}

          <Section title="Engine">
            <div className="grid gap-2">
              <EngineCard
                selected={s.engine === "realtime"}
                onSelect={() => update({ engine: "realtime" })}
                title="Realtime"
                badge={caps && !caps.realtime ? "Needs OpenAI key" : "Lowest latency"}
                unavailable={!!caps && !caps.realtime}
                body={`Speech-to-speech over WebRTC with ${caps?.models.realtime ?? "OpenAI Realtime"}. Most natural turn-taking and interruptions.`}
              />
              <EngineCard
                selected={s.engine === "pipeline"}
                onSelect={() => update({ engine: "pipeline" })}
                title="Modular"
                badge="Choose providers"
                unavailable={!!caps && !!engineBlocker({ ...s, engine: "pipeline" }, caps)}
                body="Pick the brain and the voice separately — Claude or OpenAI for reasoning, OpenAI or ElevenLabs for speech."
              />
            </div>
            {blocker && <p className="mt-3 text-[12.5px] leading-relaxed text-warn">{blocker}</p>}
          </Section>

          {s.engine === "pipeline" && (
            <Section title="Providers">
              <Field label="Reasoning">
                <Segmented
                  value={s.llmProvider}
                  onChange={(v) => update({ llmProvider: v })}
                  options={[
                    { value: "anthropic", label: "Claude", disabled: caps ? !caps.llm.anthropic : false, hint: caps?.models.anthropic },
                    { value: "openai", label: "OpenAI", disabled: caps ? !caps.llm.openai : false, hint: caps?.models.openai },
                  ]}
                />
              </Field>
              <Field label="Speech recognition">
                <Segmented
                  value={s.sttProvider}
                  onChange={(v) => update({ sttProvider: v })}
                  options={[
                    { value: "openai", label: "OpenAI", disabled: caps ? !caps.stt.openai : false },
                    { value: "elevenlabs", label: "ElevenLabs", disabled: caps ? !caps.stt.elevenlabs : false },
                  ]}
                />
              </Field>
              <Field label="Voice">
                <Segmented
                  value={s.ttsProvider}
                  onChange={(v) => update({ ttsProvider: v })}
                  options={[
                    { value: "openai", label: "OpenAI", disabled: caps ? !caps.tts.openai : false },
                    { value: "elevenlabs", label: "ElevenLabs", disabled: caps ? !caps.tts.elevenlabs : false },
                  ]}
                />
              </Field>
            </Section>
          )}

          <Section title="Voice">
            {s.engine === "realtime" ? (
              <VoiceChips voices={REALTIME_VOICES} value={s.realtimeVoice} onChange={(v) => update({ realtimeVoice: v })} />
            ) : s.ttsProvider === "openai" ? (
              <VoiceChips voices={OPENAI_TTS_VOICES} value={s.openaiTtsVoice} onChange={(v) => update({ openaiTtsVoice: v })} />
            ) : (
              <div>
                <select
                  value={s.elevenlabsVoiceId}
                  onChange={(e) => update({ elevenlabsVoiceId: e.target.value })}
                  className="h-10 w-full rounded-lg border border-line bg-elevated px-3 text-[14px] text-fg outline-none focus:border-line-strong"
                >
                  <option value="">Default voice</option>
                  {elevenVoices?.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                      {v.description ? ` — ${v.description}` : ""}
                    </option>
                  ))}
                </select>
                {elevenError && <p className="mt-2 text-[12px] text-danger">{elevenError}</p>}
                {!elevenVoices && !elevenError && needsEleven && (
                  <p className="mt-2 text-[12px] text-fg-subtle">Loading your ElevenLabs voices…</p>
                )}
              </div>
            )}
            <Field label="Speaking rate" aside={`${s.speechRate.toFixed(2)}×`}>
              <input
                type="range"
                min={0.8}
                max={1.2}
                step={0.05}
                value={s.speechRate}
                onChange={(e) => update({ speechRate: Number(e.target.value) })}
                className="w-full accent-[var(--fg)]"
                aria-label="Speaking rate"
              />
            </Field>
          </Section>

          <Section title="Personality">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {STYLES.map((st) => (
                <button
                  key={st.id}
                  type="button"
                  onClick={() => update({ style: st.id })}
                  aria-pressed={s.style === st.id}
                  className={[
                    "rounded-lg border px-3 py-2.5 text-left transition-colors",
                    s.style === st.id ? "border-fg/60 bg-hover" : "border-line hover:border-line-strong",
                  ].join(" ")}
                >
                  <div className="text-[13px] font-medium">{st.label}</div>
                  <div className="mt-0.5 text-[11.5px] leading-snug text-fg-subtle">{st.hint}</div>
                </button>
              ))}
            </div>
            <Field label="Custom instructions" aside={`${s.persona.length}/${LIMITS.maxPersonaChars}`}>
              <textarea
                value={s.persona}
                maxLength={LIMITS.maxPersonaChars}
                onChange={(e) => update({ persona: e.target.value })}
                rows={3}
                placeholder="e.g. You're a patient Spanish tutor. Correct my mistakes gently."
                className="w-full resize-none rounded-lg border border-line bg-elevated px-3 py-2.5 text-[14px] leading-relaxed text-fg outline-none placeholder:text-fg-subtle focus:border-line-strong"
              />
            </Field>
          </Section>

          <Section title="Conversation">
            <Field label="Language">
              <select
                value={s.language}
                onChange={(e) => update({ language: e.target.value })}
                className="h-10 w-full rounded-lg border border-line bg-elevated px-3 text-[14px] text-fg outline-none focus:border-line-strong"
              >
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.code === "auto" ? l.label : `${l.label} · ${l.native}`}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Turn-taking">
              <Segmented
                value={s.turnTaking}
                onChange={(v) => update({ turnTaking: v })}
                options={TURN_TAKING.map((t) => ({ value: t.id, label: t.label }))}
              />
              <p className="mt-2 text-[12px] text-fg-subtle">{TURN_TAKING.find((t) => t.id === s.turnTaking)?.hint}</p>
            </Field>
            <Field label="Microphone">
              <Segmented
                value={s.micEnvironment}
                onChange={(v) => update({ micEnvironment: v })}
                options={[
                  { value: "near", label: "Headset / close" },
                  { value: "far", label: "Laptop / room" },
                ]}
              />
            </Field>
          </Section>

          <Section title="Appearance">
            <Segmented
              value={props.theme}
              onChange={props.onTheme}
              options={[
                { value: "dark", label: "Dark" },
                { value: "light", label: "Light" },
                { value: "system", label: "System" },
              ]}
            />
          </Section>

          {caps && (
            <Section title="Server">
              <ul className="space-y-2 text-[13px]">
                <KeyRow name="OPENAI_API_KEY" ok={caps.realtime} />
                <KeyRow name="ANTHROPIC_API_KEY" ok={caps.llm.anthropic} />
                <KeyRow name="ELEVENLABS_API_KEY" ok={caps.tts.elevenlabs} />
              </ul>
              <p className="mt-3 text-[12px] leading-relaxed text-fg-subtle">
                Keys live only on the server. Audio and transcripts are never stored.
              </p>
            </Section>
          )}
        </div>

        {props.active && props.dirty && (
          <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-line px-6 py-4">
            <p className="text-[12.5px] text-fg-muted">Changes apply to the next session.</p>
            <button
              type="button"
              onClick={props.onApply}
              className="h-9 rounded-lg bg-inverse-bg px-4 text-[13px] font-medium text-inverse-fg hover:opacity-90"
            >
              Restart now
            </button>
          </footer>
        )}
      </aside>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-line py-6 last:border-0">
      <h3 className="mb-4 text-[11px] font-medium uppercase tracking-[0.09em] text-fg-subtle">{title}</h3>
      <div className="space-y-5">{children}</div>
    </section>
  );
}

function Field({ label, aside, children }: { label: string; aside?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-[13px] text-fg-muted">{label}</span>
        {aside && <span className="font-mono text-[11.5px] text-fg-subtle">{aside}</span>}
      </div>
      {children}
    </div>
  );
}

function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; disabled?: boolean; hint?: string }[];
}) {
  return (
    <div role="radiogroup" className="flex rounded-lg border border-line bg-bg p-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          disabled={o.disabled}
          title={o.disabled ? "Not configured on the server" : o.hint}
          onClick={() => onChange(o.value)}
          className={[
            "flex-1 rounded-md px-2 py-1.5 text-[13px] transition-colors duration-150",
            "disabled:cursor-not-allowed disabled:opacity-35",
            value === o.value ? "bg-elevated text-fg shadow-[0_0_0_1px_var(--line-strong)]" : "text-fg-muted hover:text-fg",
          ].join(" ")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function EngineCard({
  selected,
  onSelect,
  title,
  badge,
  body,
  unavailable,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  badge: string;
  body: string;
  unavailable: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={[
        "rounded-xl border p-4 text-left transition-colors duration-150",
        selected ? "border-fg/60 bg-hover" : "border-line hover:border-line-strong",
      ].join(" ")}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-[14px] font-medium">
          <span
            className={[
              "grid h-4 w-4 place-items-center rounded-full border",
              selected ? "border-fg bg-fg text-bg" : "border-line-strong",
            ].join(" ")}
          >
            {selected && <CheckIcon width={10} height={10} strokeWidth={3} />}
          </span>
          {title}
        </span>
        <span className={`text-[11px] ${unavailable ? "text-warn" : "text-fg-subtle"}`}>{badge}</span>
      </div>
      <p className="mt-2 pl-6 text-[12.5px] leading-relaxed text-fg-muted">{body}</p>
    </button>
  );
}

function VoiceChips<T extends string>({
  voices,
  value,
  onChange,
}: {
  voices: readonly T[];
  value: string;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {voices.map((v) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          aria-pressed={value === v}
          className={[
            "h-8 rounded-full border px-3 text-[13px] capitalize transition-colors",
            value === v ? "border-fg bg-fg text-bg" : "border-line text-fg-muted hover:border-line-strong hover:text-fg",
          ].join(" ")}
        >
          {v}
        </button>
      ))}
    </div>
  );
}

function KeyRow({ name, ok }: { name: string; ok: boolean }) {
  return (
    <li className="flex items-center justify-between">
      <code className="font-mono text-[12px] text-fg-muted">{name}</code>
      <span className={`flex items-center gap-1.5 text-[12px] ${ok ? "text-ok" : "text-fg-subtle"}`}>
        <span className={`h-1.5 w-1.5 rounded-full ${ok ? "bg-ok" : "bg-fg-subtle"}`} />
        {ok ? "Configured" : "Not set"}
      </span>
    </li>
  );
}
