/**
 * TaskService — business layer for scheduled tasks.
 *
 * Consumed by API routes. Validates input, resolves schedules via the
 * schedule calculator, and persists through `TaskStore`. This layer does NOT
 * execute Agent work — the SchedulerRuntime owns execution. Manual "run now"
 * only enqueues a run (dedupe-protected) and never alters the task's own
 * `next_run_at` (design doc §20.5).
 */

import { randomUUID } from "crypto";
import { existsSync, realpathSync } from "fs";
import { isAbsolute, resolve } from "path";

import { resolveSchedule, calculateNextRun } from "./schedule-calculator";
import {
  SchedulerError,
  SchedulerErrorCode,
  validationError,
} from "./errors";
import type { TaskStore } from "./task-store";
import type {
  CreateTaskInput,
  ExecutionOptions,
  TaskDefinition,
  TaskRun,
  TaskRunSummary,
  TaskStatus,
  UpdateTaskPatch,
} from "./types";

const MIN_TIMEOUT_SECONDS = 60;
const MAX_TIMEOUT_SECONDS = 86400;

export interface ListTasksResult {
  items: (TaskDefinition & { lastRun: TaskRunSummary | null })[];
  total: number;
}

function defaultExecution(): ExecutionOptions {
  return {
    provider: null,
    modelId: null,
    thinkingLevel: null,
    toolNames: [],
    timeoutSeconds: 7200,
    notifyOnSuccess: false,
    notifyOnFailure: true,
  };
}

/** Validates + normalizes a cwd: must be absolute, exist, realpath-resolved. */
function normalizeCwd(raw: string): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new SchedulerError(SchedulerErrorCode.CWD_INVALID, "cwd is required");
  }
  const absolute = isAbsolute(raw) ? raw : resolve(raw);
  if (!existsSync(absolute)) {
    throw new SchedulerError(
      SchedulerErrorCode.CWD_NOT_FOUND,
      `Working directory does not exist: ${raw}`,
    );
  }
  try {
    return realpathSync(absolute);
  } catch {
    throw new SchedulerError(
      SchedulerErrorCode.CWD_NOT_FOUND,
      `Working directory not accessible: ${absolute}`,
    );
  }
}

function validateExecution(e: ExecutionOptions): void {
  if (
    (e.provider && !e.modelId) ||
    (!e.provider && e.modelId)
  ) {
    throw new SchedulerError(
      SchedulerErrorCode.VALIDATION_ERROR,
      "provider and modelId must both be set or both be null",
    );
  }
  if (
    !Number.isFinite(e.timeoutSeconds) ||
    e.timeoutSeconds < MIN_TIMEOUT_SECONDS ||
    e.timeoutSeconds > MAX_TIMEOUT_SECONDS
  ) {
    throw new SchedulerError(
      SchedulerErrorCode.VALIDATION_ERROR,
      `timeoutSeconds must be between ${MIN_TIMEOUT_SECONDS} and ${MAX_TIMEOUT_SECONDS}`,
    );
  }
}

export class TaskService {
  constructor(private readonly store: TaskStore) {}

  // ---- reads --------------------------------------------------------------

  listTasks(filter?: {
    status?: TaskStatus;
    limit?: number;
    offset?: number;
  }): ListTasksResult {
    const tasks = this.store.listTasks(filter);
    const items = tasks.map((task) => ({
      ...task,
      lastRun: task.id ? this.store.lastRunForTask(task.id) : null,
    }));
    return { items, total: items.length };
  }

  getTask(id: string): TaskDefinition {
    const task = this.store.getTask(id);
    if (!task) {
      throw new SchedulerError(SchedulerErrorCode.TASK_NOT_FOUND, id);
    }
    return task;
  }

  getTaskWithLastRun(id: string): TaskDefinition & {
    lastRun: TaskRunSummary | null;
  } {
    return { ...this.getTask(id), lastRun: this.store.lastRunForTask(id) };
  }

  // ---- writes -------------------------------------------------------------

  createTask(input: CreateTaskInput): TaskDefinition {
    if (!input.name?.trim()) throw validationError("name is required");
    if (!input.prompt?.trim()) throw validationError("prompt is required");
    const cwd = normalizeCwd(input.cwd);
    const execution: ExecutionOptions = {
      ...defaultExecution(),
      ...input.execution,
    };
    validateExecution(execution);

    const resolved = resolveSchedule(input.schedule);
    const now = Date.now();
    return this.store.insertTask({
      id: `task_${randomUUID()}`,
      name: input.name.trim(),
      prompt: input.prompt,
      cwd,
      schedule: {
        scheduleType: resolved.scheduleType,
        cronExpression: resolved.cronExpression,
        executeAt: resolved.executeAt,
        timezone: resolved.timezone,
      },
      nextRunAt: resolved.nextRunAt,
      execution,
      status: "active",
      misfirePolicy:
        resolved.scheduleType === "once" ? "run_once" : "run_once",
      misfireGraceSeconds:
        resolved.scheduleType === "once" ? 86400 : 3600,
      createdAt: now,
      updatedAt: now,
    });
  }

