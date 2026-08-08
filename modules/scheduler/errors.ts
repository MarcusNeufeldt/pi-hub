/**
 * Pi Hub scheduler error model.
 *
 * A single `SchedulerError` carries a stable string `code` (design doc §24)
 * plus an HTTP status used by route handlers. Callers can either throw
 * directly or pattern-match on `code` at the API edge.
 */

export const SchedulerErrorCode = {
  TASK_NOT_FOUND: "TASK_NOT_FOUND",
  RUN_NOT_FOUND: "RUN_NOT_FOUND",
  TASK_PAUSED: "TASK_PAUSED",
  REVISION_CONFLICT: "REVISION_CONFLICT",
  INVALID_SCHEDULE: "INVALID_SCHEDULE",
  INVALID_TIMEZONE: "INVALID_TIMEZONE",
  INVALID_CRON: "INVALID_CRON",
  CWD_NOT_FOUND: "CWD_NOT_FOUND",
  CWD_INVALID: "CWD_INVALID",
  TASK_ALREADY_RUNNING: "TASK_ALREADY_RUNNING",
  MODEL_UNAVAILABLE: "MODEL_UNAVAILABLE",
  PROMPT_FAILED: "PROMPT_FAILED",
  TASK_TIMEOUT: "TASK_TIMEOUT",
  TASK_CANCELLED: "TASK_CANCELLED",
  PROCESS_RESTARTED: "PROCESS_RESTARTED",
  SCHEDULER_NOT_LEADER: "SCHEDULER_NOT_LEADER",
  SCHEDULER_UNAVAILABLE: "SCHEDULER_UNAVAILABLE",
  DATABASE_ERROR: "DATABASE_ERROR",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  NOTIFICATION_FAILED: "NOTIFICATION_FAILED",
  RUN_NOT_CANCELLABLE: "RUN_NOT_CANCELLABLE",
  SESSION_NOT_FOUND: "SESSION_NOT_FOUND",
  SESSION_BUSY: "SESSION_BUSY",
} as const;

export type SchedulerErrorCodeValue =
  (typeof SchedulerErrorCode)[keyof typeof SchedulerErrorCode];

/** Default HTTP status per error code. */
const STATUS_BY_CODE: Record<SchedulerErrorCodeValue, number> = {
  [SchedulerErrorCode.TASK_NOT_FOUND]: 404,
  [SchedulerErrorCode.RUN_NOT_FOUND]: 404,
  [SchedulerErrorCode.TASK_PAUSED]: 409,
  [SchedulerErrorCode.REVISION_CONFLICT]: 409,
  [SchedulerErrorCode.INVALID_SCHEDULE]: 400,
  [SchedulerErrorCode.INVALID_TIMEZONE]: 400,
  [SchedulerErrorCode.INVALID_CRON]: 400,
  [SchedulerErrorCode.CWD_NOT_FOUND]: 400,
  [SchedulerErrorCode.CWD_INVALID]: 400,
  [SchedulerErrorCode.TASK_ALREADY_RUNNING]: 409,
  [SchedulerErrorCode.MODEL_UNAVAILABLE]: 400,
  [SchedulerErrorCode.PROMPT_FAILED]: 500,
  [SchedulerErrorCode.TASK_TIMEOUT]: 500,
  [SchedulerErrorCode.TASK_CANCELLED]: 500,
  [SchedulerErrorCode.PROCESS_RESTARTED]: 500,
  [SchedulerErrorCode.SCHEDULER_NOT_LEADER]: 503,
  [SchedulerErrorCode.SCHEDULER_UNAVAILABLE]: 503,
  [SchedulerErrorCode.DATABASE_ERROR]: 500,
  [SchedulerErrorCode.VALIDATION_ERROR]: 400,
  [SchedulerErrorCode.NOTIFICATION_FAILED]: 500,
  [SchedulerErrorCode.RUN_NOT_CANCELLABLE]: 409,
  [SchedulerErrorCode.SESSION_NOT_FOUND]: 400,
  [SchedulerErrorCode.SESSION_BUSY]: 409,
};

export class SchedulerError extends Error {
  readonly code: SchedulerErrorCodeValue;
  readonly httpStatus: number;

  constructor(
    code: SchedulerErrorCodeValue,
    message?: string,
    { httpStatus }: { httpStatus?: number } = {},
  ) {
    super(message ?? code);
    this.name = "SchedulerError";
    this.code = code;
    this.httpStatus = httpStatus ?? STATUS_BY_CODE[code] ?? 500;
  }

  /** True when this error code maps to a client-side problem (4xx). */
  isClientError(): boolean {
    return this.httpStatus >= 400 && this.httpStatus < 500;
  }
}

/** Convenience factory for validation failures (HTTP 400). */
export function validationError(message: string): SchedulerError {
  return new SchedulerError(SchedulerErrorCode.VALIDATION_ERROR, message);
}
