/**
 * AgentExecutionCoordinator — run-context + owner-key types (design doc §8.2).
 *
 * Every Agent prompt run (from Web, Telegram, Scheduler, or API) is described
 * by an `AgentRunContext`. The owner key makes "who owns this session right
 * now" answerable so two clients can't drive the same session at once (§8.1,
 * §8.5) and a non-owning client's `extension_ui_response` can be rejected
 * with a 409 (§8.6).
 */

/** Where a run originated. */
export type RunSource = "web" | "telegram" | "scheduler" | "api";

export interface AgentRunContext {
  /** Unique id for this run (correlates with the owning client's run id). */
  runId: string;
  /** The Pi session being driven. */
  sessionId: string;
  source: RunSource;
  /**
   * Stable identity of the owning client:
   *   - telegram → `telegram:{chatId}:{threadId}`
   *   - web      → `web:{clientId}`
   *   - scheduler→ `scheduler:{taskRunId}`
   *   - api      → `api:{requestId|label}`
   */
  ownerKey: string;
  /** Epoch ms when the lock was acquired. */
  startedAt: number;
  /** Human-readable label for busy messages, e.g. "Telegram" / "Web". */
  sourceLabel: string;
}

// ---------------------------------------------------------------------------
// Owner-key builders
// ---------------------------------------------------------------------------

export function telegramOwnerKey(chatId: number, threadId: number): string {
  return `telegram:${chatId}:${threadId}`;
}

export function webOwnerKey(clientId: string): string {
  return `web:${clientId}`;
}

export function schedulerOwnerKey(taskRunId: string): string {
  return `scheduler:${taskRunId}`;
}

export function apiOwnerKey(label: string): string {
  return `api:${label}`;
}

export const SOURCE_LABELS: Record<RunSource, string> = {
  web: "Web",
  telegram: "Telegram",
  scheduler: "Scheduler",
  api: "API",
};
