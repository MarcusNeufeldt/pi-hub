"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { TurnChanges } from "@/lib/session-changes";
import { diffStats } from "@/lib/patch";
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
 * Per-turn diff view for the right panel: a dropdown at the top selects the
 * turn to inspect — "Last Turn" (default) or any earlier turn. The selected
 * turn's files render as split diffs below.
 */
export function PerTurnDiffView({
  turns,
  onOpenFile,
}: {
  turns: TurnChanges[];
  onOpenFile?: (filePath: string, fileName: string) => void;
}) {
  const { t } = useI18n();
  // Index into `turns` (oldest first). 0 = oldest; we display newest-first,
  // so selected === turns.length - 1 - dropdownValue.
  const [selectedIndex, setSelectedIndex] = useState(() =>
    turns.length > 0 ? turns.length - 1 : -1,
  );
  // Diff visibility: expanded by default; "collapse all" shows +/− stats
  // rows with per-file expand.
  const [collapsedAll, setCollapsedAll] = useState(false);
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());

  // Reset per-file expansion when switching turns.
  useEffect(() => {
    setExpandedFiles(new Set());
  }, [selectedIndex]);

  const toggleFile = (file: string) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(file)) next.delete(file);
      else next.add(file);
      return next;
    });
  };

  // Snap back to the last turn when a new turn arrives.
  const latestTurnId = turns.length > 0 ? turns[turns.length - 1].turnId : null;
  useEffect(() => {
    if (latestTurnId) setSelectedIndex(turns.length - 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestTurnId]);

  const totalFiles = turns.reduce((n, turn) => n + turn.files.length, 0);
  const ordered = [...turns].reverse(); // newest first
  const selected =
    selectedIndex >= 0 && selectedIndex < turns.length
      ? turns[selectedIndex]
      : null;

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
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 12px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
        <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--text-muted)", flexShrink: 0 }}>
          {t("changes.title")} ({totalFiles})
        </span>
        <div style={{ flex: 1 }} />
        <button
          onClick={() => setCollapsedAll((v) => !v)}
          title={collapsedAll ? t("changes.expandAll") : t("changes.collapseAll")}
          aria-label={collapsedAll ? t("changes.expandAll") : t("changes.collapseAll")}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 26,
            height: 24,
            padding: 0,
            background: "none",
            border: "1px solid var(--border)",
            borderRadius: 6,
            color: "var(--text-muted)",
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          {collapsedAll ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="7 13 12 18 17 13" />
              <polyline points="7 6 12 11 17 6" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="17 11 12 6 7 11" />
              <polyline points="17 18 12 13 7 18" />
            </svg>
          )}
        </button>
        <select
          value={selectedIndex}
          onChange={(e) => setSelectedIndex(Number(e.target.value))}
          title={t("changes.selectTurn")}
          style={{
            fontSize: 11,
            fontFamily: "var(--font-mono)",
            padding: "3px 6px",
            border: "1px solid var(--border)",
            borderRadius: 6,
            background: "var(--bg-panel)",
            color: "var(--text)",
            cursor: "pointer",
            maxWidth: 180,
            outline: "none",
          }}
        >
          {ordered.map((turn, i) => {
            const isLast = i === 0;
            const label = isLast
              ? `${t("changes.lastTurn")} · ${formatTurnTime(turn.anchorTime)}`
              : `${t("changes.turn")} ${formatTurnTime(turn.anchorTime)}`;
            return (
              <option key={turn.turnId} value={turns.length - 1 - i}>
                {label} · {turn.files.length} {turn.files.length === 1 ? t("changes.file") : t("changes.files")}
              </option>
            );
          })}
        </select>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "8px 10px" }}>
        {selected && (
          <>
            {selected.files.map((c) => {
              const stats = diffStats(c.diff);
              const fileExpanded = !collapsedAll || expandedFiles.has(c.file);
              return (
                <div key={c.file} style={{ marginBottom: fileExpanded ? 10 : 6 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: fileExpanded ? 4 : 0, padding: "0 4px" }}>
                    {collapsedAll && (
                      <button
                        onClick={() => toggleFile(c.file)}
                        title={fileExpanded ? t("changes.collapse") : t("changes.expand")}
                        aria-label={fileExpanded ? t("changes.collapse") : t("changes.expand")}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          width: 16,
                          height: 16,
                          padding: 0,
                          background: "none",
                          border: "none",
                          color: "var(--text-dim)",
                          cursor: "pointer",
                          flexShrink: 0,
                        }}
                      >
                        <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ transform: fileExpanded ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}>
                          <polyline points="3 2 7 5 3 8" />
                        </svg>
                      </button>
                    )}
                    <button
                      onClick={() => (collapsedAll ? toggleFile(c.file) : onOpenFile?.(c.file, getFileName(c.file)))}
                      title={collapsedAll ? (fileExpanded ? t("changes.collapse") : t("changes.expand")) : c.file}
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
                    </button>
                    {collapsedAll && (
                      <button
                        onClick={() => onOpenFile?.(c.file, getFileName(c.file))}
                        title={t("changes.openFile")}
                        aria-label={t("changes.openFile")}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          width: 16,
                          height: 16,
                          padding: 0,
                          background: "none",
                          border: "none",
                          color: "var(--text-dim)",
                          cursor: "pointer",
                          flexShrink: 0,
                        }}
                      >
                        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                          <polyline points="15 3 21 3 21 9" />
                          <line x1="10" y1="14" x2="21" y2="3" />
                        </svg>
                      </button>
                    )}
                    {stats.add > 0 && (
                      <span style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: "#16a34a", flexShrink: 0 }}>
                        +{stats.add}
                      </span>
                    )}
                    {stats.del > 0 && (
                      <span style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: "#ef4444", flexShrink: 0 }}>
                        −{stats.del}
                      </span>
                    )}
                    <span style={{ fontSize: 9, fontFamily: "var(--font-mono)", color: "var(--text-dim)", flexShrink: 0 }}>
                      {c.tool}
                    </span>
                  </div>
                  {fileExpanded && (
                    <div style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
                      <SplitPatchView text={c.diff} />
                    </div>
                  )}
                </div>
              );
            })}
            {selected.files.length === 0 && (
              <div style={{ padding: "14px 8px", fontSize: 11, color: "var(--text-dim)" }}>
                {t("changes.empty")}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
