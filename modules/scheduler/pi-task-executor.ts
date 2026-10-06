/**
 * PiTaskExecutor — runs a scheduled task by reusing the existing Pi
 * AgentSession pipeline (AGENTS.local.md §4 — no second execution path).
 *
 * Each run:
 *   1. validates the snapshot cwd still exists (realpath),
 *   2. creates a brand-new Pi Session via `startRpcSession`,
 *   3. sets a recognizable session name,
 *   4. sends the unattended prompt and waits for `prompt_done`,
 *   5. captures the last assistant text (≤4000 chars) as `result_excerpt`,
 *   6. shuts the session down.
 *
 * The executor never holds a DB transaction across Agent work (§30.4). It
 * updates the run via a `RunProgress` callback so the runtime/store layer
 * owns persistence.
 */

import { existsSync, realpathSync } from "fs";
import { exec } from "node:child_process";
import { promisify } from "node:util";

import { SchedulerError, SchedulerErrorCode } from "./errors";
import {
  runPromptAndWait,
  type WaiterSession,
} from "./prompt-run-waiter";
import type { ExecutionOptions, ResumeTarget, TaskRun } from "./types";

/** Progress callbacks so the runtime can persist state without DB coupling here. */
export interface RunProgress {
  /** Called as soon as the Pi session id is known. */
  onSessionStarted(sessionId: string): void;
  /** Heartbeat while running (design doc §19 stale-run detection). */
  onHeartbeat(): void;
  /** Final outcome. */
  onFinish(result: {
    status: "success" | "failed";
    resultExcerpt: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    warnings: string[];
  }): void;
}

/** Minimal shape needed from `lib/rpc-manager`'s startRpcSession return. */
export interface RpcSession {
  sessionId: string;
  sessionFile: string;
  onEvent(listener: (event: { type: string; [k: string]: unknown }) => void): () => void;
  send(command: Record<string, unknown>): Promise<unknown>;
  shutdown(): Promise<void>;
}

/** Factory indirection so tests can inject a fake session creator. */
export type SessionStarter = (
  tempKey: string,
  sessionFile: string,
  cwd: string,
  options: {
    toolNames?: string[];
    initialModel?: { provider: string; modelId: string };
    thinkingLevel?: string;
  },
) => Promise<RpcSession>;

const MAX_EXCERPT = 4000;
/** Hard cap for the pre-flight gate; stays well under the 90s run-heartbeat
 *  window so a slow gate cannot get the run reaped. */
const GATE_TIMEOUT_MS = 60_000;
const execAsync = promisify(exec);

/**
 * Rejects with TASK_TIMEOUT once `deadline` passes even if `promise` never
 * settles. The prompt waiter enforces its own timeout, but session startup
 * and setup sends had none — a hung call there kept the run "running"
 * forever and every later fire skipped (TASK_ALREADY_RUNNING).
 */
function withDeadline<T>(promise: Promise<T>, deadline: number, label: string): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    return Promise.reject(
      new SchedulerError(SchedulerErrorCode.TASK_TIMEOUT, `${label} timed out`),
    );
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(
        new SchedulerError(
          SchedulerErrorCode.TASK_TIMEOUT,
          `${label} timed out after ${Math.round(remaining / 1000)}s`,
        ),
      ),
      remaining,
    );
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

/** Builds the unattended-execution prompt envelope (design doc §16.3). */
export function buildPrompt(userPrompt: string): string {
  return [
    "[Pi Hub Scheduled Execution]",
    "This is an unattended task. Do not wait for interactive user input.",
    "Make safe, reasonable decisions. If blocked, explain the blocker in the final response.",
    "",
    "<User Prompt>",
    userPrompt.trim(),
  ].join("\n");
}

/**
 * Resume-mode prompt envelope (resume §8). Sent to an already-existing
 * session that was interrupted (typically by a provider rate limit). Instructs
 * the model to pick up from where it stopped WITHOUT redoing completed work.
 */
export function buildResumePrompt(originalTaskPrompt: string): string {
  return [
    "[Pi Hub Resume Execution]",
    "The previous run in this session was interrupted before completion",
    "(most likely by a provider rate limit or quota).",
    "",
    "Instructions:",
    "1. Review the conversation above to see what was already accomplished.",
    "2. Do NOT redo work that already succeeded.",
    "3. Resume the task from where it stopped. If the last action failed",
    "   mid-way, assess its partial effects before continuing.",
    "4. If a blocker remains, explain it in the final response.",
    "",
    "<Original task for reference>",
    originalTaskPrompt.trim(),
  ].join("\n");
}

/** Session display name like "[Task] Daily Review · 2026-08-07 08:00". */
export function buildSessionName(taskName: string, scheduledFor: number): string {
  const d = new Date(scheduledFor);
  const pad = (n: number) => n.toString().padStart(2, "0");
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(
    d.getDate(),
  )} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `[Task] ${taskName} · ${stamp}`;
}

