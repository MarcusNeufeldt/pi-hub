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

import { SchedulerError, SchedulerErrorCode } from "./errors";
import {
  runPromptAndWait,
  type WaiterSession,
} from "./prompt-run-waiter";
import type { ExecutionOptions, TaskRun } from "./types";

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
  options: { startSession: SessionStarter; progress: RunProgress; signal?: AbortSignal },
): Promise<void> {
  const { startSession, progress, signal } = options;
  const execution = JSON.parse(
    run.executionOptionsSnapshotJson,
  ) as ExecutionOptions;

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

  // 2. Create a fresh Pi Session.
  let session: RpcSession;
  try {
    session = await startSession(
      `__scheduled_task__${run.id}`,
      "",
      cwd,
      {
        ...(execution.toolNames.length ? { toolNames: execution.toolNames } : {}),
        ...(execution.provider && execution.modelId
          ? { initialModel: { provider: execution.provider, modelId: execution.modelId } }
          : {}),
        ...(execution.thinkingLevel
          ? { thinkingLevel: execution.thinkingLevel as never }
          : {}),
      },
    );
  } catch (error) {
    progress.onFinish({
      status: "failed",
      resultExcerpt: null,
      errorCode: SchedulerErrorCode.PROMPT_FAILED,
      errorMessage: `Failed to create Pi session: ${
        error instanceof Error ? error.message : String(error)
      }`,
      warnings: [],
    });
    return;
  }

  progress.onSessionStarted(session.sessionId);

  // Heartbeat interval for stale-run detection (§19). Stopped in finally.
  const heartbeat = setInterval(() => progress.onHeartbeat(), 30_000);

  try {
    // 3. Name the session so it's recognizable in the session list.
    try {
      await session.send({
        type: "set_session_name",
        name: buildSessionName(run.taskNameSnapshot, run.scheduledFor),
      });
    } catch {
      // Non-fatal — naming is cosmetic.
    }

    // 4. Prompt + wait. The waiter handles extension auto-cancel + timeout.
    const result = await runPromptAndWait(
      session as WaiterSession,
      buildPrompt(run.promptSnapshot),
      execution.timeoutSeconds * 1000,
      { signal },
    );

    // 5. Capture result excerpt (best-effort).
    let excerpt: string | null = null;
    if (result.ok) {
      try {
        const res = (await session.send({
          type: "get_last_assistant_text",
        })) as { text?: string } | undefined;
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
      await session.shutdown();
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
