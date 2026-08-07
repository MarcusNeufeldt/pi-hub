/**
 * SchedulerRuntime — singleton that owns the scheduler lifecycle.
 *
 * Responsibilities:
 *   - idempotent startup (globalThis guard, §30.7) keyed on `__piHubSchedulerRuntime`
 *   - DB open + migration + stale-run recovery (§19)
 *   - leader lease acquisition + renewal (§8.2)
 *   - scanner tick (§8.3) and execution queue (concurrency 1, overlap skip)
 *   - status reporting for /api/scheduler/status
 *
 * The runtime does NOT hold DB transactions across Agent work (§30.4). Runs
 * claimed by the scanner are executed through `executeRun`, with progress
 * persisted between phases (session-started / heartbeat / finish).
 */

import { randomUUID } from "crypto";

import { scanOnce } from "./due-task-scanner";
import { executeRun, createRealSessionStarter, type RunProgress, type SessionStarter } from "./pi-task-executor";
import { safeNotify, NoopTaskNotifier, type TaskNotifier } from "./task-notifier";
import { SqliteTaskStore } from "./sqlite-task-store";
import { ensureHubHome, getDbPath, getDbPathDisplay } from "./paths";
import { TaskService } from "./task-service";
import type { TaskStore } from "./task-store";
import type { SchedulerRuntimeStatus, TaskRun } from "./types";

const LEASE_NAME = "scheduler";
const LEASE_MS = 15_000; // lease validity
const LEASE_RENEW_MS = 5_000; // renewal cadence
const TICK_MS = 10_000; // scan frequency
const HEARTBEAT_TIMEOUT_MS = 90_000; // stale-run cutoff (3 missed heartbeats)
const MAX_CONCURRENCY = 1;

interface RuntimeInternals {
  store: SqliteTaskStore;
  service: TaskService;
  notifier: TaskNotifier;
  ownerId: string;
  startSession: SessionStarter;
  leaseTimer: ReturnType<typeof setInterval>;
  scanTimer: ReturnType<typeof setInterval>;
  lastTickAt: number;
  leader: boolean;
  /** Active cancellers keyed by run id (for cancel + stop). */
  active: Map<string, AbortController>;
  stopped: boolean;
  error: string | null;
}

declare global {
  var __piHubSchedulerRuntime: SchedulerRuntime | undefined;
}

export class SchedulerRuntime {
  private inner: RuntimeInternals | null = null;

  /** True once the runtime has been started (successfully or not). */
  get started(): boolean {
    return this.inner !== null;
  }

  /**
   * Starts the runtime. Idempotent within a process — subsequent calls return
   * the existing instance. Throws on migration/DB failure so the caller
   * (instrumentation.ts) can catch and keep the web server running with a
   * clearly-reported scheduler error state (§9.3).
   */
  async start(options?: {
    store?: SqliteTaskStore;
    startSession?: SessionStarter;
    notifier?: TaskNotifier;
  }): Promise<void> {
    if (this.inner) return;

    ensureHubHome();
    const store = options?.store ?? SqliteTaskStore.open(getDbPath());
    const service = new TaskService(store);
    const notifier = options?.notifier ?? new NoopTaskNotifier();

    // Stale-run recovery: any 'running' run whose heartbeat is stale belonged
    // to a previous process. Mark interrupted; do not re-run (§19).
    const recovered = store.markStaleRunningAsInterrupted(
      Date.now(),
      HEARTBEAT_TIMEOUT_MS,
    );
    if (recovered > 0) {
      console.warn(
        `[pi-hub:scheduler] marked ${recovered} stale run(s) as interrupted`,
      );
    }

    const ownerId = randomUUID();
    const inner: RuntimeInternals = {
      store,
      service,
      notifier,
      ownerId,
      startSession: options?.startSession ?? lazyStarter,
      leaseTimer: undefined as never,
      scanTimer: undefined as never,
      lastTickAt: 0,
      leader: false,
      active: new Map(),
      stopped: false,
      error: null,
    };
    this.inner = inner;

    // Attempt initial lease acquisition; non-fatal if not leader yet.
    inner.leader = store.tryAcquireLease(LEASE_NAME, ownerId, LEASE_MS);

    inner.leaseTimer = setInterval(() => this.renewLease(), LEASE_RENEW_MS);
    inner.scanTimer = setInterval(() => this.tick(), TICK_MS);

    // Kick an immediate scan so newly-started runtimes don't wait 10s.
    void this.tick();
    console.info(
      `[pi-hub:scheduler] started (leader=${inner.leader}, db=${getDbPathDisplay()})`,
    );
  }