  updateTask(id: string, patch: UpdateTaskPatch): TaskDefinition {
    const current = this.getTask(id); // throws 404 if missing
    const next: Partial<TaskDefinition> = {};
    if (patch.name !== undefined) {
      if (!patch.name.trim()) throw validationError("name cannot be empty");
      next.name = patch.name.trim();
    }
    if (patch.prompt !== undefined) {
      if (!patch.prompt.trim()) throw validationError("prompt cannot be empty");
      next.prompt = patch.prompt;
    }
    if (patch.cwd !== undefined) next.cwd = normalizeCwd(patch.cwd);
    if (patch.schedule !== undefined) {
      const resolved = resolveSchedule(patch.schedule);
      next.schedule = {
        scheduleType: resolved.scheduleType,
        cronExpression: resolved.cronExpression,
        executeAt: resolved.executeAt,
        timezone: resolved.timezone,
      };
      // Recompute next run unless the caller is also flipping status to paused.
      next.nextRunAt = resolved.nextRunAt;
    }
    if (patch.execution !== undefined) {
      const merged: ExecutionOptions = {
        ...current.execution,
        ...patch.execution,
      };
      validateExecution(merged);
      next.execution = merged;
    }
    if (patch.status !== undefined) {
      next.status = patch.status;
      if (patch.status === "paused") {
        // Keep nextRunAt on pause so resume can re-arm cleanly; scanner only
        // picks up active tasks (listDueTasks filters status='active').
      } else if (patch.status === "active") {
        // Resume: recompute the next run from now (§20.4 — never back-fill).
        next.nextRunAt = calculateNextRun(
          next.schedule ?? current.schedule,
          Date.now(),
        );
      }
    }

    const updated = this.store.updateTask(id, patch.revision, {
      name: next.name,
      prompt: next.prompt,
      cwd: next.cwd,
      schedule: next.schedule,
      nextRunAt: next.nextRunAt,
      execution: next.execution ? { ...next.execution } : undefined,
      status: next.status,
      updatedAt: Date.now(),
    });
    if (!updated) {
      throw new SchedulerError(
        SchedulerErrorCode.REVISION_CONFLICT,
        `Task ${id} was modified by another editor (revision ${patch.revision} is stale)`,
      );
    }
    return updated;
  }

  setTaskStatus(id: string, status: TaskStatus, revision: number): TaskDefinition {
    return this.updateTask(id, { status, revision });
  }

  deleteTask(id: string): void {
    const ok = this.store.deleteTask(id);
    if (!ok) {
      throw new SchedulerError(SchedulerErrorCode.TASK_NOT_FOUND, id);
    }
    // Runs keep their history; FK ON DELETE SET NULL nulls their task_id.
  }

  // ---- manual trigger ------------------------------------------------------

  /**
   * Enqueues a manual run. Does not change the task's `next_run_at` (§20.5).
   * Returns the (possibly pre-existing) run id.
   */
  triggerRun(taskId: string): { run: TaskRun; created: boolean } {
    const task = this.getTask(taskId);
    const now = Date.now();
    const runId = `run_${randomUUID()}`;
    const { run, inserted } = this.store.insertRunIfAbsent({
      id: runId,
      taskId: task.id,
      dedupeKey: `manual:${runId}`,
      taskNameSnapshot: task.name,
      promptSnapshot: task.prompt,
      cwdSnapshot: task.cwd,
      scheduleSnapshotJson: JSON.stringify(task.schedule),
      executionOptionsSnapshotJson: JSON.stringify(task.execution),
      triggerType: "manual",
      scheduledFor: now,
      status: "queued",
      queuedAt: now,
      createdAt: now,
    });
    return { run, created: inserted };
  }

  // ---- runs ----------------------------------------------------------------

  listRuns(filter: {
    taskId?: string;
    status?: TaskRun["status"];
    limit?: number;
    offset?: number;
  }): { items: TaskRunSummary[]; total: number } {
    const items = this.store.listRuns(filter);
    const total = this.store.countRuns({ status: filter.status });
    return { items, total };
  }

  getRun(id: string): TaskRun {
    const run = this.store.getRun(id);
    if (!run) {
      throw new SchedulerError(SchedulerErrorCode.RUN_NOT_FOUND, id);
    }
    return run;
  }

  /**
   * Cancel a queued or running run. Queued → cancelled immediately. Running →
   * marked for cancellation; the executor observes the abort and finalizes.
   * Returns the run after the status transition.
   */
  cancelRun(id: string): TaskRun {
    const run = this.getRun(id);
    if (run.status === "queued") {
      this.store.updateRun(id, {
        status: "cancelled",
        finishedAt: Date.now(),
        errorCode: "TASK_CANCELLED",
        errorMessage: "Cancelled by user before execution started",
      });
    } else if (run.status === "running") {
      // Signal cancellation; runtime observes and finalizes as cancelled.
      this.store.updateRun(id, { errorCode: "TASK_CANCELLED" });
    } else {
      throw new SchedulerError(
        SchedulerErrorCode.RUN_NOT_CANCELLABLE,
        `Run ${id} is in terminal status '${run.status}'`,
      );
    }
    return this.getRun(id);
  }
}
