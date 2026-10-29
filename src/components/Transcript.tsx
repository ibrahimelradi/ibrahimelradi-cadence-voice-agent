"use client";

import { useEffect, useRef, useState } from "react";
import type { TranscriptEntry } from "@/lib/client/types";
import { CheckIcon, CloseIcon, CopyIcon, TrashIcon } from "./icons";

interface Props {
  entries: TranscriptEntry[];
  onClear: () => void;
  onClose?: () => void;
}

export function Transcript({ entries, onClear, onClose }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [entries]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  const copy = async () => {
    const text = entries
      .filter((e) => e.text.trim())
      .map((e) => `${e.role === "user" ? "You" : "Assistant"}: ${e.text}`)
      .join("\n\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked */
    }
  };

  return (
    <section aria-label="Conversation transcript" className="flex h-full min-h-0 flex-col">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-line px-5">
        <h2 className="text-[13px] font-medium tracking-[-0.005em] text-fg">Transcript</h2>
        <div className="flex items-center gap-1">
          <IconButton label={copied ? "Copied" : "Copy transcript"} onClick={copy} disabled={!entries.length}>
            {copied ? <CheckIcon width={16} height={16} /> : <CopyIcon width={16} height={16} />}
          </IconButton>
          <IconButton label="Clear transcript" onClick={onClear} disabled={!entries.length}>
            <TrashIcon width={16} height={16} />
          </IconButton>
          {onClose && (
            <IconButton label="Close transcript" onClick={onClose}>
              <CloseIcon width={16} height={16} />
            </IconButton>
          )}
        </div>
      </header>

      <div
        ref={scroller}
        onScroll={onScroll}
        className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-5 py-6"
        aria-live="polite"
        aria-relevant="additions text"
      >
        {entries.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <p className="text-[13px] text-fg-muted">Nothing here yet.</p>
            <p className="mt-1 max-w-[220px] text-[12px] leading-relaxed text-fg-subtle">
              What you and the assistant say will appear here as you talk. It isn&apos;t saved anywhere.
            </p>
          </div>
        ) : (
          <ol className="space-y-6">
            {entries.map((e) => (
              <li key={e.id} className="animate-fade-up">
                <div className="mb-1.5 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.08em] text-fg-subtle">
                  <span>{e.role === "user" ? "You" : "Assistant"}</span>
                  {e.interrupted && (
                    <span className="rounded-full border border-line px-1.5 py-px text-[10px] normal-case tracking-normal text-fg-subtle">
                      interrupted
                    </span>
                  )}
                </div>
                <p
                  className={[
                    "text-[15px] leading-[1.6] tracking-[-0.006em]",
                    e.role === "user" ? "text-fg-muted" : "text-fg",
                    !e.final ? "typing-caret" : "",
                  ].join(" ")}
                >
                  {e.text || (e.role === "user" ? "Listening…" : "")}
                </p>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

export function IconButton({
  label,
  children,
  onClick,
  disabled,
  active,
}: {
  label: string;
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      disabled={disabled}
      className={[
        "grid h-9 w-9 place-items-center rounded-lg text-fg-muted transition-colors duration-150",
        "hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-35",
        active ? "bg-hover text-fg" : "",
      ].join(" ")}
    >
      {children}
    </button>
  );
}
