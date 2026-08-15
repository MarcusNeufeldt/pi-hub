"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { SubagentDelegation } from "@/hooks/useAgentSession";
import type { SubagentTimelineEvent } from "@/lib/subagent-run-view";
import { MarkdownBody } from "./MarkdownBody";

function formatDuration(ms: number | undefined): string {
  // `!ms` also caught 0, so a sub-millisecond run rendered as "no duration".
  if (ms === undefined || ms < 0) return "–";
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Statuses pi-subagents reports for a child that did not finish cleanly. */
const FAILED_STATUSES = new Set(["failed", "timed_out", "interrupted", "cancelled", "error"]);

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
  // `status` is an open string ("timed_out", "interrupted", "queued", …), so
  // treating everything non-"completed" as failed painted pending children red.
  // Only the known-bad states get the cross; anything else stays neutral.
  const failed = FAILED_STATUSES.has(status);
  if (!failed && status !== "completed") {
    return (
      <span
        aria-hidden="true"
        style={{ flexShrink: 0, display: "block", width: 8, height: 8, margin: 2, borderRadius: "50%", border: "1.5px solid var(--text-dim)" }}
      />
    );
  }
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

function formatEventTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "";
}

function ActivityEventRow({ event }: { event: SubagentTimelineEvent }) {
  const { t } = useI18n();
  const [showResult, setShowResult] = useState(false);
  const running = event.phase === "running";
  const failed = event.phase === "failed";
  return (
    <div style={{ display: "grid", gridTemplateColumns: "46px 14px minmax(0, 1fr)", gap: 6, padding: "5px 0", borderBottom: "1px solid color-mix(in srgb, var(--border) 55%, transparent)" }}>
      <span style={{ paddingTop: 1, fontSize: "var(--fs-micro)", fontFamily: "var(--font-mono)", color: "var(--text-dim)" }}>
        {formatEventTime(event.timestamp)}
      </span>
      <span style={{ paddingTop: 1, color: failed ? "#ef4444" : running ? "var(--accent)" : event.kind === "assistant" ? "var(--text-muted)" : "#4ade80" }}>
        {running ? (
          <StatusIndicator status="running" />
        ) : event.kind === "assistant" ? (
          <span style={{ display: "block", width: 7, height: 7, margin: "3px 0 0 2px", borderRadius: "50%", background: "currentColor" }} />
        ) : (
          <StatusIndicator status={failed ? "failed" : "completed"} />
        )}
      </span>
      <div style={{ minWidth: 0 }}>
        {event.kind === "assistant" ? (
          <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: "var(--fs-micro)", fontWeight: 500, lineHeight: 1.5, color: "var(--text-muted)" }}>
            {event.detail}
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
            <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "var(--fs-micro)", fontWeight: event.kind === "tool" ? 600 : 500, fontFamily: event.kind === "tool" ? "var(--font-mono)" : undefined, color: running ? "var(--accent)" : "var(--text-muted)" }}>
              {event.title}
            </span>
            {event.durationMs !== undefined && (
              <span style={{ marginLeft: "auto", flexShrink: 0, fontSize: "var(--fs-micro)", fontFamily: "var(--font-mono)", color: "var(--text-dim)" }}>
                {(event.durationMs / 1000).toFixed(event.durationMs < 10_000 ? 1 : 0)}s
              </span>
            )}
          </div>
        )}
        {event.kind !== "assistant" && event.detail && (
          <div title={event.detail} style={{ marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "var(--fs-micro)", fontFamily: "var(--font-mono)", color: "var(--text-dim)" }}>
            {event.detail}
          </div>
        )}
        {event.result && (
          <button
            onClick={() => setShowResult((value) => !value)}
            style={{ marginTop: 3, padding: 0, background: "none", border: 0, color: "var(--text-dim)", cursor: "pointer", fontSize: "var(--fs-micro)", textTransform: "uppercase", letterSpacing: "0.04em" }}
          >
            {showResult ? t("subagents.hideResult") : t("subagents.showResult")}
          </button>
        )}
        {showResult && event.result && (
          <div style={{ marginTop: 4, maxHeight: 150, overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: "var(--fs-micro)", lineHeight: 1.4, fontFamily: "var(--font-mono)", color: "var(--text-dim)", background: "var(--bg-hover)", borderRadius: 5, padding: 6 }}>
            {event.result}
          </div>
        )}
      </div>
    </div>
  );
}

