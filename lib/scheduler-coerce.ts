/**
 * Body-coercion helpers shared by the task create/edit API routes.
 *
 * Keeping these out of the route files lets both `POST /api/tasks` and
 * `PATCH /api/tasks/[id]` apply the same validation, and makes the routes
 * themselves short and readable.
 */

import { validationError } from "@/modules/scheduler";
import type { ExecutionOptions, ScheduleInput } from "@/modules/scheduler";

export function coerceSchedule(raw: unknown): ScheduleInput {
  if (typeof raw !== "object" || raw === null) {
    throw validationError("schedule must be an object");
  }
  const s = raw as {
    type?: unknown;
    time?: unknown;
    localDateTime?: unknown;
    timezone?: unknown;
  };
  if (s.type !== "daily" && s.type !== "once") {
    throw validationError('schedule.type must be "daily" or "once"');
  }
  if (typeof s.timezone !== "string") {
    throw validationError("schedule.timezone is required");
  }
  if (s.type === "daily") {
    if (typeof s.time !== "string") {
      throw validationError('schedule.time is required for "daily"');
    }
    return { type: "daily", time: s.time, timezone: s.timezone };
  }
  if (typeof s.localDateTime !== "string") {
    throw validationError('schedule.localDateTime is required for "once"');
  }
  return { type: "once", localDateTime: s.localDateTime, timezone: s.timezone };
}

export function coercePartialExecution(raw: unknown): Partial<ExecutionOptions> {
  if (!raw || typeof raw !== "object") return {};
  const e = raw as {
    provider?: unknown;
    modelId?: unknown;
    thinkingLevel?: unknown;
    toolNames?: unknown;
    timeoutSeconds?: unknown;
    notifyOnSuccess?: unknown;
    notifyOnFailure?: unknown;
  };
  const out: Partial<ExecutionOptions> = {};
  if (e.provider !== undefined) {
    out.provider = typeof e.provider === "string" ? e.provider : null;
  }
  if (e.modelId !== undefined) {
    out.modelId = typeof e.modelId === "string" ? e.modelId : null;
  }
  if (e.thinkingLevel !== undefined) {
    out.thinkingLevel = typeof e.thinkingLevel === "string" ? e.thinkingLevel : null;
  }
  if (Array.isArray(e.toolNames)) {
    out.toolNames = e.toolNames.filter(
      (t): t is string => typeof t === "string",
    );
  }
  if (typeof e.timeoutSeconds === "number") {
    out.timeoutSeconds = e.timeoutSeconds;
  }
  if (e.notifyOnSuccess !== undefined) {
    out.notifyOnSuccess = Boolean(e.notifyOnSuccess);
  }
  if (e.notifyOnFailure !== undefined) {
    out.notifyOnFailure = Boolean(e.notifyOnFailure);
  }
  return out;
}

export function coerceExecution(raw: unknown): ExecutionOptions {
  const fallback: ExecutionOptions = {
    provider: null,
    modelId: null,
    thinkingLevel: null,
    toolNames: [],
    timeoutSeconds: 7200,
    notifyOnSuccess: false,
    notifyOnFailure: true,
  };
  return { ...fallback, ...coercePartialExecution(raw) };
}
