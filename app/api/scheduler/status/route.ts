import { NextResponse } from "next/server";

import { getSchedulerRuntime } from "@/modules/scheduler";
import { schedulerStatusToDto } from "@/lib/scheduler-dto";

/**
 * Scheduler runtime status. Never returns secrets — only operational state
 * (design doc §20.7, §23.2). When the runtime failed to start, returns a
 * 200 with `error` populated so the UI can show a clear status instead of a
 * connection error.
 */
export async function GET() {
  const runtime = getSchedulerRuntime();
  if (!runtime) {
    return NextResponse.json(
      {
        running: false,
        leader: false,
        ownerId: null,
        lastTickAt: null,
        nextTickAt: null,
        queuedRuns: 0,
        runningRuns: 0,
        maxConcurrency: 1,
        databasePath: null,
        error: "Scheduler not started",
      },
    );
  }
  return NextResponse.json(schedulerStatusToDto(runtime.getStatus()));
}
