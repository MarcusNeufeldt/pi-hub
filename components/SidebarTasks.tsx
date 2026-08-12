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

/**
 * Status colours come from the theme, not from fixed hex values.
 *
 * These were hardcoded (#16a34a, #ef4444, #4ade80, #60a5fa), which meant a task
 * row kept mid-tone greens and reds regardless of scheme: too dark against the
 * dark canvas and too saturated against the light one, and immune to any future
 * palette change. --success and --danger already carry a per-scheme value.
 */
const STATUS_COLORS: Record<TaskDto["status"], string> = {
  active: "var(--success)",
  paused: "var(--accent)",
  completed: "var(--text-dim)",
};

function runStatusColor(status: RunSummaryDto["status"]): string {
  if (status === "success" || status === "running") return "var(--success)";
  if (status === "failed" || status === "missed") return "var(--danger)";
  // Queued is waiting, not healthy or broken; it should not borrow either colour.
  if (status === "queued") return "var(--text-muted)";
  return "var(--text-dim)";
}

/** Wash matching the status colour, for chips that tint their whole box. */
function runStatusTint(status: RunSummaryDto["status"]): string | undefined {
  if (status === "success") return "var(--tint-success)";
  if (status === "failed" || status === "missed") return "var(--tint-danger)";
  if (status === "running") return "var(--tint-accent)";
  return undefined;
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
  // A run in flight is the most important thing this row can say, and it was not
  // being said: the meta line showed task.status ("Active") plus the next-run
  // countdown ("in 15h") even while the task was executing, and "running" existed
  // only as a 4px sub-dot. While running, the label becomes "Running" and the
  // countdown is suppressed — the next scheduled run is noise mid-execution.
  const isRunning = lastRun === "running";
  // Same theme-driven mapping as the list above, rather than a second copy of the
  // hex values it was duplicating.
  const lastRunColor = lastRun ? runStatusColor(lastRun) : "var(--text-dim)";
  const lastRunTint = lastRun ? runStatusTint(lastRun) : undefined;

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
        <span
          className={`task-dot${isRunning ? " task-dot--running" : ""}`}
          style={isRunning ? undefined : { background: STATUS_COLORS[task.status] }}
        />
        {/* The last-run sub-dot is redundant while running — the main dot is
            already buzzing green for exactly that reason. */}
        {lastRun && !isRunning && (
          <span style={{ position: "absolute", right: -2, bottom: -2, width: 4, height: 4, borderRadius: "50%", background: lastRunColor, border: "1px solid var(--bg-panel)" }} />
        )}
      </span>
      <span style={{ minWidth: 0, flex: 1 }}>
        <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, color: "var(--text)" }}>
          {task.name}
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, marginTop: 2, fontSize: "var(--fs-micro)", color: "var(--text-dim)" }}>
          {/* The outcome carries a tint so it reads as a state at a glance down a
              long list, instead of relying on a 4px dot and coloured text. Rows
              with no outcome yet stay plain — an untinted row is information too. */}
          <span
            className="ui-chip ui-chip--static"
            style={{
              flexShrink: 0,
              paddingInline: 5,
              lineHeight: 1.5,
              fontSize: "var(--fs-micro)",
              fontWeight: 500,
              color: isRunning ? "var(--success)" : lastRunTint ? lastRunColor : "var(--text-dim)",
              background: isRunning ? "var(--tint-accent)" : lastRunTint,
            }}
          >
            {isRunning ? t("task.runs.running") : statusLabel}
          </span>
          {!isRunning && task.status === "active" && <span>{formatNextRun(task.nextRunAt)}</span>}
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
        <span style={{ display: "flex", gap: 6, marginTop: 1, fontSize: "var(--fs-micro)", color: "var(--text-dim)" }}>
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
  // Collapsed by default, like Recent. The header's live light means you can see
  // that a task is working without expanding the section.
  const [open, setOpen] = useState(false);
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

  // "A task is active" means a run is in flight, not TaskDto.status === "active"
  // — that only means un-paused, so it would light permanently for any enabled
  // task and stop signalling anything. Both sources are checked because the runs
  // list is filtered to entries that already have a sessionId, so a just-started
  // run can be missing from it while task.lastRun already reports "running".
  const hasRunningTask = tasks.some((task) => task.lastRun?.status === "running")
    || runs.some((run) => run.status === "running");

  return (
    <div style={{ borderTop: "1px solid var(--border)", display: "flex", flexDirection: "column", flex: open ? "1 1 0" : "0 0 auto", minHeight: 0, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
        <button
          className="sidebar-section__header"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          style={{ flex: 1 }}
        >
          <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 0.15s", flexShrink: 0 }}>
            <polyline points="3 2 7 5 3 8" />
          </svg>
          <span>{t("common.tasks")}</span>
          {!loading && <span className="sidebar-section__count">({tasks.length})</span>}
          {hasRunningTask && (
            <span
              className="task-live-light"
              role="status"
              aria-label={t("task.runs.running")}
              title={t("task.runs.running")}
            />
          )}
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
            <button onClick={() => void refresh()} style={{ margin: "6px 10px", padding: "6px 8px", background: "none", border: "1px solid var(--border)", borderRadius: "var(--r-sm)", color: "var(--danger)", cursor: "pointer", fontSize: "var(--fs-micro)" }}>
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
                  <div style={{ padding: "3px 14px 4px", color: "var(--text-dim)", fontSize: "var(--fs-micro)", fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase" }}>
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
