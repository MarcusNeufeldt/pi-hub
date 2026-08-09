"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import {
  listRecentRuns,
  listTasks,
  type RunSummaryDto,
  type TaskDto,
} from "@/lib/scheduler-client";

const TASKS_POLL_MS = 15_000;

const STATUS_COLORS: Record<TaskDto["status"], string> = {
  active: "#16a34a",
  paused: "#d97706",
  completed: "var(--text-dim)",
};

function runStatusColor(status: RunSummaryDto["status"]): string {
  if (status === "success") return "#16a34a";
  if (status === "failed" || status === "missed") return "#ef4444";
  if (status === "running") return "#4ade80";
  if (status === "queued") return "#60a5fa";
  return "var(--text-dim)";
}

function formatRunTime(run: RunSummaryDto): string {
  const value = run.finishedAt ?? run.startedAt ?? run.queuedAt;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const minutes = Math.max(0, Math.round((Date.now() - date.getTime()) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function formatNextRun(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  const diff = date.getTime() - Date.now();
  if (diff <= 0) return date.toLocaleString([], { dateStyle: "short", timeStyle: "short" });
  const minutes = Math.max(1, Math.round(diff / 60_000));
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

function TaskRow({ task, onOpen }: { task: TaskDto; onOpen: () => void }) {
  const { t } = useI18n();
  const statusLabel = t(`task.status.${task.status}` as
    | "task.status.active"
    | "task.status.paused"
    | "task.status.completed");
  const lastRun = task.lastRun?.status;
  const lastRunColor = lastRun === "success"
    ? "#16a34a"
    : lastRun === "failed" || lastRun === "missed"
      ? "#ef4444"
      : lastRun === "running"
        ? "#4ade80"
        : "var(--text-dim)";

  return (
    <button
      onClick={onOpen}
      title={`${task.name}\n${task.cwd}`}
      style={{
        width: "100%",
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "7px 10px 7px 14px",
        background: "transparent",
        border: "none",
        cursor: "pointer",
        textAlign: "left",
      }}
      onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; }}
      onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; }}
    >
      <span style={{ position: "relative", width: 9, height: 9, flexShrink: 0 }}>
        <span style={{ display: "block", width: 8, height: 8, borderRadius: "50%", background: STATUS_COLORS[task.status] }} />
        {lastRun && (
          <span style={{ position: "absolute", right: -2, bottom: -2, width: 4, height: 4, borderRadius: "50%", background: lastRunColor, border: "1px solid var(--bg-panel)" }} />
        )}
      </span>
      <span style={{ minWidth: 0, flex: 1 }}>
        <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, color: "var(--text)" }}>
          {task.name}
        </span>
        <span style={{ display: "flex", gap: 6, marginTop: 2, minWidth: 0, fontSize: 10, color: "var(--text-dim)" }}>
          <span>{statusLabel}</span>
          {task.status === "active" && <span>{formatNextRun(task.nextRunAt)}</span>}
        </span>
      </span>
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--text-dim)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
        <polyline points="3 2 7 5 3 8" />
      </svg>
    </button>
  );
}

function RecentRunRow({ run, onOpen }: { run: RunSummaryDto; onOpen: () => void }) {
  const { t } = useI18n();
  const statusLabel = run.status === "success"
    ? t("task.runs.success")
    : run.status === "failed"
      ? t("task.runs.failed")
      : run.status === "running"
        ? t("task.runs.running")
        : run.status === "queued"
          ? t("task.runs.queued")
          : run.status === "cancelled"
            ? t("task.runs.cancelled")
            : run.status === "interrupted"
              ? t("task.runs.interrupted")
              : run.status === "skipped"
                ? t("task.runs.skipped")
                : run.status === "missed"
                  ? t("task.runs.missed")
                  : t("task.runs.timeout");

  return (
    <button
      onClick={onOpen}
      title={`${run.taskNameSnapshot} · ${statusLabel}`}
      style={{
        width: "100%",
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 10px 6px 14px",
        background: "transparent",
        border: "none",
        cursor: "pointer",
        textAlign: "left",
      }}
      onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; }}
      onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; }}
    >
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: runStatusColor(run.status), flexShrink: 0 }} />
      <span style={{ minWidth: 0, flex: 1 }}>
        <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11, color: "var(--text)" }}>
          {run.taskNameSnapshot}
        </span>
        <span style={{ display: "flex", gap: 6, marginTop: 1, fontSize: 10, color: "var(--text-dim)" }}>
          <span>{statusLabel}</span>
          <span>{formatRunTime(run)}</span>
        </span>
      </span>
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--text-dim)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
        <polyline points="3 2 7 5 3 8" />
      </svg>
    </button>
  );
}

