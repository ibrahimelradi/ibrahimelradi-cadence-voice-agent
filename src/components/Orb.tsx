"use client";

import { useEffect, useRef } from "react";
import type { AgentStatus, Levels } from "@/lib/client/types";

type RGB = [number, number, number];

const PALETTE: Record<AgentStatus, RGB> = {
  idle: [188, 188, 196],
  connecting: [188, 188, 196],
  listening: [143, 214, 195],
  hearing: [160, 232, 212],
  thinking: [183, 166, 245],
  speaking: [242, 195, 139],
  error: [242, 139, 130],
};

interface Props {
  status: AgentStatus;
  getLevels: () => Levels;
  muted: boolean;
  onClick?: () => void;
  label: string;
}

/**
 * The central voice visualisation: a soft, living form whose colour reflects
 * the conversation state and whose surface responds to live audio levels.
 */
export function Orb({ status, getLevels, muted, onClick, label }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const statusRef = useRef(status);
  const mutedRef = useRef(muted);
  statusRef.current = status;
  mutedRef.current = muted;

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let raf = 0;
    let w = 0;
    let h = 0;
    const color: RGB = [...PALETTE.idle];
    let energy = 0;
    let t = 0;
    let last = performance.now();
    const ripples: { r: number; a: number }[] = [];
    let rippleClock = 0;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      w = rect.width;
      h = rect.height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const st = statusRef.current;
      const lv = getLevels();

      // Which signal drives the surface depends on who is talking.
      let target = 0;
      if (st === "speaking") target = lv.output;
      else if (st === "hearing" || st === "listening") target = mutedRef.current ? 0 : lv.input;
      else if (st === "thinking") target = 0.18;
      else if (st === "connecting") target = 0.1;
      energy += (target - energy) * (target > energy ? 0.35 : 0.08);

      const tc = PALETTE[st];
      for (let i = 0; i < 3; i++) color[i]! += (tc[i]! - color[i]!) * Math.min(1, dt * 4);

      const speed = st === "thinking" ? 1.6 : st === "connecting" ? 2.4 : 0.7 + energy * 2.2;
      t += dt * (reduced ? 0.2 : speed);

      ctx.clearRect(0, 0, w, h);
      const cx = w / 2;
      const cy = h / 2;
      const base = Math.min(w, h) * 0.27;
      const edge = Math.min(w, h) * 0.49;
      const breathe = st === "idle" ? Math.sin(t * 0.9) * 0.015 : 0;
      const R = base * (1 + breathe + energy * 0.14);
      const [r, g, b] = color.map(Math.round) as RGB;
      const rgba = (a: number) => `rgba(${r},${g},${b},${a})`;

      // Listening ripples: quiet rings that emanate while the mic is open.
      if (!reduced && (st === "listening" || st === "hearing") && !mutedRef.current) {
        rippleClock += dt * (st === "hearing" ? 1.6 : 0.55);
        if (rippleClock > 1) {
          rippleClock = 0;
          ripples.push({ r: R * 1.02, a: 0.22 + energy * 0.3 });
        }
      }
      for (let i = ripples.length - 1; i >= 0; i--) {
        const rp = ripples[i]!;
        rp.r += dt * base * 0.55;
        // Fade out before reaching the canvas edge.
        rp.a -= dt * 0.12 + Math.max(0, (rp.r - base * 1.4) / (edge - base * 1.4)) * dt * 0.6;
        if (rp.a <= 0 || rp.r > edge) {
          ripples.splice(i, 1);
          continue;
        }
        ctx.beginPath();
        ctx.arc(cx, cy, rp.r, 0, Math.PI * 2);
        ctx.strokeStyle = rgba(rp.a);
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // Outer glow
      const glow = ctx.createRadialGradient(cx, cy, R * 0.6, cx, cy, edge);
      glow.addColorStop(0, rgba(0.16 + energy * 0.18));
      glow.addColorStop(1, rgba(0));
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, w, h);

      // The form: a circle perturbed by a few slow harmonics.
      const amp = 0.018 + energy * 0.11;
      const pts = 96;
      ctx.beginPath();
      for (let i = 0; i <= pts; i++) {
        const a = (i / pts) * Math.PI * 2;
        const n =
          Math.sin(a * 3 + t * 1.1) * 0.5 +
          Math.sin(a * 5 - t * 1.7 + 1.3) * 0.3 +
          Math.sin(a * 2 + t * 0.6 + 2.1) * 0.4;
        const rr = R * (1 + n * amp);
        const x = cx + Math.cos(a) * rr;
        const y = cy + Math.sin(a) * rr;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      const fill = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.45, R * 0.05, cx, cy, R * 1.1);
      fill.addColorStop(0, `rgba(${Math.min(255, r + 50)},${Math.min(255, g + 50)},${Math.min(255, b + 50)},1)`);
      fill.addColorStop(0.55, rgba(0.92));
      fill.addColorStop(1, `rgba(${r * 0.55},${g * 0.55},${b * 0.55},0.95)`);
      ctx.fillStyle = fill;
      ctx.fill();

      // Thinking: a slow orbiting highlight.
      if (st === "thinking" || st === "connecting") {
        const a = t * 1.4;
        ctx.save();
        ctx.clip();
        const hx = cx + Math.cos(a) * R * 0.55;
        const hy = cy + Math.sin(a) * R * 0.55;
        const hl = ctx.createRadialGradient(hx, hy, 0, hx, hy, R * 0.7);
        hl.addColorStop(0, "rgba(255,255,255,0.35)");
        hl.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = hl;
        ctx.fillRect(0, 0, w, h);
        ctx.restore();
      }

      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [getLevels]);

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="relative block aspect-square w-full max-w-[min(72vw,420px)] cursor-pointer rounded-full focus-visible:outline-offset-[-24px]"
    >
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
    </button>
  );
}