function ChildCard({ child }: { child: SubagentDelegation["children"][number] }) {
  const { t } = useI18n();
  const running = child.status === "running";
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState<"activity" | "result">(
    running || !child.finalOutput ? "activity" : "result",
  );
  const wasRunningRef = useRef(running);
  const manualTabRef = useRef(false);
  const activityRef = useRef<HTMLDivElement | null>(null);
  const autoFollowRef = useRef(true);
  const events = child.events ?? [];

  useEffect(() => {
    if (wasRunningRef.current && !running && child.finalOutput && !manualTabRef.current) {
      setTab("result");
    }
    wasRunningRef.current = running;
  }, [running, child.finalOutput]);

  useEffect(() => {
    const element = activityRef.current;
    if (expanded && tab === "activity" && autoFollowRef.current && element) {
      element.scrollTop = element.scrollHeight;
    }
  }, [events.length, expanded, tab]);

  const latestEvent = events[events.length - 1];
  const hasDetails = events.length > 0 || Boolean(child.finalOutput || child.task || child.currentTool);

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "8px 10px", background: "var(--bg)", marginBottom: 8 }}>
      <div
        style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 3, cursor: "pointer" }}
        onClick={() => setExpanded((value) => !value)}
        title={expanded ? "Collapse" : "Expand"}
      >
        <StatusIndicator status={child.status} />
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
          {child.agent}
        </span>
        <span style={{ fontSize: "var(--fs-micro)", fontFamily: "var(--font-mono)", color: running ? "var(--accent)" : child.status === "completed" ? "#4ade80" : FAILED_STATUSES.has(child.status) ? "#ef4444" : "var(--text-dim)", flexShrink: 0, textTransform: "uppercase", letterSpacing: "0.04em" }}>
          {child.status}
        </span>
        <span style={{ fontSize: "var(--fs-micro)", fontFamily: "var(--font-mono)", color: "var(--text-dim)", flexShrink: 0 }}>
          {formatDuration(child.durationMs)}
        </span>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--text-dim)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ transform: expanded ? "rotate(90deg)" : "none", transition: "transform 0.15s", flexShrink: 0 }}>
          <polyline points="3 2 7 5 3 8" />
        </svg>
      </div>

      {!expanded && child.task && (
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={child.task}>
          {child.task}
        </div>
      )}
      {!expanded && latestEvent && (
        <div style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 0, fontSize: "var(--fs-micro)", color: latestEvent.phase === "running" ? "var(--accent)" : "var(--text-dim)" }}>
          {latestEvent.phase === "running" && <StatusIndicator status="running" />}
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: latestEvent.kind === "tool" ? "var(--font-mono)" : undefined }}>
            {latestEvent.kind === "assistant" ? latestEvent.detail : latestEvent.title}
          </span>
        </div>
      )}
      {!expanded && !latestEvent && child.recentOutput && (
        <div style={{ fontSize: "var(--fs-micro)", color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={child.recentOutput}>
          {child.recentOutput}
        </div>
      )}

      {expanded && (
        <div style={{ borderTop: "1px solid var(--border)", marginTop: 6, paddingTop: 7 }}>
          {child.task && (
            <div style={{ marginBottom: 8, fontSize: "var(--fs-micro)", color: "var(--text-muted)", lineHeight: 1.45 }}>
              {child.task}
            </div>
          )}

          <div style={{ display: "flex", gap: 3, padding: 2, marginBottom: 7, borderRadius: 6, background: "var(--bg-hover)" }}>
            {(["activity", "result"] as const).map((value) => {
              const disabled = value === "result" && !child.finalOutput;
              return (
                <button
                  key={value}
                  disabled={disabled}
                  onClick={() => {
                    manualTabRef.current = true;
                    setTab(value);
                  }}
                  style={{ flex: 1, padding: "4px 6px", border: 0, borderRadius: 4, background: tab === value ? "var(--bg-panel)" : "transparent", color: disabled ? "var(--text-dim)" : tab === value ? "var(--text)" : "var(--text-muted)", cursor: disabled ? "default" : "pointer", fontSize: "var(--fs-micro)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", boxShadow: tab === value ? "0 1px 3px rgba(0,0,0,.12)" : "none" }}
                >
                  {t(value === "activity" ? "subagents.activity" : "subagents.result")}
                  {value === "activity" && events.length > 0 ? ` ${events.length}` : ""}
                </button>
              );
            })}
          </div>

          {tab === "activity" && (
            <div
              ref={activityRef}
              onScroll={(event) => {
                const element = event.currentTarget;
                autoFollowRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 32;
              }}
              style={{ maxHeight: 360, overflowY: "auto", paddingRight: 3 }}
            >
              {events.map((event) => <ActivityEventRow key={event.id} event={event} />)}
              {events.length === 0 && child.currentTool && (
                <div style={{ display: "flex", gap: 6, alignItems: "center", padding: "7px 2px", fontSize: "var(--fs-micro)", fontFamily: "var(--font-mono)", color: "var(--accent)" }}>
                  <StatusIndicator status="running" />
                  {child.currentTool}{child.currentToolArgs ? ` ${child.currentToolArgs}` : ""}
                </div>
              )}
              {events.length === 0 && !child.currentTool && (
                <div style={{ padding: "8px 2px", fontSize: "var(--fs-micro)", color: "var(--text-dim)" }}>
                  {hasDetails ? t("subagents.waitingActivity") : t("subagents.noActivity")}
                </div>
              )}
            </div>
          )}

          {tab === "result" && child.finalOutput && (
            <div style={{ fontSize: 11, lineHeight: 1.5, overflowWrap: "anywhere" }}>
              <MarkdownBody className="markdown-custom-message">{child.finalOutput}</MarkdownBody>
              {child.outputPath && (
                <div title={child.outputPath} style={{ marginTop: 9, paddingTop: 7, borderTop: "1px solid var(--border)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "var(--fs-micro)", fontFamily: "var(--font-mono)", color: "var(--text-dim)" }}>
                  {t("subagents.saved")}: {child.outputPath.split(/[\\/]/).pop()}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {(child.toolCount !== undefined || child.turnCount !== undefined || child.tokens !== undefined || child.model) && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "2px 8px", fontSize: "var(--fs-micro)", color: "var(--text-dim)", marginTop: expanded ? 8 : 4 }}>
          {child.tokens !== undefined && <span>{child.tokens.toLocaleString()} tok</span>}
          {child.toolCount !== undefined && <span>{child.toolCount} tools</span>}
          {child.turnCount !== undefined && <span>{child.turnCount} turns</span>}
          {child.model && <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{child.model}</span>}
        </div>
      )}
    </div>
  );
}

/** Embedded subagent fleet view for the right panel. */
export function SubagentsView({
  delegations,
  onOpenTranscript,
  onClear,
}: {
  delegations: SubagentDelegation[];
  onOpenTranscript?: (sessionId: string) => void;
  onClear?: () => void;
}) {
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
          <span style={{ display: "flex", alignItems: "center", gap: 5, fontSize: "var(--fs-micro)", color: "var(--accent)" }}>
            <StatusIndicator status="running" />
            {runningChildren} {t("subagents.running")}
          </span>
        )}
        <div style={{ flex: 1 }} />
        {delegations.length > 0 && onClear && (
          <button
            onClick={onClear}
            title={t("subagents.clear")}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              padding: "2px 7px",
              background: "none",
              border: "1px solid var(--border)",
              borderRadius: 5,
              color: "var(--text-dim)",
              cursor: "pointer",
              fontSize: "var(--fs-micro)",
              fontWeight: 600,
              letterSpacing: "0.03em",
              textTransform: "uppercase",
            }}
          >
            <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
              <path d="M10 11v6M14 11v6" />
              <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
            </svg>
            {t("subagents.clear")}
          </button>
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
            {(d.children.length > 1 || d.task) && d.task && (
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 5, padding: "0 2px" }}>
                <div style={{ flex: 1, minWidth: 0, fontSize: "var(--fs-micro)", fontFamily: "var(--font-mono)", color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={d.task}>
                  {d.task}
                </div>
                {d.transcriptSessionId && onOpenTranscript && (
                  <button
                    onClick={() => onOpenTranscript(d.transcriptSessionId!)}
                    title={t("subagents.transcript")}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 4,
                      flexShrink: 0,
                      padding: "2px 7px",
                      background: "var(--bg-hover)",
                      border: "1px solid var(--border)",
                      borderRadius: 5,
                      color: "var(--accent)",
                      cursor: "pointer",
                      fontSize: "var(--fs-micro)",
                      fontWeight: 600,
                      letterSpacing: "0.03em",
                      textTransform: "uppercase",
                    }}
                  >
                    {t("subagents.transcript")}
                    <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                      <polyline points="15 3 21 3 21 9" />
                      <line x1="10" y1="14" x2="21" y2="3" />
                    </svg>
                  </button>
                )}
              </div>
            )}
            {/* Keyed by child id, not agent name: a fanout names every child
                after the same agent, so names collided and React shuffled each
                card's expanded/tab state between siblings. */}
            {d.children.map((c, index) => (
              <ChildCard key={`${d.toolCallId}:${c.id ?? index}`} child={c} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// re-export for the hook's state type usage in AppShell
export type { SubagentDelegation };
