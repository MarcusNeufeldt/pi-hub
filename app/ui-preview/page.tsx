"use client";

import { useRef, useState } from "react";

import { ApprovalCard, type ApprovalAnswers } from "@/components/ApprovalCard";
import { LoadingState, type LoadingVariant } from "@/components/LoadingState";
import { SelectionActions } from "@/components/SelectionActions";

/**
 * Preview harness for the components ported from Beautiful UI. Not linked from
 * the app — it exists so the ported pieces can be judged against the real theme,
 * in both colour schemes, before any of them is wired into the chat.
 */

const SAMPLE = `Pistachio holds the top slot all weekend. Churn it first thing Saturday so the
batch has time to firm up before the afternoon rush. Select any part of this
paragraph to raise the action bar.`;

const QUESTIONS = [
  {
    id: "scope",
    prompt: "Apply the migration to every workspace?",
    kind: "single" as const,
    options: [
      { id: "all", label: "All workspaces", hint: "12 projects" },
      { id: "current", label: "Just this one" },
      { id: "dry", label: "Dry run first", hint: "Report, change nothing" },
    ],
  },
  {
    id: "checks",
    prompt: "Which checks should run first?",
    kind: "multiple" as const,
    options: [
      { id: "types", label: "Type check" },
      { id: "tests", label: "Test suite" },
      { id: "lint", label: "Lint" },
    ],
    allowCustom: true,
  },
];

export default function UiPreviewPage() {
  const proseRef = useRef<HTMLDivElement>(null);
  const [handed, setHanded] = useState<string | null>(null);
  const [answers, setAnswers] = useState<ApprovalAnswers | null>(null);

  return (
    <main style={{ padding: "var(--sp-6)", maxWidth: 900, margin: "0 auto", color: "var(--text)" }}>
      <h1 style={{ fontSize: "var(--fs-title)", marginBottom: "var(--sp-2)" }}>UI preview</h1>
      <p style={{ fontSize: "var(--fs-meta)", color: "var(--text-dim)", marginTop: 0 }}>
        Ported onto this app&apos;s tokens. Toggle the theme to check both schemes.
      </p>

      <section style={{ marginTop: "var(--sp-6)" }}>
        <h2 style={{ fontSize: "var(--fs-ui)", color: "var(--text-muted)" }}>Loading states</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-3)", marginTop: "var(--sp-3)" }}>
          {(["drive", "dots", "orbit"] as LoadingVariant[]).map((variant) => (
            <div key={variant} style={{ display: "flex", alignItems: "center", gap: "var(--sp-4)" }}>
              <code style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-micro)", color: "var(--text-dim)", width: 48 }}>
                {variant}
              </code>
              <LoadingState label="Working" variant={variant} />
            </div>
          ))}
        </div>
      </section>

      <section style={{ marginTop: "var(--sp-7)" }}>
        <h2 style={{ fontSize: "var(--fs-ui)", color: "var(--text-muted)" }}>Selection actions</h2>
        <div
          ref={proseRef}
          style={{
            marginTop: "var(--sp-3)", padding: "var(--sp-4)",
            background: "var(--assistant-bg)", border: "1px solid var(--border)",
            borderRadius: "var(--r-md)", fontSize: "var(--fs-body)", lineHeight: 1.6,
          }}
        >
          {SAMPLE}
        </div>
        <p style={{ fontSize: "var(--fs-micro)", color: "var(--text-dim)" }}>
          Selecting text outside that box must not raise the bar — that is the scoping check.
        </p>
        {handed && (
          <pre
            style={{
              marginTop: "var(--sp-2)", padding: "var(--sp-3)", overflowX: "auto",
              background: "var(--bg-subtle)", border: "1px solid var(--border)",
              borderRadius: "var(--r-md)", fontFamily: "var(--font-mono)",
              fontSize: "var(--fs-micro)", color: "var(--text-muted)", whiteSpace: "pre-wrap",
            }}
          >
            {handed}
          </pre>
        )}
        <SelectionActions
          containerRef={proseRef}
          onAction={(prompt, _text, intentId) => setHanded(`[${intentId}] ${prompt}`)}
        />
      </section>

      <section style={{ marginTop: "var(--sp-7)", marginBottom: "var(--sp-8)" }}>
        <h2 style={{ fontSize: "var(--fs-ui)", color: "var(--text-muted)" }}>Approval card</h2>
        <div style={{ marginTop: "var(--sp-3)" }}>
          <ApprovalCard
            questions={QUESTIONS}
            onSubmit={setAnswers}
            onDismiss={() => setAnswers(null)}
            submitLabel="Approve"
          />
        </div>
        {answers && (
          <pre
            style={{
              marginTop: "var(--sp-3)", padding: "var(--sp-3)", overflowX: "auto",
              background: "var(--bg-subtle)", border: "1px solid var(--border)",
              borderRadius: "var(--r-md)", fontFamily: "var(--font-mono)",
              fontSize: "var(--fs-micro)", color: "var(--text-muted)",
            }}
          >
            {JSON.stringify(answers, null, 2)}
          </pre>
        )}
      </section>
    </main>
  );
}