export function SidebarTasks({
  refreshKey,
  onOpenTasks,
  onOpenSession,
}: {
  refreshKey?: number;
  onOpenTasks: (taskId?: string) => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(true);
  const [tasks, setTasks] = useState<TaskDto[]>([]);
  const [runs, setRuns] = useState<RunSummaryDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [taskResult, runResult] = await Promise.all([
        listTasks(),
        listRecentRuns(5).catch(() => null),
      ]);
      setTasks(taskResult.items);
      if (runResult) setRuns(runResult.items.filter((run) => Boolean(run.sessionId)));
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const schedule = () => {
      if (timer) clearTimeout(timer);
      if (!stopped && document.visibilityState === "visible") {
        timer = setTimeout(async () => {
          await refresh();
          schedule();
        }, TASKS_POLL_MS);
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void refresh();
      schedule();
    };
    schedule();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [refresh]);

  return (
    <div style={{ borderTop: "1px solid var(--border)", display: "flex", flexDirection: "column", flex: open ? "1 1 0" : "0 0 auto", minHeight: 0, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
        <button
          onClick={() => setOpen((value) => !value)}
          style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, padding: "7px 10px", background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 11, fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase", textAlign: "left" }}
        >
          <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 0.15s", flexShrink: 0 }}>
            <polyline points="3 2 7 5 3 8" />
          </svg>
          <span>{t("common.tasks")}</span>
          {!loading && <span style={{ color: "var(--text-dim)", fontWeight: 400 }}>({tasks.length})</span>}
        </button>
        <button
          onClick={() => onOpenTasks()}
          title={t("task.title")}
          aria-label={t("task.title")}
          style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, marginRight: 7, padding: 0, background: "none", border: "none", borderRadius: 5, color: "var(--text-dim)", cursor: "pointer" }}
          onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; }}
          onMouseLeave={(event) => { event.currentTarget.style.background = "none"; }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </div>
      {open && (
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden", paddingBottom: 4 }}>
          {loading ? (
            <div style={{ padding: "12px 14px", fontSize: 11, color: "var(--text-dim)" }}>{t("task.load.loading")}</div>
          ) : error ? (
            <button onClick={() => void refresh()} style={{ margin: "6px 10px", padding: "6px 8px", background: "none", border: "1px solid var(--border)", borderRadius: 5, color: "#ef4444", cursor: "pointer", fontSize: 11 }}>
              {t("task.load.retry")}
            </button>
          ) : (
            <>
              {tasks.length === 0 ? (
                <button onClick={() => onOpenTasks()} style={{ margin: "6px 10px", padding: "8px", width: "calc(100% - 20px)", background: "var(--bg-hover)", border: "1px dashed var(--border)", borderRadius: 6, color: "var(--text-muted)", cursor: "pointer", fontSize: 11 }}>
                  {t("task.empty.create")}
                </button>
              ) : tasks.map((task) => (
                <TaskRow key={task.id} task={task} onOpen={() => onOpenTasks(task.id)} />
              ))}
              {runs.length > 0 && (
                <div style={{ marginTop: 5, paddingTop: 5, borderTop: "1px solid var(--border)" }}>
                  <div style={{ padding: "3px 14px 4px", color: "var(--text-dim)", fontSize: 10, fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase" }}>
                    {t("task.runs.recent")}
                  </div>
                  {runs.map((run) => (
                    <RecentRunRow
                      key={run.id}
                      run={run}
                      onOpen={() => run.sessionId && onOpenSession(run.sessionId)}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
