/**
 * Notification port for the Pi Hub scheduler (design doc §22).
 *
 * The scheduler never depends on TelePi directly — it emits events through
 * this interface. V1 ships `NoopTaskNotifier`; a future `TelePiTaskNotifier`
 * implements the same shape. Notification failures MUST NOT alter a run's
 * final Agent state (design doc §30.10) — handlers swallow errors and log.
 */

import type { TaskRun } from "./types";

export interface TaskRunNotification {
  run: TaskRun;
  taskName: string;
}

/** Event payload for {@link TaskNotifier.onRunDeferred}: a transient failure
 *  that has been auto-rescheduled, NOT a terminal failure. Carries the
 *  rescheduled time + reason so the notifier can word it as "retrying"
 *  instead of "failed". */
export interface TaskRunDeferredNotification extends TaskRunNotification {
  /** UTC epoch ms the task was rescheduled to. */
  nextRunAt: number;
  /** Why it was deferred — drives the message wording. */
  reason: "session_busy" | "rate_limit";
}

export interface TaskNotifier {
  onRunStarted?(event: TaskRunNotification): Promise<void>;
  onRunSucceeded?(event: TaskRunNotification): Promise<void>;
  onRunFailed?(event: TaskRunNotification): Promise<void>;
  /** A transient failure that was auto-rescheduled (not terminal). */
  onRunDeferred?(event: TaskRunDeferredNotification): Promise<void>;
}

/** Default V1 notifier: does nothing. Safe to call unconditionally. */
export class NoopTaskNotifier implements TaskNotifier {
  async onRunStarted(): Promise<void> {}
  async onRunSucceeded(): Promise<void> {}
  async onRunFailed(): Promise<void> {}
  async onRunDeferred(): Promise<void> {}
}

/** The four notification hooks. */
export type TaskNotifierHook =
  | "onRunStarted"
  | "onRunSucceeded"
  | "onRunFailed"
  | "onRunDeferred";

/** Maps a hook to its event payload type (deferred carries extra fields). */
type NotificationEvent<H extends TaskNotifierHook> = H extends "onRunDeferred"
  ? TaskRunDeferredNotification
  : TaskRunNotification;

/**
 * Invokes `notifier[hook](event)` and swallows/log any rejection, so a flaky
 * transport can never flip an Agent run's outcome. (§30.10) Generic so the
 * deferred hook's richer event type is checked at the call site.
 */
export async function safeNotify<H extends TaskNotifierHook>(
  notifier: TaskNotifier,
  hook: H,
  event: NotificationEvent<H>,
): Promise<void> {
  try {
    const fn = notifier[hook] as
      | ((event: NotificationEvent<H>) => Promise<void> | undefined)
      | undefined;
    await fn?.(event);
  } catch (error) {
    console.warn(
      "[pi-hub:notifier] notification failed (run state unchanged)",
      error instanceof Error ? error.message : error,
    );
  }
}
