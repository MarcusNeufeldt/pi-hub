"use client";

import { useEffect, useState } from "react";

/**
 * Pixel-grid activity indicator for a turn that is working but not yet
 * streaming, with a shimmering label and a live elapsed time.
 *
 * Interaction design adapted from Beautiful UI (beautifului.dev), re-expressed
 * against this app's tokens: that library styles itself with utility classes over
 * its own `--ink` / `--surface` / `--line` scale, none of which exist here, so the
 * markup is rebuilt with inline styles over `--text` / `--bg-panel` / `--border`
 * like the rest of these components. Its icon set and two internal atoms are not
 * distributed with the component, so nothing depends on them.
 *
 * Nine cells share a single keyframe and differ only by `animation-delay`, so the
 * wavefront costs no JavaScript. The cycle is deliberately shorter than the time
 * the wave takes to cross, which keeps two fronts in flight and reads as motion
 * rather than a repeating blink.
 */

/**
 * Delay per cell in a 3x3 grid, as a chevron travelling left to right: the delay
 * grows with the column and with distance from the middle row, so the leading
 * edge is a `>` shape.
 */
const CHEVRON_DELAYS = Array.from({ length: 9 }, (_, index) => {
  const row = Math.floor(index / 3);
  const column = index % 3;
  return (column + Math.abs(row - 1)) * 90;
});

/** Perimeter cells clockwise from the top-left; the centre never lights. */
const ORBIT_SEQUENCE = [0, 1, 2, 5, 8, 7, 6, 3];
const ORBIT_DELAYS = Array.from({ length: 9 }, (_, index) => {
  const step = ORBIT_SEQUENCE.indexOf(index);
  return step === -1 ? null : step * 110;
});

export type LoadingVariant = "drive" | "dots" | "orbit";

const VARIANTS: Record<LoadingVariant, { delays: (number | null)[]; durationMs: number; round: boolean }> = {
  drive: { delays: CHEVRON_DELAYS, durationMs: 650, round: false },
  dots: { delays: CHEVRON_DELAYS, durationMs: 650, round: true },
  orbit: { delays: ORBIT_DELAYS, durationMs: 950, round: false },
};

/** Tenths of a second, so the readout moves without a per-frame re-render. */
function useElapsedLabel(startedAt: number | null): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, (now - (startedAt ?? now)) / 1000);
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${(seconds % 60).toFixed(1)}s`;
}

export function LoadingState({
  label,
  variant = "drive",
  startedAt = null,
  showElapsed = true,
}: {
  /**
   * Omitted or null renders grid and timer only. Callers derive this from a phase
   * that may not have a translation yet, and a blank gap reads worse than no label.
   */
  label?: string | null;
  variant?: LoadingVariant;
  /**
   * When the work began, so the readout survives a remount — a pane splitting or
   * the message list re-rendering must not restart the clock. Falls back to mount
   * time when the caller has no timestamp.
   */
  startedAt?: number | null;
  showElapsed?: boolean;
}) {
  const elapsed = useElapsedLabel(startedAt);
  const { delays, durationMs, round } = VARIANTS[variant] ?? VARIANTS.drive;

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
      <span
        aria-hidden="true"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 4px)",
          gap: 1.5,
          flexShrink: 0,
        }}
      >
        {delays.map((delay, index) => (
          <span
            key={index}
            className="pixel-grid-cell"
            style={{
              width: 4,
              height: 4,
              background: "var(--text)",
              borderRadius: round ? "var(--r-full)" : 1,
              // The unlit centre of the orbit variant stays dimmer than a cell
              // waiting its turn, so the ring reads as the moving part.
              opacity: delay === null ? 0.07 : 0.15,
              animation: delay === null
                ? "none"
                : `pixel-on ${durationMs}ms ease-in-out ${delay}ms infinite`,
            }}
          />
        ))}
      </span>

      {label && (
      <span
        className="shimmer-label"
        style={{
          fontSize: "var(--fs-meta)",
          fontWeight: 500,
          // The band is painted behind the text and clipped to the glyphs, so the
          // text itself must be transparent for it to show through.
          backgroundImage: "linear-gradient(90deg, var(--text-dim) 35%, var(--text) 50%, var(--text-dim) 65%)",
          backgroundSize: "200% 100%",
          WebkitBackgroundClip: "text",
          backgroundClip: "text",
          WebkitTextFillColor: "transparent",
          color: "transparent",
          animation: "shimmer-text 1.4s linear infinite",
        }}
      >
        {label}
      </span>
      )}

      {showElapsed && (
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--fs-micro)",
            color: "var(--text-dim)",
            // Tabular figures stop the row jittering as the tenths tick over.
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {elapsed}
        </span>
      )}
    </span>
  );
}
