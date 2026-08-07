/**
 * SQLite schema migrations for the Pi Hub scheduler.
 *
 * Migrations run in version order at scheduler startup. The version is
 * recorded in `schema_migrations`; only versions newer than the last
 * applied one are executed. Migration failure aborts scheduler startup
 * (design doc §9.3) — the Web UI can still return a clear error state,
 * but we never silently skip a migration.
 *
 * node:sqlite's `DatabaseSync` has no `.transaction()` helper on this Node
 * version, so migrations wrap each DDL batch in manual BEGIN/COMMIT and
 * ROLLBACK on failure.
 */

import type { DatabaseSync } from "node:sqlite";

const MIGRATIONS: { version: number; up: string }[] = [
  {
    version: 1,
    up: `
      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,

        schedule_type TEXT NOT NULL
          CHECK (schedule_type IN ('recurring', 'once')),
        cron_expression TEXT,
        execute_at INTEGER,
        timezone TEXT NOT NULL,
        next_run_at INTEGER,

        prompt TEXT NOT NULL,
        cwd TEXT NOT NULL,

        provider TEXT,
        model_id TEXT,
        thinking_level TEXT,
        tool_names_json TEXT,

        status TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'paused', 'completed')),
        overlap_policy TEXT NOT NULL DEFAULT 'skip'
          CHECK (overlap_policy IN ('skip')),
        misfire_policy TEXT NOT NULL
          CHECK (misfire_policy IN ('run_once', 'skip')),
        misfire_grace_seconds INTEGER NOT NULL,
        timeout_seconds INTEGER NOT NULL DEFAULT 7200,

        notify_on_success INTEGER NOT NULL DEFAULT 0,
        notify_on_failure INTEGER NOT NULL DEFAULT 1,

        last_run_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,

        CHECK (
          (schedule_type = 'recurring'
            AND cron_expression IS NOT NULL
            AND execute_at IS NULL)
          OR
          (schedule_type = 'once'
            AND cron_expression IS NULL
            AND execute_at IS NOT NULL)
        )
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_due
      ON scheduled_tasks(status, next_run_at);

      CREATE TABLE IF NOT EXISTS task_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT REFERENCES scheduled_tasks(id) ON DELETE SET NULL,
        dedupe_key TEXT NOT NULL UNIQUE,

        task_name_snapshot TEXT NOT NULL,
        prompt_snapshot TEXT NOT NULL,
        cwd_snapshot TEXT NOT NULL,
        schedule_snapshot_json TEXT NOT NULL,
        execution_options_snapshot_json TEXT NOT NULL,

        trigger_type TEXT NOT NULL
          CHECK (trigger_type IN ('scheduled', 'manual')),
        scheduled_for INTEGER NOT NULL,

        status TEXT NOT NULL
          CHECK (status IN (
            'queued',
            'running',
            'success',
            'failed',
            'cancelled',
            'interrupted',
            'skipped',
            'missed'
          )),

        session_id TEXT,
        result_excerpt TEXT,
        error_code TEXT,
        error_message TEXT,

        queued_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        heartbeat_at INTEGER,

        created_at INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_task_runs_task_created
      ON task_runs(task_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_task_runs_status
      ON task_runs(status, created_at);

      CREATE TABLE IF NOT EXISTS scheduler_leases (
        lease_name TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        lease_until INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
    `,
  },
];

/** Configures a fresh database connection with the recommended PRAGMAs. */
export function configureConnection(db: DatabaseSync): void {
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA synchronous = NORMAL;");
}

/**
 * Applies all pending migrations. Throws on failure (caller must surface the
 * error and must NOT start the scheduler). Idempotent for already-applied
 * versions.
 */
export function migrate(db: DatabaseSync): number {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    ) STRICT;
  `);

  const applied = new Set(
    db
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all()
      .map((row) => (row as { version: number }).version),
  );

  const now = Date.now();
  let lastApplied = -1;
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) {
      lastApplied = migration.version;
      continue;
    }
    db.exec("BEGIN");
    try {
      db.exec(migration.up);
      db
        .prepare(
          "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
        )
        .run(migration.version, now);
      db.exec("COMMIT");
      lastApplied = migration.version;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  return lastApplied;
}
