"use client";

import { useState } from "react";

/**
 * Human-in-the-loop card: the agent asks before acting, one question at a time.
 *
 * Interaction design adapted from Beautiful UI (beautifului.dev) onto this app's
 * tokens and control classes. Where that library hardcodes its own demo questions,
 * this takes them as data so the extension-UI dialog path and any future
 * tool-approval flow can both drive it.
 *
 * One question per screen rather than a scrolling form: an approval interrupts
 * whatever the reader was doing, so the fewer things on screen the faster it is to
 * dismiss. Progress is a row of pills, which shows how much is left without
 * needing a count.
 */

export interface ApprovalOption {
  id: string;
  label: string;
  /** Secondary line, e.g. what the choice will actually do. */
  hint?: string;
}

export interface ApprovalQuestion {
  id: string;
  prompt: string;
  /** `single` advances on click; `multiple` waits for a confirm. */
  kind: "single" | "multiple";
  options: ApprovalOption[];
  /** Adds a free-text field, for when none of the options fit. */
  allowCustom?: boolean;
}

export type ApprovalAnswers = Record<string, { optionIds: string[]; custom?: string }>;

/** Long enough to see the choice register, short enough not to feel like waiting. */
const ADVANCE_DELAY_MS = 420;

export function ApprovalCard({
  questions,
  onSubmit,
  onDismiss,
  submitLabel = "Send",
  busy = false,
}: {
  questions: ApprovalQuestion[];
  onSubmit: (answers: ApprovalAnswers) => void;
  onDismiss?: () => void;
  submitLabel?: string;
  busy?: boolean;
}) {
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<ApprovalAnswers>({});
  const [sent, setSent] = useState(false);

  const question = questions[index];
  // A caller can legitimately pass an empty list while loading; render nothing
  // rather than crash on questions[0].
  if (!question) return null;

  const isLast = index === questions.length - 1;
  const current = answers[question.id] ?? { optionIds: [] };
  const answered = current.optionIds.length > 0 || Boolean(current.custom?.trim());

  const commit = (next: ApprovalAnswers) => {
    setAnswers(next);
    if (isLast) {
      setSent(true);
      onSubmit(next);
    } else {
      setIndex((value) => value + 1);
    }
  };

  const choose = (optionId: string) => {
    const picked = current.optionIds;
    const optionIds = question.kind === "single"
      ? [optionId]
      : picked.includes(optionId)
        ? picked.filter((id) => id !== optionId)
        : [...picked, optionId];
    // A single-choice question is fully answered by the click, so advance for the
    // reader. Multi-select cannot: there is no way to know they are finished.
    const next = { ...answers, [question.id]: { ...current, optionIds } };
    if (question.kind === "single") {
      setAnswers(next);
      window.setTimeout(() => commit(next), ADVANCE_DELAY_MS);
    } else {
      setAnswers(next);
    }
  };

  if (sent) {
    return (
      <div
        style={{
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          gap: 8, minHeight: 132, padding: "var(--sp-4)",
          background: "var(--bg-panel)", border: "1px solid var(--border)",
          borderRadius: "var(--r-lg)", boxShadow: "var(--sh-1)",
        }}
      >
        <span
          className="pop-in"
          aria-hidden="true"
          style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            width: 24, height: 24, borderRadius: "var(--r-full)",
            background: "var(--success)", color: "var(--accent-on)",
            animation: "pop-in 300ms cubic-bezier(0.23, 1, 0.32, 1) both",
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 6L9 17l-5-5" />
          </svg>
        </span>
        <span
          className="fade-up"
          style={{
            fontSize: "var(--fs-meta)", fontWeight: 500, color: "var(--text)",
            animation: "fade-up 350ms cubic-bezier(0.23, 1, 0.32, 1) 100ms both",
          }}
        >
          {busy ? "Sending…" : "Answer sent"}
        </span>
      </div>
    );
  }

  return (
    <div
      role="group"
      aria-label={question.prompt}
      style={{
        display: "flex", flexDirection: "column", gap: "var(--sp-3)",
        padding: "var(--sp-4)", background: "var(--bg-panel)",
        border: "1px solid var(--border)", borderRadius: "var(--r-lg)",
        boxShadow: "var(--sh-1)", maxWidth: 420,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)" }}>
        {/* Elongated pills, not "2 of 3": the shape carries the same information
            and survives translation without a string. */}
        <span aria-hidden="true" style={{ display: "flex", gap: 3, flex: 1 }}>
          {questions.map((entry, position) => (
            <span
              key={entry.id}
              style={{
                height: 3, flex: position === index ? 2 : 1,
                borderRadius: "var(--r-full)",
                background: position <= index ? "var(--accent)" : "var(--border)",
                transition: "flex var(--dur) var(--ease), background var(--dur) var(--ease)",
              }}
            />
          ))}
        </span>
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            className="ui-btn ui-btn--sm ui-btn--outline"
            aria-label="Dismiss"
            style={{ paddingInline: 6, fontSize: "var(--fs-micro)" }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      <p style={{ margin: 0, fontSize: "var(--fs-ui)", fontWeight: 500, color: "var(--text)" }}>
        {question.prompt}
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {question.options.map((option) => {
          const picked = current.optionIds.includes(option.id);
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => choose(option.id)}
              // .ui-row owns hover and the mobile tap target; an inline background
              // here would beat it and stick after a tap.
              className={`ui-row${picked ? " is-active" : ""}`}
              aria-pressed={picked}
              style={{
                gap: "var(--sp-2)", padding: "9px 10px", width: "100%",
                textAlign: "left", borderRadius: "var(--r-md)",
                fontSize: "var(--fs-meta)",
                color: picked ? "var(--text)" : "var(--text-muted)",
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 14, height: 14, flexShrink: 0,
                  border: `1.5px solid ${picked ? "var(--accent)" : "var(--border-strong)"}`,
                  background: picked ? "var(--accent)" : "transparent",
                  color: "var(--accent-on)",
                  // Round for one-of, square for many-of: the shape says which.
                  borderRadius: question.kind === "single" ? "var(--r-full)" : 3,
                  transition: "background var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease)",
                }}
              >
                {picked && (
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                )}
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>
                {option.label}
                {option.hint && (
                  <span style={{ display: "block", fontSize: "var(--fs-micro)", color: "var(--text-dim)" }}>
                    {option.hint}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>

      {question.allowCustom && (
        <input
          className="ui-field"
          placeholder="Something else…"
          value={current.custom ?? ""}
          onChange={(event) => setAnswers((value) => ({
            ...value,
            [question.id]: { optionIds: [], custom: event.target.value },
          }))}
          style={{ fontSize: "var(--fs-meta)" }}
        />
      )}

      {/* Single-choice advances on click, so a confirm button would be dead
          weight there. Multi-select has no other way to say "done". */}
      {question.kind === "multiple" && (
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--sp-2)" }}>
          <button
            type="button"
            disabled={!answered || busy}
            onClick={() => commit(answers)}
            className="ui-btn ui-btn--accent ui-btn--sm"
            style={{ fontSize: "var(--fs-meta)" }}
          >
            {isLast ? submitLabel : "Next"}
          </button>
        </div>
      )}
    </div>
  );
}
