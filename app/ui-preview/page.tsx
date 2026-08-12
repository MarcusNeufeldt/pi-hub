"use client";

import { useRef, useState } from "react";

import { ApprovalCard, type ApprovalAnswers } from "@/components/ApprovalCard";
import { ProcessDetailsGroup } from "@/components/ChatWindow";
import { LoadingState, type LoadingVariant } from "@/components/LoadingState";
import { MessageView, ThinkingBlock } from "@/components/MessageView";
import { SelectionActions } from "@/components/SelectionActions";
import { I18nProvider, useI18n } from "@/hooks/useI18n";
import { summarizeProcess } from "@/lib/message-display";
import { composeWithContext } from "@/lib/selection-context";
import type { AssistantMessage, ToolResultMessage } from "@/lib/types";

/**
 * Preview harness for the components ported from Beautiful UI. Not linked from
 * the app — it exists so the ported pieces can be judged against the real theme,
 * in both colour schemes, before any of them is wired into the chat.
 */

const SAMPLE = `Pistachio holds the top slot all weekend. Churn it first thing Saturday so the
batch has time to firm up before the afternoon rush. Select any part of this
paragraph to raise the action bar.`;

/** Same glyphs toolRowIcon derives from a tool name, keyed for the preview. */
const TOOL_ICONS: Record<string, React.ReactNode> = {
  read: (
    <svg className="tool-row__icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 3v5h5" /><path d="M19 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z" />
    </svg>
  ),
  edit: (
    <svg className="tool-row__icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 20h4L20 8l-4-4L4 16v4z" />
    </svg>
  ),
  bash: (
    <svg className="tool-row__icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 17l5-5-5-5" /><path d="M13 19h7" />
    </svg>
  ),
  search: (
    <svg className="tool-row__icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" />
    </svg>
  ),
};

/** A plausible turn: several reads, a search, an edit, a failure, one still live. */
const TOOL_TRACE = [
  { icon: "read", name: "read", target: "components/MessageView.tsx", seconds: 0.2, running: false, error: false },
  { icon: "read", name: "read", target: "app/globals.css", seconds: 0.1, running: false, error: false },
  { icon: "search", name: "grep", target: "think-step|tool-block  ·  2 files", seconds: 0.4, running: false, error: false },
  { icon: "edit", name: "edit", target: "app/globals.css  ·  +34 −2", seconds: 0.3, running: false, error: false },
  { icon: "bash", name: "bash", target: "npx tsc --noEmit", seconds: 11.4, running: false, error: true },
  { icon: "bash", name: "bash", target: "npx eslint components/", seconds: null, running: true, error: false },
];

/**
 * Shaped like the real thing: measurement over 78 thinking blocks from recent
 * sessions found a median of 2 blank-line-separated paragraphs (up to 5) and a
 * median of zero single newlines, with a short opener followed by longer bodies.
 * Four steps here so the connector between markers is visible.
 */
const THINKING_SAMPLE = [
  "Let me check what the config actually contains before changing it.",
  "The provider entry resolves its key from an environment variable, so the value never lands in the file itself. That matters because the file is readable and the key is not supposed to be.",
  "One risk: the running server reads the environment at process start, so a value exported after launch will not be visible to it. That would look like the provider being missing rather than unauthenticated, which is a confusing failure to debug.",
  "So the order is: write the entry, set the variable, restart, then confirm the models appear. Verifying before the restart would report a false negative.",
].join("\n\n");

/**
 * A process group built from the real components, timed the way real sessions are.
 *
 * The numbers come from one measured session: generation of several seconds per
 * step, tool execution under a second except for one genuinely slow command. Under
 * the old anchoring every one of those rows would have read as the generation time
 * plus the execution time — 12s where the tool took none of it.
 */
const PROCESS_MODEL_NAMES = { "opencode-go:deepseek-v4-flash": "DeepSeek V4 Flash (2x usage)" };

const PROCESS_STEPS = [
  { generateMs: 4_000, executeMs: 300, command: "ls /f/explore/pi-hub/ | head -30" },
  { generateMs: 9_000, executeMs: 90_000, command: "grep -rln --exclude-dir=node_modules 'Rename unnamed sessions' ." },
  { generateMs: 6_000, executeMs: 400, command: "cat modules/scheduler/paths.ts | head -40" },
  { generateMs: 5_000, executeMs: 200, command: "sqlite3 ~/.pi/hub/app.db 'SELECT * FROM scheduled_tasks;'" },
];

const PROCESS_TRACE = (() => {
  const messages: AssistantMessage[] = [];
  const toolResults = new Map<string, ToolResultMessage>();
  // Fixed epoch: a preview that moved with the clock could not be compared
  // between reloads.
  let clock = 1_786_514_978_050;

  PROCESS_STEPS.forEach((step, index) => {
    const startedAt = clock;
    const endedAt = startedAt + step.generateMs;
    const toolCallId = `preview-call-${index}`;
    messages.push({
      role: "assistant",
      model: "deepseek-v4-flash",
      provider: "opencode-go",
      timestamp: startedAt,
      endedAt,
      usage: { input: 2_100, output: 180, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0004 } },
      content: [
        { type: "thinking", thinking: THINKING_SAMPLE.split("\n\n").slice(0, 2).join("\n\n") },
        { type: "toolCall", toolCallId, toolName: "bash", input: { command: step.command } },
      ],
    });
    toolResults.set(toolCallId, {
      role: "toolResult",
      toolCallId,
      toolName: "bash",
      content: [{ type: "text", text: "(output elided for the preview)" }],
      timestamp: endedAt + step.executeMs,
    });
    clock = endedAt + step.executeMs + 5;
  });

  const summary = summarizeProcess(
    messages.map((message) => ({ message, countCost: true })),
    toolResults,
    PROCESS_MODEL_NAMES,
  );
  return { messages, toolResults, summary };
})();

