/**
 * Storage interface for the Pi Hub scheduler.
 *
 * The business layer (TaskService, SchedulerRuntime) depends on this
 * abstraction, not on `node:sqlite` directly (design doc §9.2). The default
 * implementation is `SqliteTaskStore`; tests can substitute an in-memory
 * fake without touching SQLite.
 */

import type {
  ExecutionOptions,
  PersistedSchedule,
  ResumeTarget,
  RetryOnRateLimit,
  TaskDefinition,
  TaskRun,
  TaskRunSummary,
  TaskStatus,
} from "./types";

export interface CreateTaskRow {
  id: string;
  name: string;
  prompt: string;
  cwd: string;
  schedule: PersistedSchedule;
  nextRunAt: number | null;
  execution: ExecutionOptions;
  /** Resume target; null/undefined = create a new session each run. */
  resume?: ResumeTarget | null;
  /** Optional rate-limit auto-reschedule policy. */
  retryOnRateLimit?: RetryOnRateLimit | null;
  status: TaskStatus;
  misfirePolicy: "run_once" | "skip";
  misfireGraceSeconds: number;
  createdAt: number;
  updatedAt: number;
}

export interface UpdateTaskRow {
  name?: string;
  prompt?: string;
  cwd?: string;
  schedule?: PersistedSchedule;
  nextRunAt?: number | null;
  execution?: Partial<ExecutionOptions>;
  /** undefined ⇒ unchanged; null ⇒ clear; object ⇒ set. */
  resume?: ResumeTarget | null;
  /** undefined ⇒ unchanged; null ⇒ clear; object ⇒ set. */
  retryOnRateLimit?: RetryOnRateLimit | null;
  status?: TaskStatus;
  updatedAt: number;
}

export interface InsertRunRow {
  id: string;
  taskId: string;
  dedupeKey: string;
  taskNameSnapshot: string;
  promptSnapshot: string;
  cwdSnapshot: string;
  scheduleSnapshotJson: string;
  executionOptionsSnapshotJson: string;
  /** Snapshot of the task's resume target at claim time (nullable). */
  resumeSnapshotJson?: string | null;
  triggerType: "scheduled" | "manual";
  scheduledFor: number;
  status: TaskRun["status"];
  queuedAt: number;
  /** Set when the run is created already-skipped (misfire / overlap). */
  finishedAt?: number;
  errorCode?: string;
  errorMessage?: string;
  createdAt: number;
}

export interface LeaseInfo {
  ownerId: string;
  leaseUntil: number;
}

export interface TaskStore {
  // ---- tasks ----
  insertTask(row: CreateTaskRow): TaskDefinition;
  getTask(id: string): TaskDefinition | null;
  /**
   * Applies `row` only if the stored `revision` matches `expectedRevision`,
   * bumping revision by 1. Returns the updated task, or null on conflict.
   */
  updateTask(
    id: string,
    expectedRevision: number,
    row: UpdateTaskRow,
  ): TaskDefinition | null;
  deleteTask(id: string): boolean;
  listTasks(filter?: {
    status?: TaskStatus;
    limit?: number;
    offset?: number;
  }): TaskDefinition[];
  /** Distinct task cwds (for file-access allow-list registration). */
  listTaskCwds(): string[];
  /**
   * Reactivates a (possibly completed) task for a rate-limit retry (resume
   * §11): sets status='active', next_run_at, attempt_count. No-op if the task
   * is paused or gone (respects user pause intent).
   */
  rescheduleTask(taskId: string, nextRunAt: number, attemptCount: number): void;
  /** Resets the consecutive-rate-limit-failure counter (on success). */
  resetAttemptCount(taskId: string): void;

  // ---- runs ----
  /**
   * Inserts a run, or returns the existing run if `dedupeKey` already exists.
   * The UNIQUE constraint on dedupe_key is the authoritative dedupe barrier
   * (design doc §30.6) — callers must not rely on in-memory checks.
   */
  insertRunIfAbsent(row: InsertRunRow): { run: TaskRun; inserted: boolean };
  getRun(id: string): TaskRun | null;
  listRuns(filter: {
    taskId?: string;
    status?: TaskRun["status"];
    limit?: number;
    offset?: number;
  }): TaskRunSummary[];
  countRuns(filter: { status?: TaskRun["status"] }): number;
  /** Updates mutable run fields by id. No-op if the run is gone. */
  updateRun(
    id: string,
    fields: Partial<
      Pick<
        TaskRun,
        | "status"
        | "sessionId"
        | "resultExcerpt"
        | "errorCode"
        | "errorMessage"
        | "startedAt"
        | "finishedAt"
        | "heartbeatAt"
      >
    >,
  ): void;

  // ---- scheduler claim / recovery ----
  /** Tasks with status='active' and next_run_at <= now, ordered by due time. */
  listDueTasks(now: number): TaskDefinition[];
  /**
   * Atomic claim: in one transaction, inserts the scheduled run (dedupe
   * protected) and advances the task's next_run_at / status. Returns the
   * inserted run, or null if the task was concurrently claimed or changed.
   * Mirrors design doc §13.
   */
  claimScheduledRun(
    taskId: string,
    now: number,
    buildRun: (task: TaskDefinition) => {
      dedupeKey: string;
      scheduledFor: number;
    },
    /** Called after a successful claim to advance the task. */
    advanceTask: (task: TaskDefinition) => {
      nextRunAt: number | null;
      status: TaskStatus;
    },
  ): { run: TaskRun; inserted: boolean } | null;
  /** Finds runs stuck in 'running' past `heartbeatTimeoutMs` and marks them interrupted. */
  markStaleRunningAsInterrupted(
    now: number,
    heartbeatTimeoutMs: number,
    errorCode?: string,
  ): number;
  /** Most recent run for a task (any status), or null. */
  lastRunForTask(taskId: string): TaskRunSummary | null;

  // ---- leader lease ----
  tryAcquireLease(leaseName: string, ownerId: string, leaseMs: number): boolean;
  renewLease(leaseName: string, ownerId: string, leaseMs: number): boolean;
  isLeader(leaseName: string, ownerId: string): boolean;
  getLease(leaseName: string): LeaseInfo | null;
}
