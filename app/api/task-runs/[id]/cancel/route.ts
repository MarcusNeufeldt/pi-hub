import { NextResponse } from "next/server";

import { errorResponse, runToDto } from "@/lib/scheduler-dto";
import { getServiceOrError } from "@/lib/scheduler-service-access";

/**
 * Cancels a queued or running run. Queued runs are cancelled immediately;
 * running runs are marked for cancellation and finalized by the executor
 * once the abort takes effect (design doc §18.2).
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