  /** Stops timers and rejects active runs. Safe to call multiple times. */
  stop(): void {
    const inner = this.inner;
    if (!inner) return;
    inner.stopped = true;
    clearInterval(inner.leaseTimer);
    clearInterval(inner.scanTimer);
    for (const controller of inner.active.values()) {
      controller.abort();
    }
    inner.active.clear();
    try {
      inner.store.close();
    } catch {
      // ignore
    }
    this.inner = null;
    console.info("[pi-hub:scheduler] stopped");
  }

  /** Current status for /api/scheduler/status. */
  getStatus(): SchedulerRuntimeStatus {
    const inner = this.inner;
    if (!inner) {
      return {
        running: false,
        leader: false,
        ownerId: null,
        lastTickAt: null,
        nextTickAt: null,
        queuedRuns: 0,
        runningRuns: 0,
        maxConcurrency: MAX_CONCURRENCY,
        databasePath: getDbPathDisplay(),
        error: null,
      };
    }
    const queuedRuns = inner.store.countRuns({ status: "queued" });
    const runningRuns = inner.store.countRuns({ status: "running" });
    return {
      running: !inner.stopped,
      leader: inner.leader,
      ownerId: inner.ownerId,
      lastTickAt: inner.lastTickAt || null,
      nextTickAt: inner.lastTickAt ? inner.lastTickAt + TICK_MS : null,
      queuedRuns,
      runningRuns,
      maxConcurrency: MAX_CONCURRENCY,
      databasePath: getDbPathDisplay(),
      error: inner.error,
    };
  }

  /** Service accessor for API routes. */
  getTaskService(): TaskService {
    const inner = this.inner;
    if (!inner) {
      throw new Error("Scheduler runtime not started");
    }
    return inner.service;
  }

  /** Store accessor (file-access root registration, tests). */
  getStore(): TaskStore | null {
    return this.inner?.store ?? null;
  }

  // ---- internal ------------------------------------------------------------

  private renewLease(): void {
    const inner = this.inner;
    if (!inner || inner.stopped) return;
    const wasLeader = inner.leader;
    inner.leader = inner.store.renewLease(LEASE_NAME, inner.ownerId, LEASE_MS)
      || inner.store.tryAcquireLease(LEASE_NAME, inner.ownerId, LEASE_MS);
    if (wasLeader && !inner.leader) {
      console.warn("[pi-hub:scheduler] lost leader lease");
    } else if (!wasLeader && inner.leader) {
      console.info("[pi-hub:scheduler] acquired leader lease");
    }
  }

  private async tick(): Promise<void> {
    const inner = this.inner;
    if (!inner || inner.stopped) return;
    inner.lastTickAt = Date.now();
    if (!inner.leader) return; // only the leader scans/executes

    try {
      // Also process any queued runs (e.g. manual triggers) up to concurrency.
      this.drainQueued(inner);
      const { claimed, skipped } = scanOnce(inner.store, Date.now());
      for (const run of claimed) {
        void this.execute(inner, run);
      }
      if (skipped.length) {
        console.debug(
          `[pi-hub:scheduler] skipped ${skipped.length} run(s) this tick`,
        );
      }
    } catch (error) {
      console.error(
        "[pi-hub:scheduler] tick failed",
        error instanceof Error ? error.message : error,
      );
    }
  }

  /** Picks queued runs off the store (manual triggers land there) and runs them. */
  private drainQueued(inner: RuntimeInternals): void {
    if (inner.active.size >= MAX_CONCURRENCY) return;
    const queued = inner.store.listRuns({ status: "queued", limit: MAX_CONCURRENCY });
    for (const q of queued) {
      if (inner.active.size >= MAX_CONCURRENCY) break;
      const full = inner.store.getRun(q.id);
      if (full && full.status === "queued") {
        void this.execute(inner, full);
      }
    }
  }

