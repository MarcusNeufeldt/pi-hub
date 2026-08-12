"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Contextual action bar anchored under selected text: highlight a passage in a
 * reply and hand it to the agent.
 *
 * Interaction design adapted from Beautiful UI (beautifului.dev). That component
 * pulls ten icons from `iconoir-react` and two internal atoms that are not
 * distributed with it, so this rebuild uses inline SVGs and this app's tokens and
 * adds no dependency.
 *
 * Scoped to a container rather than the document: selecting inside the composer,
 * the file explorer or a settings panel must not offer to rewrite it. Positioned
 * with viewport coordinates and `position: fixed`, so no scroll offset arithmetic
 * and no reposition-on-scroll listener — the bar simply hides when the selection
 * leaves the visible area.
 */

export interface SelectionIntent {
  id: string;
  label: string;
  /** Built from the selected text; what actually reaches the agent. */
  prompt: (selection: string) => string;
  icon: React.ReactNode;
}

const strokeIcon = (path: React.ReactNode) => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {path}
  </svg>
);

export const DEFAULT_SELECTION_INTENTS: SelectionIntent[] = [
  {
    id: "explain",
    label: "Explain",
    prompt: (text) => `Explain this:\n\n${text}`,
    icon: strokeIcon(<><circle cx="12" cy="12" r="9" /><path d="M12 17v-5M12 8h.01" /></>),
  },
  {
    id: "improve",
    label: "Improve",
    prompt: (text) => `Improve this, keeping its meaning:\n\n${text}`,
    icon: strokeIcon(<path d="M12 3l1.9 5.8H20l-4.9 3.6 1.9 5.8L12 14.6 7 18.2l1.9-5.8L4 8.8h6.1z" />),
  },
  {
    id: "shorten",
    label: "Shorten",
    prompt: (text) => `Rewrite this more concisely:\n\n${text}`,
    icon: strokeIcon(<path d="M4 8h16M4 12h10M4 16h6" />),
  },
];

/** Below this, a "selection" is usually a stray click-drag. */
const MIN_SELECTION_LENGTH = 2;
const GAP_FROM_SELECTION = 8;
const ESTIMATED_BAR_WIDTH = 260;

export function SelectionActions({
  containerRef,
  onAction,
  intents = DEFAULT_SELECTION_INTENTS,
  disabled = false,
}: {
  /** Only selections inside this element raise the bar. */
  containerRef: React.RefObject<HTMLElement | null>;
  onAction: (prompt: string, selectedText: string, intentId: string) => void;
  intents?: SelectionIntent[];
  disabled?: boolean;
}) {
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const [text, setText] = useState("");
  const barRef = useRef<HTMLDivElement>(null);

  const hide = useCallback(() => {
    setAnchor(null);
    setText("");
  }, []);

  const measure = useCallback(() => {
    if (disabled) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return hide();

    const selected = selection.toString().trim();
    if (selected.length < MIN_SELECTION_LENGTH) return hide();

    const container = containerRef.current;
    const range = selection.getRangeAt(0);
    // Both ends must be inside the container. `commonAncestorContainer` alone would
    // accept a selection that starts in a message and ends outside it.
    if (!container
      || !container.contains(range.startContainer)
      || !container.contains(range.endContainer)) {
      return hide();
    }

    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return hide();
    // Selection scrolled out of view; nothing to anchor to.
    if (rect.bottom < 0 || rect.top > window.innerHeight) return hide();

    // Centre under the selection, then keep the bar inside the viewport. Clamped
    // against an estimate because the bar has not been measured yet on first show.
    const half = (barRef.current?.offsetWidth ?? ESTIMATED_BAR_WIDTH) / 2;
    const x = Math.min(Math.max(rect.left + rect.width / 2, half + 8), window.innerWidth - half - 8);
    setText(selected);
    setAnchor({ x, y: rect.bottom + GAP_FROM_SELECTION });
  }, [containerRef, disabled, hide]);

  useEffect(() => {
    if (disabled) {
      hide();
      return;
    }
    // selectionchange fires mid-drag, so measuring only on pointerup/keyup would
    // miss keyboard selection while measuring on every change would thrash. One
    // frame of debounce covers both.
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };
    // A click inside the bar must not dismiss it before the handler runs.
    const onPointerDown = (event: PointerEvent) => {
      if (barRef.current?.contains(event.target as Node)) return;
      hide();
    };

    document.addEventListener("selectionchange", schedule);
    document.addEventListener("pointerup", schedule);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", hide);
    // Capture phase: a scroll inside the message list does not bubble to window.
    window.addEventListener("scroll", hide, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", schedule);
      document.removeEventListener("pointerup", schedule);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", hide);
      window.removeEventListener("scroll", hide, true);
    };
  }, [disabled, hide, measure]);

  if (!anchor || !text) return null;

  const run = (intent: SelectionIntent) => {
    onAction(intent.prompt(text), text, intent.id);
    // Drop the highlight too, or the bar reappears on the next selectionchange.
    window.getSelection()?.removeAllRanges();
    hide();
  };

  return (
    <div
      ref={barRef}
      role="toolbar"
      aria-label="Selection actions"
      style={{
        position: "fixed",
        left: anchor.x,
        top: anchor.y,
        transform: "translateX(-50%)",
        zIndex: "var(--z-overlay)",
        display: "flex",
        alignItems: "center",
        gap: 2,
        padding: 4,
        background: "var(--bg-panel)",
        border: "1px solid var(--border)",
        borderRadius: "var(--r-md)",
        boxShadow: "var(--sh-2)",
        animation: "fade-up 140ms var(--ease) both",
      }}
    >
      {intents.map((intent) => (
        <button
          key={intent.id}
          type="button"
          // onMouseDown would fire before the selection is readable in some
          // browsers; the pointerdown guard above keeps this click alive.
          onClick={() => run(intent)}
          className="ui-btn ui-btn--sm"
          style={{
            gap: 5,
            paddingInline: 8,
            fontSize: "var(--fs-micro)",
            borderRadius: "var(--r-sm)",
            whiteSpace: "nowrap",
          }}
        >
          {intent.icon}
          {intent.label}
        </button>
      ))}
    </div>
  );
}
