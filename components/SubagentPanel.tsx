"use client";

import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { SubagentDelegation } from "@/hooks/useAgentSession";

function formatDuration(ms: number | undefined): string {
  if (!ms || ms < 0) return "–";
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function StatusIndicator({ status }: { status: string }) {
  if (status === "running") {
    return (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ flexShrink: 0, color: "var(--accent)" }}>
        <g>
          <path
            d="M21 12a9 9 0 1 1-3.8-7.4"
            stroke="currentColor"
            strokeWidth="2.8"
            strokeLinecap="round"
          />
          <animateTransform
            attributeName="transform"
            type="rotate"
            from="0 12 12"
            to="360 12 12"
            dur="0.9s"
            repeatCount="indefinite"
          />
        </g>
      </svg>
    );
  }
  const failed = status !== "completed";
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={failed ? "#ef4444" : "#4ade80"} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      {failed ? (
        <>
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </>
      ) : (
        <polyline points="20 6 9 17 4 12" />
      )}
    </svg>
  );
}

function ChildCard({ child }: { child: SubagentDelegation["children"][number] }) {
  const running = child.status === "running";
  const [expanded, setExpanded] = useState(false);
  const tools = child.recentTools ?? [];
  const outputLines = child.recentOutputLines ?? [];
  const hasDetail = tools.length > 0 || outputLines.length > 1 || child.thinking;
  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: "8px 10px",
        background: "var(--bg)",
        marginBottom: 8,
      }}
    >
      <div
        style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 3, cursor: hasDetail ? "pointer" : "default" }}
        onClick={() => hasDetail && setExpanded((v) => !v)}
        title={hasDetail ? (expanded ? "Collapse" : "Expand") : undefined}
      >
        <StatusIndicator status={child.status} />
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
          {child.agent}
        </span>
        <span style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--text-dim)", flexShrink: 0 }}>
          {formatDuration(child.durationMs)}
        </span>
        {hasDetail && (
          <svg
            width="10" height="10" viewBox="0 0 10 10" fill="none"
            stroke="var(--text-dim)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
            style={{ transform: expanded ? "rotate(90deg)" : "none", transition: "transform 0.15s", flexShrink: 0 }}
          >
            <polyline points="3 2 7 5 3 8" />
          </svg>
        )}
      </div>
      {child.task && (
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={child.task}>
          {child.task}
        </div>
      )}
      {!expanded && running && child.currentTool && (
        <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 3, fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--accent)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
          </svg>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {child.currentTool}
            {child.currentToolArgs ? ` ${child.currentToolArgs.slice(0, 60)}` : ""}
          </span>
        </div>
      )}
      {!expanded && tools.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 3 }}>
          {tools.slice(-3).map((t, i) => (
            <span
              key={i}
              style={{
                fontSize: 9, fontFamily: "var(--font-mono)",
                padding: "1px 5px", borderRadius: 4,
                background: "var(--bg-hover)", color: "var(--text-muted)",
                maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}
              title={t.args ?? t.tool}
            >
              {t.tool}
            </span>
          ))}
        </div>
      )}
      {!expanded && child.recentOutput && (
        <div style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--text-dim)", marginBottom: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={child.recentOutput}>
          {child.recentOutput}
        </div>
      )}
      {expanded && (
        <div style={{ borderTop: "1px solid var(--border)", marginTop: 5, paddingTop: 6 }}>
          {tools.length > 0 && (
            <div style={{ marginBottom: 6 }}>
              <div style={{ fontSize: 9, fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--text-dim)", marginBottom: 3 }}>
                Tools
              </div>
              {tools.map((t, i) => (
                <div key={i} style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--text-muted)", marginBottom: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={t.args ?? t.tool}>
                  <span style={{ color: "var(--accent)" }}>{t.tool}</span>
                  {t.args ? <span style={{ color: "var(--text-dim)" }}> {t.args.slice(0, 100)}</span> : null}
                </div>
              ))}
            </div>
          )}
          {outputLines.length > 0 && (
            <div style={{ marginBottom: 6 }}>
              <div style={{ fontSize: 9, fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--text-dim)", marginBottom: 3 }}>
                Output
              </div>
              {outputLines.slice(-8).map((line, i) => (
                <div key={i} style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--text-dim)", marginBottom: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={line}>
                  {line}
                </div>
              ))}
            </div>
          )}
          {child.thinking && (
            <div>
              <div style={{ fontSize: 9, fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--text-dim)", marginBottom: 3 }}>
                Thinking
              </div>
              <div style={{ fontSize: 10, color: "var(--text-muted)", lineHeight: 1.45, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={child.thinking}>
                {child.thinking}
              </div>
            </div>
          )}
        </div>
      )}
      {(child.toolCount !== undefined || child.tokens !== undefined || child.model) && (
        <div style={{ display: "flex", gap: 8, fontSize: 10, color: "var(--text-dim)", marginTop: expanded ? 6 : 0 }}>
          {child.tokens !== undefined && <span>{child.tokens.toLocaleString()} tok</span>}
          {child.toolCount !== undefined && <span>{child.toolCount} tools</span>}
          {child.model && <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{child.model}</span>}
        </div>
      )}
    </div>
  );
}

/** Embedded subagent fleet view for the right panel. */
export function SubagentsView({ delegations }: { delegations: SubagentDelegation[] }) {
  const { t } = useI18n();
  const runningChildren = delegations.reduce(
    (n, d) => n + d.children.filter((c) => c.status === "running").length,
    0,
  );

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 12px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
        <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--text-muted)" }}>
          {t("subagents.title")}
        </span>
        {runningChildren > 0 && (
          <span style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10, color: "var(--accent)" }}>
            <StatusIndicator status="running" />
            {runningChildren} {t("subagents.running")}
          </span>
        )}
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "10px 10px 4px" }}>
        {delegations.length === 0 && (
          <div style={{ padding: "14px 8px", fontSize: 11, color: "var(--text-dim)" }}>
            {t("subagents.empty")}
          </div>
        )}
        {delegations.map((d) => (
          <div key={d.toolCallId} style={{ marginBottom: 4 }}>
            {d.children.length > 1 && d.task && (
              <div style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--text-dim)", marginBottom: 5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={d.task}>
                {d.task}
              </div>
            )}
            {d.children.map((c) => (
              <ChildCard key={`${d.toolCallId}:${c.agent}`} child={c} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// re-export for the hook's state type usage in AppShell
export type { SubagentDelegation };
