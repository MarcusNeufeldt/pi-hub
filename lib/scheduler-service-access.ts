/**
 * Shared access to the scheduler TaskService from API routes.
 *
 * Routes must remain usable when the runtime failed to start (so the UI can
 * show a clear error instead of a 500). This helper returns either the
 * service or a ready-made 503 response.
 */

import { NextResponse } from "next/server";

import {
  getSchedulerRuntime,
  SchedulerErrorCode,
  TaskService,
} from "@/modules/scheduler";

export type ServiceOrError =
  | { ok: true; service: TaskService }
  | { ok: false; response: NextResponse };

export function getServiceOrError(): ServiceOrError {
  const runtime = getSchedulerRuntime();
  if (!runtime) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: "Scheduler not started",
          code: SchedulerErrorCode.SCHEDULER_UNAVAILABLE,
        },
        { status: 503 },
      ),
    };
  }
  try {
    return { ok: true, service: runtime.getTaskService() };
  } catch {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: "Scheduler unavailable",
          code: SchedulerErrorCode.SCHEDULER_UNAVAILABLE,
        },
        { status: 503 },
      ),
    };
  }
}