  private async execute(inner: RuntimeInternals, run: TaskRun): Promise<void> {
    // Overlap guard: same task already running → skip this run.
    if (run.taskId) {
      const conflict = inner.store
        .listRuns({ taskId: run.taskId, status: "running", limit: 1 })
        .find((r) => r.id !== run.id);
      if (conflict) {
        inner.store.updateRun(run.id, {
          status: "skipped",
          finishedAt: Date.now(),
          errorCode: "TASK_ALREADY_RUNNING",
          errorMessage: `Another run for this task is already in progress (${conflict.id})`,
        });
        return;
      }
    }

    // Mark running + register canceller.
    const controller = new AbortController();
    inner.active.set(run.id, controller);
    inner.store.updateRun(run.id, {
      status: "running",
      startedAt: Date.now(),
      heartbeatAt: Date.now(),
    });
    const refreshed = inner.store.getRun(run.id) ?? run;
    await safeNotify(inner.notifier, "onRunStarted", {
      run: refreshed,
      taskName: refreshed.taskNameSnapshot,
    });

    const progress: RunProgress = {
      onSessionStarted: (sessionId) => {
        inner.store.updateRun(run.id, { sessionId, heartbeatAt: Date.now() });
      },
      onHeartbeat: () => {
        inner.store.updateRun(run.id, { heartbeatAt: Date.now() });
      },
      onFinish: (result) => {
        const finalStatus = result.status;
        inner.store.updateRun(run.id, {
          status: finalStatus,
          resultExcerpt: result.resultExcerpt,
          errorCode: result.errorCode,
          errorMessage: result.errorMessage,
          finishedAt: Date.now(),
        });
        const finished = inner.store.getRun(run.id);
        if (finished) {
          void safeNotify(
            inner.notifier,
            finalStatus === "success" ? "onRunSucceeded" : "onRunFailed",
            { run: finished, taskName: finished.taskNameSnapshot },
          );
        }
      },
    };

    try {
      await executeRun(refreshed, {
        startSession: inner.startSession,
        progress,
        signal: controller.signal,
      });
    } catch (error) {
      // executeRun is not supposed to throw, but guard the queue anyway.
      inner.store.updateRun(run.id, {
        status: "failed",
        errorCode: "PROMPT_FAILED",
        errorMessage: error instanceof Error ? error.message : String(error),
        finishedAt: Date.now(),
      });
    } finally {
      inner.active.delete(run.id);
    }
  }
}

// ---- singleton accessors ----------------------------------------------------

/**
 * Starts (idempotently) and returns the process-wide runtime. The first call
 * opens the DB + begins scanning; later calls return the same instance.
 * Migration/DB failures are caught and reported via the runtime's status
 * (the web server keeps running, §9.3).
 */
export async function startSchedulerRuntime(options?: {
  notifier?: TaskNotifier;
}): Promise<SchedulerRuntime> {
  if (!globalThis.__piHubSchedulerRuntime) {
    const runtime = new SchedulerRuntime();
    try {
      await runtime.start(options?.notifier ? { notifier: options.notifier } : undefined);
      globalThis.__piHubSchedulerRuntime = runtime;
    } catch (error) {
      // Record the error but keep a runtime instance so status reflects it.
      globalThis.__piHubSchedulerRuntime = makeFailedRuntime(
        error instanceof Error ? error.message : String(error),
      );
      console.error(
        "[pi-hub:scheduler] init failed — web server continues without scheduler",
        error,
      );
    }
  }
  return globalThis.__piHubSchedulerRuntime;
}

/** Builds a runtime instance whose status reports `error` and nothing else. */
function makeFailedRuntime(error: string): SchedulerRuntime {
  const failed = new SchedulerRuntime();
  // Stamp an error-only payload onto the private slot so getStatus() surfaces it.
  const stub: RuntimeInternals = {
    store: undefined as never,
    service: undefined as never,
    notifier: new NoopTaskNotifier(),
    ownerId: "",
    startSession: undefined as never,
    leaseTimer: undefined as never,
    scanTimer: undefined as never,
    lastTickAt: 0,
    leader: false,
    active: new Map(),
    stopped: true,
    error,
  };
  (failed as unknown as { inner: RuntimeInternals | null }).inner = stub;
  return failed;
}

/** Returns the current runtime (may be a failed/stopped instance). */
export function getSchedulerRuntime(): SchedulerRuntime | undefined {
  return globalThis.__piHubSchedulerRuntime;
}

// ---- default session starter (lazy import to keep Edge bundles clean) ------

let defaultSessionStarter: SessionStarter | null = null;
async function buildDefaultStarter(): Promise<SessionStarter> {
  if (defaultSessionStarter) return defaultSessionStarter;
  // Dynamic import so the scheduler module can be loaded in non-Pi contexts
  // (e.g. tests) without pulling the full rpc-manager graph.
  const { startRpcSession } = await import("@/lib/rpc-manager");
  defaultSessionStarter = createRealSessionStarter(
    startRpcSession as never,
  );
  return defaultSessionStarter;
}

/** Proxy starter that resolves the real one lazily on first use. */
const lazyStarter: SessionStarter = async (...args) =>
  (await buildDefaultStarter())(...args);