/**
 * Executes a single run. Resolves with the final status. Never throws —
 * failures are reported through `progress.onFinish` with error metadata, so
 * the runtime's queue loop stays simple.
 */
export async function executeRun(
  run: TaskRun,
  options: {
    startSession: SessionStarter;
    progress: RunProgress;
    signal?: AbortSignal;
    /** In-process mutex check for resume mode (resume §9). Injected by runtime. */
    isSessionInUse?: (sessionId: string) => boolean;
  },
): Promise<void> {
  const { startSession, progress, signal, isSessionInUse } = options;
  if (signal?.aborted) {
    progress.onFinish({
      status: "failed", resultExcerpt: null, errorCode: SchedulerErrorCode.TASK_CANCELLED,
      errorMessage: "Cancelled before session startup", warnings: [],
    });
    return;
  }
  const execution = JSON.parse(
    run.executionOptionsSnapshotJson,
  ) as ExecutionOptions;
  // Overall budget for the whole run (startup + prompt + teardown).
  const deadline = Date.now() + execution.timeoutSeconds * 1000;

  // Resume target: when set, continue an existing session instead of creating
  // a fresh one (docs/pi-hub/scheduled-execution-resume-design.zh-CN.md).
  const resume = run.resumeSnapshotJson
    ? (JSON.parse(run.resumeSnapshotJson) as ResumeTarget)
    : null;

  // 1. Re-check the snapshot cwd (§23.1) — it may have been removed.
  if (!existsSync(run.cwdSnapshot)) {
    progress.onFinish({
      status: "failed",
      resultExcerpt: null,
      errorCode: SchedulerErrorCode.CWD_NOT_FOUND,
      errorMessage: `Working directory no longer exists: ${run.cwdSnapshot}`,
      warnings: [],
    });
    return;
  }
  let cwd: string;
  try {
    cwd = realpathSync(run.cwdSnapshot);
  } catch {
    progress.onFinish({
      status: "failed",
      resultExcerpt: null,
      errorCode: SchedulerErrorCode.CWD_NOT_FOUND,
      errorMessage: `Working directory not accessible: ${run.cwdSnapshot}`,
      warnings: [],
    });
    return;
  }

  // 2. Resume-mode guards: target file must exist and must not be in active
  //    use by the browser (concurrent writes corrupt the jsonl, resume §9).
  if (resume) {
    if (!existsSync(resume.sessionFile)) {
      progress.onFinish({
        status: "failed",
        resultExcerpt: null,
        errorCode: SchedulerErrorCode.SESSION_NOT_FOUND,
        errorMessage: `Session file no longer exists: ${resume.sessionFile}`,
        warnings: [],
      });
      return;
    }
    if (isSessionInUse?.(resume.sessionId)) {
      // SESSION_BUSY is recoverable: the runtime reschedules a once resume
      // task with a short interval (resume §9) instead of letting it die —
      // the claim already advanced the once task to `completed`, so without
      // rescheduling this run the task would be permanently lost.
      progress.onFinish({
        status: "failed",
        resultExcerpt: null,
        errorCode: SchedulerErrorCode.SESSION_BUSY,
        errorMessage: `Session ${resume.sessionId} is currently active (open in the browser?). Skipped to avoid concurrent writes.`,
        warnings: [],
      });
      return;
    }
  }

  // 2.5 Optional deterministic gate: skip the run without starting Pi when
  //     the gate exits non-zero. Exit 0 = proceed; spawn errors/timeouts fail
  //     the run loudly so a broken gate never silently disables the task.
  if (execution.gateCommand && !signal?.aborted) {
    try {
      const gate = await execAsync(execution.gateCommand, {
        cwd,
        timeout: GATE_TIMEOUT_MS,
        windowsHide: true,
      });
      void gate; // exit 0 → proceed
    } catch (error) {
      // promisified exec rejects on non-zero exit with a numeric .code, and
      // on spawn/timeout failures with a string code (ENOENT) or .killed.
      const err = error as NodeJS.ErrnoException & {
        killed?: boolean;
        stdout?: string | Buffer;
        stderr?: string | Buffer;
      };
      if (typeof err.code !== "number" || err.killed) {
        const detail = error instanceof Error ? error.message : String(error);
        progress.onFinish({
          status: "failed",
          resultExcerpt: null,
          errorCode: SchedulerErrorCode.PROMPT_FAILED,
          errorMessage: `Gate command failed: ${detail}`,
          warnings: [],
        });
        return;
      }
      const output = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim();
      progress.onFinish({
        status: "success",
        resultExcerpt: `Gate skip (exit ${err.code}): ${output.slice(0, 200)}`,
        errorCode: null,
        errorMessage: null,
        warnings: [],
      });
      return;
    }
  }

  // 3. Start (new) or resume (open) the Pi Session.
  const heartbeat = setInterval(() => progress.onHeartbeat(), 30_000);
  let session: RpcSession | undefined;
  const startPromise = startSession(
    `__scheduled_task__${run.id}`,
    resume?.sessionFile ?? "",
    cwd,
    {
      ...(execution.toolNames !== undefined ? { toolNames: execution.toolNames } : {}),
      ...(execution.provider && execution.modelId
        ? { initialModel: { provider: execution.provider, modelId: execution.modelId } }
        : {}),
      ...(execution.thinkingLevel
        ? { thinkingLevel: execution.thinkingLevel as never }
        : {}),
    },
  );
  try {
    session = await withDeadline(startPromise, deadline, "Pi session startup");
  } catch (error) {
    clearInterval(heartbeat);
    // If the session arrives late anyway, shut it down so a hung startup
    // cannot leak a live Pi process.
    void startPromise.then((late) => {
      void withDeadline(late.shutdown(), Date.now() + 10_000, "Late session shutdown")
        .catch(() => undefined);
    }).catch(() => undefined);
    progress.onFinish({
      status: "failed",
      resultExcerpt: null,
      errorCode: error instanceof SchedulerError ? error.code : SchedulerErrorCode.PROMPT_FAILED,
      errorMessage: `Failed to create Pi session: ${
        error instanceof Error ? error.message : String(error)
      }`,
      warnings: [],
    });
    return;
  }

  progress.onSessionStarted(session.sessionId);

  try {
    // 4. Name NEW sessions only — resume mode keeps the original session name.
    if (!resume && !signal?.aborted) {
      try {
        await withDeadline(session.send({
          type: "set_session_name",
          name: buildSessionName(run.taskNameSnapshot, run.scheduledFor),
        }), deadline, "set_session_name");
      } catch {
        // Non-fatal — naming is cosmetic.
      }
    }

    // 5. Resume mode: override the model. startRpcSession ignores initialModel
    //    for sessions with existing messages (resume §10), so set it explicitly.
    if (resume?.provider && resume?.modelId && !signal?.aborted) {
      try {
        await withDeadline(session.send({
          type: "set_model",
          provider: resume.provider,
          modelId: resume.modelId,
        }), deadline, "set_model");
      } catch {
        // Non-fatal — fall back to the session's saved model.
      }
    }

    // 6. Prompt + wait. The waiter handles extension auto-cancel + timeout;
    // give it the remaining budget so the total run cannot exceed the deadline.
    const result = await runPromptAndWait(
      session as WaiterSession,
      resume
        ? buildResumePrompt(run.promptSnapshot)
        : buildPrompt(run.promptSnapshot),
      Math.max(1000, deadline - Date.now()),
      { signal },
    );

    // 5. Capture result excerpt (best-effort).
    let excerpt: string | null = null;
    if (result.ok) {
      try {
        const res = (await withDeadline(session.send({
          type: "get_last_assistant_text",
        }), deadline, "Reading result text")) as { text?: string } | undefined;
        if (res?.text) {
          excerpt = res.text.length > MAX_EXCERPT ? res.text.slice(0, MAX_EXCERPT) : res.text;
        }
      } catch {
        // Best-effort; failure to read text shouldn't fail the run.
      }
    }

    progress.onFinish({
      status: result.ok ? "success" : "failed",
      resultExcerpt: excerpt,
      errorCode: result.ok
        ? null
        : signal?.aborted
          ? SchedulerErrorCode.TASK_CANCELLED
          : SchedulerErrorCode.PROMPT_FAILED,
      errorMessage: result.error,
      warnings: result.warnings,
    });
  } catch (error) {
    progress.onFinish({
      status: "failed",
      resultExcerpt: null,
      errorCode: SchedulerErrorCode.PROMPT_FAILED,
      errorMessage: error instanceof Error ? error.message : String(error),
      warnings: [],
    });
  } finally {
    clearInterval(heartbeat);
    try {
      // A hung shutdown must not keep the run (and the queue slot) hostage.
      await withDeadline(session.shutdown(), Date.now() + 10_000, "Session shutdown");
    } catch {
      // Swallow — we've already recorded the outcome.
    }
  }
}

/**
 * Adapts the real `startRpcSession` from lib/rpc-manager to the executor's
 * `SessionStarter` shape. Lives here (not in rpc-manager) to keep upstream
 * free of scheduler imports (AGENTS.local.md §1).
 */
export function createRealSessionStarter(startRpcSession: (
  sessionId: string,
  sessionFile: string,
  cwd: string | undefined,
  options: {
    toolNames?: string[];
    initialModel?: { provider: string; modelId: string };
    thinkingLevel?: string;
  },
) => Promise<{
  session: {
    sessionId: string;
    sessionFile: string;
    onEvent(l: (e: { type: string; [k: string]: unknown }) => void): () => void;
    send(c: Record<string, unknown>): Promise<unknown>;
    shutdown(): Promise<void>;
  };
}>): SessionStarter {
  return async (tempKey, sessionFile, cwd, options) => {
    const { session } = await startRpcSession(tempKey, sessionFile, cwd, options);
    return session;
  };
}

// Re-export for callers that want the typed error.
export { SchedulerError };
