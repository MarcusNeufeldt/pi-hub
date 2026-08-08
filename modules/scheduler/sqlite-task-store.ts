/**
 * SQLite-backed implementation of `TaskStore` using Node's built-in
 * `node:sqlite` (no native npm dependency). All persistence lives under
 * `~/.pi/hub/app.db` (AGENTS.local.md §8).
 *
 * Booleans are stored as 0/1 INTEGERs; tool lists and snapshots as JSON TEXT.
 * The claim path wraps run-insert + task-advance in a manual transaction so a
 * scheduled instant can only ever be consumed once (design doc §13, §30.6).
 */

import { DatabaseSync } from "node:sqlite";
import type {
  DatabaseSync as DatabaseSyncType,
  SQLInputValue,
} from "node:sqlite";

import { SchedulerError, SchedulerErrorCode } from "./errors";
import { migrate } from "./schema-migrations";
import type {
  CreateTaskRow,
  InsertRunRow,
  LeaseInfo,
  TaskStore,
  UpdateTaskRow,
} from "./task-store";
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

// node:sqlite on this Node version exposes no `.transaction()` helper, so we
// run BEGIN/COMMIT/ROLLBACK directly. Re-using one connection is fine because
// V1 is single-process.
type Db = DatabaseSyncType;

interface TaskRow {
  id: string;
  name: string;
  prompt: string;
  cwd: string;
  schedule_type: "recurring" | "once";
  cron_expression: string | null;
  execute_at: number | null;
  timezone: string;
  next_run_at: number | null;
  provider: string | null;
  model_id: string | null;
  thinking_level: string | null;
  tool_names_json: string | null;
  status: TaskStatus;
  overlap_policy: "skip";
  misfire_policy: "run_once" | "skip";
  misfire_grace_seconds: number;
  timeout_seconds: number;
  notify_on_success: number;
  notify_on_failure: number;
  last_run_at: number | null;
  created_at: number;
  updated_at: number;
  revision: number;
  resume_json: string | null;
  retry_on_rate_limit_json: string | null;
  attempt_count: number;
}

interface RunRow {
  id: string;
  task_id: string | null;
  dedupe_key: string;
  task_name_snapshot: string;
  prompt_snapshot: string;
  cwd_snapshot: string;
  schedule_snapshot_json: string;
  execution_options_snapshot_json: string;
  trigger_type: "scheduled" | "manual";
  scheduled_for: number;
  status: TaskRun["status"];
  session_id: string | null;
  result_excerpt: string | null;
  error_code: string | null;
  error_message: string | null;
  queued_at: number;
  started_at: number | null;
  finished_at: number | null;
  heartbeat_at: number | null;
  created_at: number;
  resume_snapshot_json: string | null;
}

// ---------------------------------------------------------------------------
// Row ↔ domain mapping
// ---------------------------------------------------------------------------

function rowToTask(r: TaskRow): TaskDefinition {
  return {
    id: r.id,
    name: r.name,
    prompt: r.prompt,
    cwd: r.cwd,
    schedule: {
      scheduleType: r.schedule_type,
      cronExpression: r.cron_expression,
      executeAt: r.execute_at,
      timezone: r.timezone,
    },
    nextRunAt: r.next_run_at,
    execution: {
      provider: r.provider,
      modelId: r.model_id,
      thinkingLevel: r.thinking_level,
      toolNames: r.tool_names_json ? (JSON.parse(r.tool_names_json) as string[]) : [],
      timeoutSeconds: r.timeout_seconds,
      notifyOnSuccess: r.notify_on_success === 1,
      notifyOnFailure: r.notify_on_failure === 1,
    },
    resume: r.resume_json ? (JSON.parse(r.resume_json) as ResumeTarget) : null,
    retryOnRateLimit: r.retry_on_rate_limit_json
      ? (JSON.parse(r.retry_on_rate_limit_json) as RetryOnRateLimit)
      : null,
    attemptCount: r.attempt_count,
    status: r.status,
    overlapPolicy: r.overlap_policy,
    misfirePolicy: r.misfire_policy,
    misfireGraceSeconds: r.misfire_grace_seconds,
    lastRunAt: r.last_run_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    revision: r.revision,
  };
}

