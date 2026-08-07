/**
 * Public entrypoint for the Pi Hub scheduler module.
 *
 * Importers (instrumentation.ts, API routes, tests) go through here so the
 * internal file layout can evolve without churning call sites. Everything the
 * rest of the app needs is re-exported below.
 */

export { startSchedulerRuntime, getSchedulerRuntime, SchedulerRuntime } from "./scheduler-runtime";
export { TaskService } from "./task-service";
export { SqliteTaskStore } from "./sqlite-task-store";
export {
  resolveSchedule,
  calculateNextRun,
  previewNextRun,
  cronFromDaily,
  nextDailyRun,
} from "./schedule-calculator";
export { SchedulerError, SchedulerErrorCode, validationError } from "./errors";
export { NoopTaskNotifier } from "./task-notifier";
export { executeRun, buildPrompt, buildSessionName } from "./pi-task-executor";
export { scanOnce } from "./due-task-scanner";
export { getDbPath, getHubHome, ensureHubHome, getDbPathDisplay } from "./paths";

export type {
  TaskDefinition,
  TaskRun,
  TaskRunSummary,
  TaskStatus,
  RunStatus,
  ScheduleType,
  ScheduleKind,
  ScheduleInput,
  DailyScheduleInput,
  OnceScheduleInput,
  PersistedSchedule,
  ExecutionOptions,
  CreateTaskInput,
  UpdateTaskPatch,
  TriggerType,
  OverlapPolicy,
  MisfirePolicy,
  SchedulerRuntimeStatus,
} from "./types";

export type { TaskStore } from "./task-store";
export type { TaskNotifier, TaskRunNotification } from "./task-notifier";
