"use client";

import type { AgentStatus } from "@/lib/client/types";
import { HandIcon, MicIcon, MicOffIcon, RestartIcon, StopIcon } from "./icons";

interface Props {
  status: AgentStatus;
  active: boolean;
  muted: boolean;
  onPrimary: () => void;
  onMute: () => void;
  onInterrupt: () => void;
  onRestart: () => void;
}

export function Controls({ status, active, muted, onPrimary, onMute, onInterrupt, onRestart }: Props) {
  const connecting = status === "connecting";
  const canInterrupt = status === "speaking" || status === "thinking";

  return (
    <div className="flex items-start justify-center gap-6 sm:gap-10">
      <Secondary
        label={muted ? "Unmute" : "Mute"}
        hint="M"
        onClick={onMute}
        disabled={!active || connecting}
        pressed={muted}
      >
        {muted ? <MicOffIcon /> : <MicIcon />}
      </Secondary>

      <div className="flex flex-col items-center gap-2.5">
        <button
          type="button"
          onClick={onPrimary}
          aria-label={active ? "End conversation" : "Start conversation"}
          className={[
            "relative grid h-[68px] w-[68px] place-items-center rounded-full transition-all duration-300 ease-out-soft",
            "active:scale-95",
            active
              ? "bg-elevated text-fg ring-1 ring-line-strong hover:bg-hover"
              : "bg-inverse-bg text-inverse-fg shadow-[0_8px_30px_-8px_rgba(0,0,0,0.6)] hover:scale-[1.03]",
          ].join(" ")}
        >
          {connecting ? (
            <span className="h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent" />
          ) : active ? (
            <StopIcon width={22} height={22} />
          ) : (
            <MicIcon width={24} height={24} />
          )}
        </button>
        <span className="text-[12px] text-fg-muted">
          {connecting ? "Connecting" : active ? "End" : "Start"}
        </span>
      </div>

      {canInterrupt ? (
        <Secondary label="Interrupt" hint="Esc" onClick={onInterrupt}>
          <HandIcon />
        </Secondary>
      ) : (
        <Secondary label="Restart" onClick={onRestart} disabled={!active || connecting}>
          <RestartIcon />
        </Secondary>
      )}
    </div>
  );
}

function Secondary({
  label,
  hint,
  children,
  onClick,
  disabled,
  pressed,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
}) {
  return (
    <div className="flex flex-col items-center gap-2.5 pt-2">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        aria-pressed={pressed}
        title={hint ? `${label} (${hint})` : label}
        className={[
          "grid h-[52px] w-[52px] place-items-center rounded-full border transition-colors duration-200",
          "disabled:pointer-events-none disabled:opacity-35 active:scale-95",
          pressed
            ? "border-transparent bg-danger-bg text-danger"
            : "border-line text-fg-muted hover:border-line-strong hover:bg-hover hover:text-fg",
        ].join(" ")}
      >
        {children}
      </button>
      <span className="text-[12px] text-fg-subtle">{label}</span>
    </div>
  );
}
