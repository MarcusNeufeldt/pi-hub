import { NextResponse } from "next/server";

import { errorResponse, runToDto } from "@/lib/scheduler-dto";
import { getServiceOrError } from "@/lib/scheduler-service-access";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const access = getServiceOrError();
    if (!access.ok) return access.response;
    const { id } = await params;
    const run = access.service.getRun(id);
    return NextResponse.json(runToDto(run));
  } catch (error) {
    return errorResponse(error);
  }
}