function rowToRun(r: RunRow): TaskRun {
  return {
    id: r.id,
    taskId: r.task_id,
    dedupeKey: r.dedupe_key,
    taskNameSnapshot: r.task_name_snapshot,
    promptSnapshot: r.prompt_snapshot,
    cwdSnapshot: r.cwd_snapshot,
    scheduleSnapshotJson: r.schedule_snapshot_json,
    executionOptionsSnapshotJson: r.execution_options_snapshot_json,
    resumeSnapshotJson: r.resume_snapshot_json,
    triggerType: r.trigger_type,
    scheduledFor: r.scheduled_for,
    status: r.status,
    sessionId: r.session_id,
    resultExcerpt: r.result_excerpt,
    errorCode: r.error_code,
    errorMessage: r.error_message,
    queuedAt: r.queued_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    heartbeatAt: r.heartbeat_at,
    createdAt: r.created_at,
  };
}

function rowToRunSummary(r: RunRow): TaskRunSummary {
  return {
    id: r.id,
    taskId: r.task_id,
    taskNameSnapshot: r.task_name_snapshot,
    triggerType: r.trigger_type,
    scheduledFor: r.scheduled_for,
    status: r.status,
    sessionId: r.session_id,
    errorCode: r.error_code,
    errorMessage: r.error_message,
    queuedAt: r.queued_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

function executionJson(e: ExecutionOptions): string {
  return JSON.stringify(e);
}

function scheduleJson(s: PersistedSchedule): string {
  return JSON.stringify(s);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class SqliteTaskStore implements TaskStore {
  readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /** Opens the database at `path`, applies PRAGMAs + migrations, returns a store. */
  static open(path: string): SqliteTaskStore {
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec("PRAGMA synchronous = NORMAL;");
    try {
      migrate(db);
    } catch (error) {
      db.close?.();
      throw error;
    }
    return new SqliteTaskStore(db);
  }

  close(): void {
    this.db.close?.();
  }

  // ---- tasks ---------------------------------------------------------------

  insertTask(row: CreateTaskRow): TaskDefinition {
    this.db
      .prepare(
        `INSERT INTO scheduled_tasks (
          id, name, prompt, cwd,
          schedule_type, cron_expression, execute_at, timezone, next_run_at,
          provider, model_id, thinking_level, tool_names_json,
          resume_json,
          retry_on_rate_limit_json,
          status, overlap_policy, misfire_policy, misfire_grace_seconds, timeout_seconds,
          notify_on_success, notify_on_failure,
          last_run_at, created_at, updated_at, revision
        ) VALUES (
          @id, @name, @prompt, @cwd,
          @schedule_type, @cron_expression, @execute_at, @timezone, @next_run_at,
          @provider, @model_id, @thinking_level, @tool_names_json,
          @resume_json,
          @retry_on_rate_limit_json,
          @status, @overlap_policy, @misfire_policy, @misfire_grace_seconds, @timeout_seconds,
          @notify_on_success, @notify_on_failure,
          NULL, @created_at, @updated_at, 1
        )`,
      )
      .run({
        id: row.id,
        name: row.name,
        prompt: row.prompt,
        cwd: row.cwd,
        schedule_type: row.schedule.scheduleType,
        cron_expression: row.schedule.cronExpression,
        execute_at: row.schedule.executeAt,
        timezone: row.schedule.timezone,
        next_run_at: row.nextRunAt,
        provider: row.execution.provider,
        model_id: row.execution.modelId,
        thinking_level: row.execution.thinkingLevel,
        tool_names_json: JSON.stringify(row.execution.toolNames),
        resume_json: row.resume ? JSON.stringify(row.resume) : null,
        retry_on_rate_limit_json: row.retryOnRateLimit
          ? JSON.stringify(row.retryOnRateLimit)
          : null,
        status: row.status,
        overlap_policy: "skip",
        misfire_policy: row.misfirePolicy,
        misfire_grace_seconds: row.misfireGraceSeconds,
        timeout_seconds: row.execution.timeoutSeconds,
        notify_on_success: row.execution.notifyOnSuccess ? 1 : 0,
        notify_on_failure: row.execution.notifyOnFailure ? 1 : 0,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
      });
    const created = this.getTask(row.id);
    if (!created) {
      throw new SchedulerError(
        SchedulerErrorCode.DATABASE_ERROR,
        `Task ${row.id} not found after insert`,
      );
    }
    return created;
  }

  getTask(id: string): TaskDefinition | null {
    const row = this.db
      .prepare("SELECT * FROM scheduled_tasks WHERE id = ?")
      .get(id) as unknown as TaskRow | undefined;
    return row ? rowToTask(row) : null;
  }

  updateTask(
    id: string,
    expectedRevision: number,
    row: UpdateTaskRow,
  ): TaskDefinition | null {
    const current = this.getTask(id);
    if (!current) return null;
    if (current.revision !== expectedRevision) return null;

    const next: TaskDefinition = {
      ...current,
      name: row.name ?? current.name,
      prompt: row.prompt ?? current.prompt,
      cwd: row.cwd ?? current.cwd,
      schedule: row.schedule ?? current.schedule,
      nextRunAt:
        row.nextRunAt !== undefined ? row.nextRunAt : current.nextRunAt,
      execution: row.execution
        ? { ...current.execution, ...row.execution }
        : current.execution,
      resume:
        row.resume === undefined ? current.resume : row.resume,
      retryOnRateLimit:
        row.retryOnRateLimit === undefined
          ? current.retryOnRateLimit
          : row.retryOnRateLimit,
      status: row.status ?? current.status,
      updatedAt: row.updatedAt,
      revision: current.revision + 1,
    };

    const result = this.db
      .prepare(
        `UPDATE scheduled_tasks SET
          name = @name, prompt = @prompt, cwd = @cwd,
          schedule_type = @schedule_type, cron_expression = @cron_expression,
          execute_at = @execute_at, timezone = @timezone, next_run_at = @next_run_at,
          provider = @provider, model_id = @model_id, thinking_level = @thinking_level,
          tool_names_json = @tool_names_json,
          resume_json = @resume_json,
          retry_on_rate_limit_json = @retry_on_rate_limit_json,
          status = @status,
          timeout_seconds = @timeout_seconds,
          notify_on_success = @notify_on_success, notify_on_failure = @notify_on_failure,
          updated_at = @updated_at, revision = @revision
        WHERE id = @id AND revision = @expected_revision`,
      )
      .run({
        id,
        expected_revision: expectedRevision,
        name: next.name,
        prompt: next.prompt,
        cwd: next.cwd,
        schedule_type: next.schedule.scheduleType,
        cron_expression: next.schedule.cronExpression,
        execute_at: next.schedule.executeAt,
        timezone: next.schedule.timezone,
        next_run_at: next.nextRunAt,
        provider: next.execution.provider,
        model_id: next.execution.modelId,
        thinking_level: next.execution.thinkingLevel,
        tool_names_json: JSON.stringify(next.execution.toolNames),
        resume_json: next.resume ? JSON.stringify(next.resume) : null,
        retry_on_rate_limit_json: next.retryOnRateLimit
          ? JSON.stringify(next.retryOnRateLimit)
          : null,
        status: next.status,
        timeout_seconds: next.execution.timeoutSeconds,
        notify_on_success: next.execution.notifyOnSuccess ? 1 : 0,
        notify_on_failure: next.execution.notifyOnFailure ? 1 : 0,
        updated_at: next.updatedAt,
        revision: next.revision,
      });

    if (result.changes === 0) return null; // concurrent revision change
    return this.getTask(id);
  }

  deleteTask(id: string): boolean {
    const result = this.db
      .prepare("DELETE FROM scheduled_tasks WHERE id = ?")
      .run(id);
    return result.changes > 0;
  }

  listTasks(filter?: {
    status?: TaskStatus;
    limit?: number;
    offset?: number;
  }): TaskDefinition[] {
    const where: string[] = [];
    const params: Record<string, SQLInputValue> = {};
    if (filter?.status) {
      where.push("status = @status");
      params.status = filter.status;
    }
    const sql = `SELECT * FROM scheduled_tasks ${
      where.length ? `WHERE ${where.join(" AND ")}` : ""
    } ORDER BY created_at ASC ${
      filter?.limit ? "LIMIT @limit" : ""
    } ${filter?.offset ? "OFFSET @offset" : ""}`;
    if (filter?.limit) params.limit = filter.limit;
    if (filter?.offset) params.offset = filter.offset;
    const rows = this.db.prepare(sql).all(params) as unknown as TaskRow[];
    return rows.map(rowToTask);
  }

  listTaskCwds(): string[] {
    const rows = this.db
      .prepare("SELECT DISTINCT cwd FROM scheduled_tasks")
      .all() as unknown as { cwd: string }[];
    return rows.map((r) => r.cwd);
  }

  rescheduleTask(taskId: string, nextRunAt: number, attemptCount: number): void {
    // Reactivate the task for a rate-limit retry. Skip if paused (respect
    // user intent) or gone — both are harmless no-ops.
    this.db
      .prepare(
        `UPDATE scheduled_tasks
           SET status = 'active', next_run_at = ?, attempt_count = ?, updated_at = ?
         WHERE id = ? AND status != 'paused'`,
      )
      .run(nextRunAt, attemptCount, Date.now(), taskId);
  }

  resetAttemptCount(taskId: string): void {
    this.db
      .prepare("UPDATE scheduled_tasks SET attempt_count = 0 WHERE id = ?")
      .run(taskId);
  }

  // ---- runs ----------------------------------------------------------------

  insertRunIfAbsent(row: InsertRunRow): { run: TaskRun; inserted: boolean } {
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `INSERT INTO task_runs (
            id, task_id, dedupe_key,
            task_name_snapshot, prompt_snapshot, cwd_snapshot,
            schedule_snapshot_json, execution_options_snapshot_json,
            resume_snapshot_json,
            trigger_type, scheduled_for, status,
            session_id, result_excerpt, error_code, error_message,
            queued_at, started_at, finished_at, heartbeat_at, created_at
          ) VALUES (
            @id, @task_id, @dedupe_key,
            @task_name_snapshot, @prompt_snapshot, @cwd_snapshot,
            @schedule_snapshot_json, @execution_options_snapshot_json,
            @resume_snapshot_json,
            @trigger_type, @scheduled_for, @status,
            NULL, NULL, @error_code, @error_message,
            @queued_at, NULL, @finished_at, NULL, @created_at
          )`,
        )
        .run({
          id: row.id,
          task_id: row.taskId,
          dedupe_key: row.dedupeKey,
          task_name_snapshot: row.taskNameSnapshot,
          prompt_snapshot: row.promptSnapshot,
          cwd_snapshot: row.cwdSnapshot,
          schedule_snapshot_json: row.scheduleSnapshotJson,
          execution_options_snapshot_json: row.executionOptionsSnapshotJson,
          resume_snapshot_json: row.resumeSnapshotJson ?? null,
          trigger_type: row.triggerType,
          scheduled_for: row.scheduledFor,
          status: row.status,
          error_code: row.errorCode ?? null,
          error_message: row.errorMessage ?? null,
          queued_at: row.queuedAt,
          finished_at: row.finishedAt ?? null,
          created_at: row.createdAt,
        });
      this.db.exec("COMMIT");
      const run = this.getRun(row.id);
      if (!run) {
        throw new SchedulerError(
          SchedulerErrorCode.DATABASE_ERROR,
          `Run ${row.id} not found after insert`,
        );
      }
      return { run, inserted: true };
    } catch (error) {
      this.db.exec("ROLLBACK");
      const msg = error instanceof Error ? error.message : String(error);
      // UNIQUE violation → an identical dedupe_key already exists. Fetch it.
      if (/UNIQUE/i.test(msg)) {
        const existing = this.db
          .prepare("SELECT * FROM task_runs WHERE dedupe_key = ?")
          .get(row.dedupeKey) as unknown as RunRow | undefined;
        if (existing) {
          return { run: rowToRun(existing), inserted: false };
        }
      }
      throw error;
    }
  }

  getRun(id: string): TaskRun | null {
    const row = this.db
      .prepare("SELECT * FROM task_runs WHERE id = ?")
      .get(id) as unknown as RunRow | undefined;
    return row ? rowToRun(row) : null;
  }

  listRuns(filter: {
    taskId?: string;
    status?: TaskRun["status"];
    limit?: number;
    offset?: number;
  }): TaskRunSummary[] {
    const where: string[] = [];
    const params: Record<string, SQLInputValue> = {};
    if (filter.taskId) {
      where.push("task_id = @task_id");
      params.task_id = filter.taskId;
    }
    if (filter.status) {
      where.push("status = @status");
      params.status = filter.status;
    }
    const sql = `SELECT * FROM task_runs ${
      where.length ? `WHERE ${where.join(" AND ")}` : ""
    } ORDER BY created_at DESC LIMIT @limit OFFSET @offset`;
    params.limit = filter.limit ?? 50;
    params.offset = filter.offset ?? 0;
    const rows = this.db.prepare(sql).all(params) as unknown as RunRow[];
    return rows.map(rowToRunSummary);
  }

  countRuns(filter: { status?: TaskRun["status"] }): number {
    const where: string[] = [];
    const params: Record<string, SQLInputValue> = {};
    if (filter.status) {
      where.push("status = @status");
      params.status = filter.status;
    }
    const sql = `SELECT COUNT(*) AS c FROM task_runs ${
      where.length ? `WHERE ${where.join(" AND ")}` : ""
    }`;
    const row = this.db.prepare(sql).get(params) as unknown as { c: number };
    return row.c;
  }

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
  ): void {
    const sets: string[] = [];
    const params: Record<string, SQLInputValue> = { id };
    if (fields.status !== undefined) {
      sets.push("status = @status");
      params.status = fields.status;
    }
    if (fields.sessionId !== undefined) {
      sets.push("session_id = @session_id");
      params.session_id = fields.sessionId;
    }
    if (fields.resultExcerpt !== undefined) {
      sets.push("result_excerpt = @result_excerpt");
      params.result_excerpt = fields.resultExcerpt;
    }
    if (fields.errorCode !== undefined) {
      sets.push("error_code = @error_code");
      params.error_code = fields.errorCode;
    }
    if (fields.errorMessage !== undefined) {
      sets.push("error_message = @error_message");
      params.error_message = fields.errorMessage;
    }
    if (fields.startedAt !== undefined) {
      sets.push("started_at = @started_at");
      params.started_at = fields.startedAt;
    }
    if (fields.finishedAt !== undefined) {
      sets.push("finished_at = @finished_at");
      params.finished_at = fields.finishedAt;
    }
    if (fields.heartbeatAt !== undefined) {
      sets.push("heartbeat_at = @heartbeat_at");
      params.heartbeat_at = fields.heartbeatAt;
    }
    if (sets.length === 0) return;
    this.db
      .prepare(`UPDATE task_runs SET ${sets.join(", ")} WHERE id = @id`)
      .run(params);
  }

  // ---- due / claim / recovery ---------------------------------------------

  listDueTasks(now: number): TaskDefinition[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM scheduled_tasks
         WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ?
         ORDER BY next_run_at ASC`,
      )
      .all(now) as unknown as TaskRow[];
    return rows.map(rowToTask);
  }

  claimScheduledRun(
    taskId: string,
    _now: number,
    buildRun: (task: TaskDefinition) => { dedupeKey: string; scheduledFor: number },
    advanceTask: (task: TaskDefinition) => {
      nextRunAt: number | null;
      status: TaskStatus;
    },
  ): { run: TaskRun; inserted: boolean } | null {
    this.db.exec("BEGIN");
    try {
      const row = this.db
        .prepare(
          "SELECT * FROM scheduled_tasks WHERE id = ? AND status = 'active'",
        )
        .get(taskId) as unknown as TaskRow | undefined;
      if (!row || row.next_run_at == null) {
        this.db.exec("ROLLBACK");
        return null;
      }
      const task = rowToTask(row);
      const { dedupeKey, scheduledFor } = buildRun(task);

      // Attempt the dedupe-protected insert first.
      const existing = this.db
        .prepare("SELECT * FROM task_runs WHERE dedupe_key = ?")
        .get(dedupeKey) as unknown as RunRow | undefined;
      if (existing) {
        // Already claimed in a previous tick — still advance the task so a
        // recurring schedule moves forward, but do not create a second run.
        const adv = advanceTask(task);
        this.db
          .prepare(
            "UPDATE scheduled_tasks SET next_run_at = ?, status = ?, updated_at = ? WHERE id = ?",
          )
          .run(adv.nextRunAt, adv.status, Date.now(), taskId);
        this.db.exec("COMMIT");
        return { run: rowToRun(existing), inserted: false };
      }

      const runId = `run_${process.hrtime.bigint().toString(36)}_${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      this.db
        .prepare(
          `INSERT INTO task_runs (
            id, task_id, dedupe_key,
            task_name_snapshot, prompt_snapshot, cwd_snapshot,
            schedule_snapshot_json, execution_options_snapshot_json,
            resume_snapshot_json,
            trigger_type, scheduled_for, status,
            queued_at, created_at
          ) VALUES (
            @id, @task_id, @dedupe_key,
            @task_name_snapshot, @prompt_snapshot, @cwd_snapshot,
            @schedule_snapshot_json, @execution_options_snapshot_json,
            @resume_snapshot_json,
            'scheduled', @scheduled_for, 'queued',
            @queued_at, @created_at
          )`,
        )
        .run({
          id: runId,
          task_id: taskId,
          dedupe_key: dedupeKey,
          task_name_snapshot: task.name,
          prompt_snapshot: task.prompt,
          cwd_snapshot: task.cwd,
          schedule_snapshot_json: scheduleJson(task.schedule),
          execution_options_snapshot_json: executionJson(task.execution),
          resume_snapshot_json: task.resume ? JSON.stringify(task.resume) : null,
          scheduled_for: scheduledFor,
          queued_at: Date.now(),
          created_at: Date.now(),
        });

      const adv = advanceTask(task);
      this.db
        .prepare(
          "UPDATE scheduled_tasks SET next_run_at = ?, status = ?, updated_at = ? WHERE id = ?",
        )
        .run(adv.nextRunAt, adv.status, Date.now(), taskId);

      this.db.exec("COMMIT");
      const created = this.getRun(runId);
      if (!created) {
        throw new SchedulerError(
          SchedulerErrorCode.DATABASE_ERROR,
          `Claimed run ${runId} not found after insert`,
        );
      }
      return { run: created, inserted: true };
    } catch (error) {
      this.db.exec("ROLLBACK");
      const msg = error instanceof Error ? error.message : String(error);
      // Another tick raced us with the same dedupe key — treat as not-claimed.
      if (/UNIQUE/i.test(msg)) return null;
      throw error;
    }
  }

  markStaleRunningAsInterrupted(
    now: number,
    heartbeatTimeoutMs: number,
    errorCode: string = "PROCESS_RESTARTED",
  ): number {
    const result = this.db
      .prepare(
        `UPDATE task_runs SET
           status = 'interrupted',
           finished_at = @now,
           error_code = @code,
           error_message = 'Process restarted; in-memory run state lost'
         WHERE status = 'running'
           AND (heartbeat_at IS NULL OR heartbeat_at < @cutoff)`,
      )
      .run({
        now,
        code: errorCode,
        cutoff: now - heartbeatTimeoutMs,
      });
    return Number(result.changes);
  }

  lastRunForTask(taskId: string): TaskRunSummary | null {
    const row = this.db
      .prepare(
        "SELECT * FROM task_runs WHERE task_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(taskId) as RunRow | undefined;
    return row ? rowToRunSummary(row) : null;
  }

  // ---- leader lease --------------------------------------------------------

  tryAcquireLease(
    leaseName: string,
    ownerId: string,
    leaseMs: number,
  ): boolean {
    const now = Date.now();
    this.db.exec("BEGIN");
    try {
      const existing = this.db
        .prepare("SELECT * FROM scheduler_leases WHERE lease_name = ?")
        .get(leaseName) as unknown as
        | { lease_name: string; owner_id: string; lease_until: number; updated_at: number }
        | undefined;
      const free =
        !existing || existing.lease_until < now || existing.owner_id === ownerId;
      if (!free) {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.db
        .prepare(
          `INSERT INTO scheduler_leases (lease_name, owner_id, lease_until, updated_at)
           VALUES (@name, @owner, @until, @now)
           ON CONFLICT(lease_name) DO UPDATE SET
             owner_id = @owner,
             lease_until = @until,
             updated_at = @now`,
        )
        .run({ name: leaseName, owner: ownerId, until: now + leaseMs, now });
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  renewLease(leaseName: string, ownerId: string, leaseMs: number): boolean {
    const now = Date.now();
    const result = this.db
      .prepare(
        `UPDATE scheduler_leases SET lease_until = @until, updated_at = @now
         WHERE lease_name = @name AND owner_id = @owner`,
      )
      .run({ name: leaseName, owner: ownerId, until: now + leaseMs, now });
    return result.changes > 0;
  }

  isLeader(leaseName: string, ownerId: string): boolean {
    const now = Date.now();
    const row = this.db
      .prepare("SELECT * FROM scheduler_leases WHERE lease_name = ?")
      .get(leaseName) as unknown as
      | { owner_id: string; lease_until: number }
      | undefined;
    return Boolean(row && row.owner_id === ownerId && row.lease_until >= now);
  }

  getLease(leaseName: string): LeaseInfo | null {
    const row = this.db
      .prepare("SELECT * FROM scheduler_leases WHERE lease_name = ?")
      .get(leaseName) as unknown as
      | { owner_id: string; lease_until: number }
      | undefined;
    return row
      ? { ownerId: row.owner_id, leaseUntil: row.lease_until }
      : null;
  }
}
