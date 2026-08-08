"use client";

import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { TurnChanges } from "@/lib/session-changes";
import { SplitPatchView } from "./MessageView";

function formatTurnTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function getFileName(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] || filePath;
}

/**
 * Per-turn diff view for the right panel: session changes grouped by turn,
 * newest first. Latest turn starts expanded; older turns collapse.
 */
export function PerTurnDiffView({
  turns,
  onOpenFile,
}: {
  turns: TurnChanges[];
  onOpenFile?: (filePath: string, fileName: string) => void;
}) {
  const { t } = useI18n();
  const [expandedTurns, setExpandedTurns] = useState<Set<string>>(() => {
    // Latest turn expanded by default.
    const latest = turns.length > 0 ? turns[turns.length - 1].turnId : null;
    return new Set(latest ? [latest] : []);
  });

  const ordered = [...turns].reverse(); // newest first
  const totalFiles = turns.reduce((n, turn) => n + turn.files.length, 0);

  if (turns.length === 0) {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, color: "var(--text-dim)", fontSize: 12, padding: 24, textAlign: "center" }}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="16 18 22 12 16 6" />
          <polyline points="8 6 2 12 8 18" />
        </svg>
        {t("changes.empty")}
      </div>
    );
  }

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "8px 12px", fontSize: 11, fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--text-muted)", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
        {t("changes.title")} ({totalFiles})
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "8px 10px" }}>
        {ordered.map((turn) => {
          const expanded = expandedTurns.has(turn.turnId);
          return (
            <div key={turn.turnId} style={{ marginBottom: 10 }}>
              <button
                onClick={() =>
                  setExpandedTurns((prev) => {
                    const next = new Set(prev);
                    if (next.has(turn.turnId)) next.delete(turn.turnId);
                    else next.add(turn.turnId);
                    return next;
                  })
                }
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  width: "100%",
                  padding: "6px 8px",
                  background: "var(--bg-hover)",
                  border: "1px solid var(--border)",
                  borderRadius: 7,
                  color: "var(--text)",
                  cursor: "pointer",
                  fontSize: 11,
                  textAlign: "left",
                  marginBottom: expanded ? 6 : 0,
                }}
              >
                <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ transform: expanded ? "rotate(90deg)" : "none", transition: "transform 0.15s", flexShrink: 0 }}>
                  <polyline points="3 2 7 5 3 8" />
                </svg>
                <span style={{ fontWeight: 600, flexShrink: 0 }}>
                  {t("changes.turn")} {formatTurnTime(turn.anchorTime)}
                </span>
                <span style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 10, flexShrink: 0 }}>
                  {turn.files.length} {turn.files.length === 1 ? t("changes.file") : t("changes.files")}
                </span>
              </button>
              {expanded && (
                <div>
                  {turn.files.map((c) => (
                    <div key={c.file} style={{ marginBottom: 8 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3, padding: "0 4px" }}>
                        <button
                          onClick={() => onOpenFile?.(c.file, getFileName(c.file))}
                          title={c.file}
                          style={{
                            flex: 1,
                            minWidth: 0,
                            display: "flex",
                            alignItems: "center",
                            gap: 5,
                            background: "none",
                            border: "none",
                            padding: 0,
                            color: "var(--accent)",
                            cursor: "pointer",
                            fontSize: 11,
                            fontFamily: "var(--font-mono)",
                            textAlign: "left",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {getFileName(c.file)}
                          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: 0.7 }}>
                            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                            <polyline points="15 3 21 3 21 9" />
                            <line x1="10" y1="14" x2="21" y2="3" />
                          </svg>
                        </button>
                        <span style={{ fontSize: 9, fontFamily: "var(--font-mono)", color: "var(--text-dim)", flexShrink: 0 }}>
                          {c.tool}
                        </span>
                      </div>
                      <div style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
                        <SplitPatchView text={c.diff} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
