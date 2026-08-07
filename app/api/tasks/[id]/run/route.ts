import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/scheduler-dto";
import { getServiceOrError } from "@/lib/scheduler-service-access";

/**
 * Triggers a manual run of a task. Enqueues a run (dedupe-protected) without
 * changing the task's own `next_run_at` (design doc §20.5). The scheduler
 * runtime's queue drains it.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const access = getServiceOrError();
    if (!access.ok) return access.response;
    const { id } = await params;
    const { run, created } = access.service.triggerRun(id);
    return NextResponse.json(
      { runId: run.id, status: run.status, created },
      { status: created ? 201 : 200 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