function ProcessTracePreview() {
  // useI18n has to run below the provider, so this cannot be inlined into the
  // page component that mounts it.
  const { t } = useI18n();
  return (
    <div style={{ maxWidth: 620, marginTop: "var(--sp-3)" }}>
      <ProcessDetailsGroup messageCount={PROCESS_TRACE.messages.length} summary={PROCESS_TRACE.summary} t={t}>
        {PROCESS_TRACE.messages.map((message, index) => (
          <MessageView
            key={index}
            message={message}
            meta="none"
            toolResults={PROCESS_TRACE.toolResults}
            modelNames={PROCESS_MODEL_NAMES}
          />
        ))}
      </ProcessDetailsGroup>
    </div>
  );
}

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
    // The real components read translations, and I18nProvider is mounted in
    // app/page.tsx rather than the root layout — so this route has to supply it
    // itself or every t() call throws.
    <I18nProvider>
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
        <h2 style={{ fontSize: "var(--fs-ui)", color: "var(--text-muted)" }}>Process group</h2>
        <p style={{ fontSize: "var(--fs-micro)", color: "var(--text-dim)", marginTop: 4, maxWidth: 620 }}>
          One turn&apos;s intermediate steps behind a single line. The header states the
          model, tool count, elapsed time and cost once; the steps inside repeat none
          of it — before, each of the four printed its own model name, token count and
          cost. Expand it: the bar under each row is that row&apos;s share of the elapsed
          time, so the one slow command is visible without reading a number.
        </p>
        <ProcessTracePreview />
      </section>

      <section style={{ marginTop: "var(--sp-7)" }}>
        <h2 style={{ fontSize: "var(--fs-ui)", color: "var(--text-muted)" }}>Tool trace</h2>
        <p style={{ fontSize: "var(--fs-micro)", color: "var(--text-dim)", marginTop: 4 }}>
          The row treatment: type glyph, mono name, truncated target, right-aligned
          duration, and a ring spinner on the row that is still running. Scan the glyph
          column to see the shape of a turn without reading any of it.
        </p>
        <div style={{ marginTop: "var(--sp-3)", display: "flex", flexDirection: "column", gap: 2, maxWidth: 560 }}>
          {TOOL_TRACE.map((row) => (
            <div
              key={row.name + row.target}
              className={`tool-block${row.error ? " tool-block--error" : row.running ? " tool-block--running" : ""}`}
            >
              <div className="tool-block__header" style={{ cursor: "default" }}>
                {row.running
                  ? <span className="tool-row__spinner" aria-hidden="true" />
                  : TOOL_ICONS[row.icon]}
                <span style={{ color: row.error ? "var(--danger)" : "var(--text)", fontFamily: "var(--font-mono)", fontWeight: 600, fontSize: "var(--fs-meta)", flexShrink: 0 }}>
                  {row.name}
                </span>
                <span style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: "var(--fs-micro)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
                  {row.target}
                </span>
                {row.seconds !== null && (
                  <span style={{ fontSize: "var(--fs-micro)", color: "var(--text-dim)", flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>{row.seconds}s</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section style={{ marginTop: "var(--sp-7)" }}>
        <h2 style={{ fontSize: "var(--fs-ui)", color: "var(--text-muted)" }}>Thinking trace</h2>
        <p style={{ fontSize: "var(--fs-micro)", color: "var(--text-dim)", marginTop: 4 }}>
          Same text, same classes. Left is one pre-wrap blob; right splits on the blank
          lines the model already wrote and puts each on the rail.
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "var(--sp-5)", marginTop: "var(--sp-3)" }}>
          <div>
            <span className="ui-label">Before</span>
            {/* Reproduces the previous rendering exactly: the same wrapper and body
                classes, minus the step markup. Not the live component, so the
                comparison keeps working after ThinkingBlock changes again. */}
            <div className="think-block" style={{ marginTop: 6 }}>
              <div className="think-block__header" style={{ cursor: "default" }}>
                <span>Thinking</span>
                <span style={{ marginLeft: "auto", fontSize: "var(--fs-micro)", color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}>4s</span>
              </div>
              <div className="think-block__body">{THINKING_SAMPLE}</div>
            </div>
          </div>
          <div>
            <span className="ui-label">After</span>
            <div style={{ marginTop: 6 }}>
              <ThinkingBlock
                block={{ type: "thinking", thinking: THINKING_SAMPLE }}
                durationMs={4200}
                defaultExpanded
                blockIndex={0}
              />
            </div>
          </div>
        </div>

        <p style={{ fontSize: "var(--fs-micro)", color: "var(--text-dim)", marginTop: "var(--sp-4)" }}>
          While a turn is streaming the trailing marker pulses, because that step is
          the one still being written. Collapse and reopen either panel to see it
          animate to its own height rather than snapping.
        </p>
        <div style={{ maxWidth: 460, marginTop: 6 }}>
          <ThinkingBlock
            block={{ type: "thinking", thinking: THINKING_SAMPLE }}
            durationMs={2000}
            isStreaming
            defaultExpanded
            blockIndex={1}
          />
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
          onAction={(selection, intent) => setHanded(
            // Shows what the composer would receive: the message as it would be
            // sent, with the attached selection already prefixed.
            composeWithContext([selection], intent.instruction ?? ""),
          )}
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
    </I18nProvider>
  );
}
