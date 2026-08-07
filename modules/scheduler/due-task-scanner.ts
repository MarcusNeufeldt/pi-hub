/**
 * DueTaskScanner — periodic scan that consumes due tasks into runs.
 *
 * Runs every tick (default 10s, design doc §8.3). For each due task it decides
 * whether to claim-and-execute or record a skip/miss, then advances the task
 * schedule. Claiming is atomic (store.claimScheduledRun transaction), so two
 * ticks or two processes can't double-fire the same instant (§30.6).
 *
 * The scanner is pure logic over a `TaskStore`; the runtime owns the timer and
 * the execution queue. This separation makes the scanner trivially testable.
 */

import { calculateNextRun, withinMisfireGrace } from "./schedule-calculator";
import type { TaskStore } from "./task-store";
import type { TaskDefinition, TaskRun } from "./types";

export interface ScanOutcome {
  /** Newly claimed runs ready to execute. */
  claimed: TaskRun[];
  /** Runs recorded as skipped/missed (misfire window exceeded). */
  skipped: TaskRun[];
}

/**
 * One scan pass. Returns claimed + skipped runs so the runtime can dispatch
 * execution and notify. Safe to call only when this process holds the leader
 * lease (the runtime enforces that).
 */
export function scanOnce(store: TaskStore, now: number): ScanOutcome {
  const due = store.listDueTasks(now);
  const claimed: TaskRun[] = [];
  const skipped: TaskRun[] = [];

  for (const task of due) {
    const dueAt = task.nextRunAt ?? now;

    // Misfire: schedule lapsed beyond the grace window with skip policy, OR
    // any task whose grace is exceeded regardless of policy records a miss
    // and advances. (§14.3 — for run_once within grace we still claim below.)
    const inGrace = withinMisfireGrace(
      dueAt,
      now,
      task.misfireGraceSeconds,
    );

    if (!inGrace) {
      // Record a missed run and advance the schedule.
      const miss = recordSkippedRun(store, task, now, "missed", "MISFIRE_WINDOW_EXCEEDED");
      if (miss) skipped.push(miss);
      advanceTaskSchedule(store, task, now);
      continue;
    }

    // Overlap guard: skip if this task already has a running/queued run.
    if (hasActiveRun(store, task)) {
      const skip = recordSkippedRun(store, task, now, "skipped", "TASK_ALREADY_RUNNING");
      if (skip) skipped.push(skip);
      advanceTaskSchedule(store, task, now);
      continue;
    }

    // Claim atomically.
    const result = store.claimScheduledRun(
      task.id,
      now,
      (t) => ({ dedupeKey: `scheduled:${t.id}:${t.nextRunAt}`, scheduledFor: t.nextRunAt ?? now }),
      (t) => advanceFields(t, now),
    );
    if (result?.inserted) {
      claimed.push(result.run);
    }
    // If not inserted, the dedupe key already existed — the schedule was
    // still advanced inside the transaction; nothing more to do.
  }

  return { claimed, skipped };
}

function hasActiveRun(store: TaskStore, task: TaskDefinition): boolean {
  const last = store.lastRunForTask(task.id);
  return Boolean(last && (last.status === "running" || last.status === "queued"));
}

/** Advances a recurring task's next_run_at, or marks a once-task completed. */
function advanceFields(
  task: TaskDefinition,
  now: number,
): { nextRunAt: number | null; status: TaskDefinition["status"] } {
  if (task.schedule.scheduleType === "once") {
    return { nextRunAt: null, status: "completed" };
  }
  return { nextRunAt: calculateNextRun(task.schedule, now), status: "active" };
}

/** Writes the task's advanced schedule/status. Split from advanceFields so the
 *  misfire/overlap paths (which don't go through claimScheduledRun) also move
 *  the schedule forward. */
function advanceTaskSchedule(
  store: TaskStore,
  task: TaskDefinition,
  now: number,
): void {
  const { nextRunAt, status } = advanceFields(task, now);
  store.updateTask(task.id, task.revision, { nextRunAt, status, updatedAt: now });
}

/** Records a skipped/missed run without executing. */
function recordSkippedRun(
  store: TaskStore,
  task: TaskDefinition,
  now: number,
  status: "skipped" | "missed",
  errorCode: string,
): TaskRun | null {
  const dueAt = task.nextRunAt ?? now;
  const runId = `run_miss_${task.id}_${dueAt}`;
  const { run, inserted } = store.insertRunIfAbsent({
    id: runId,
    taskId: task.id,
    dedupeKey: `scheduled:${task.id}:${dueAt}`,
    taskNameSnapshot: task.name,
    promptSnapshot: task.prompt,
    cwdSnapshot: task.cwd,
    scheduleSnapshotJson: JSON.stringify(task.schedule),
    executionOptionsSnapshotJson: JSON.stringify(task.execution),
    triggerType: "scheduled",
    scheduledFor: dueAt,
    status,
    queuedAt: now,
    finishedAt: now,
    errorCode,
    errorMessage:
      status === "missed"
        ? "Misfire grace window exceeded"
        : "Another run is already in progress",
    createdAt: now,
  });
  return inserted ? run : null;
}
