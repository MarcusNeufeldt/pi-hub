import { NextResponse } from "next/server";

import { errorResponse, runToDto } from "@/lib/scheduler-dto";
import { getServiceOrError } from "@/lib/scheduler-service-access";

/**
 * Cancels a queued or running run. Running executors receive an abort signal;
 * the persisted cancellation marker is terminal even if completion races it.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const access = getServiceOrError();
    if (!access.ok) return access.response;
    const { id } = await params;
    const run = access.service.cancelRun(id);
    return NextResponse.json(runToDto(run));
  } catch (error) {
    return errorResponse(error);
  }
}
