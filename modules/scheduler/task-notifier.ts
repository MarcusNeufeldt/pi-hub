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

export interface TaskNotifier {
  onRunStarted?(event: TaskRunNotification): Promise<void>;
  onRunSucceeded?(event: TaskRunNotification): Promise<void>;
  onRunFailed?(event: TaskRunNotification): Promise<void>;
}

/** Default V1 notifier: does nothing. Safe to call unconditionally. */
export class NoopTaskNotifier implements TaskNotifier {
  async onRunStarted(): Promise<void> {}
  async onRunSucceeded(): Promise<void> {}
  async onRunFailed(): Promise<void> {}
}

/**
 * Invokes `notifier.hook(event)` and swallows/log any rejection, so a flaky
 * transport can never flip an Agent run's outcome. (§30.10)
 */
export async function safeNotify(
  notifier: TaskNotifier,
  hook: "onRunStarted" | "onRunSucceeded" | "onRunFailed",
  event: TaskRunNotification,
): Promise<void> {
  try {
    await notifier[hook]?.(event);
  } catch (error) {
    console.warn(
      "[pi-hub:notifier] notification failed (run state unchanged)",
      error instanceof Error ? error.message : error,
    );
  }
}
