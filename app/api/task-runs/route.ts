import { NextResponse } from "next/server";

import type { RunStatus } from "@/modules/scheduler";
import { errorResponse, runSummaryToDto } from "@/lib/scheduler-dto";
import { getServiceOrError } from "@/lib/scheduler-service-access";

export async function GET(req: Request) {
  try {
    const access = getServiceOrError();
    if (!access.ok) return access.response;
    const url = new URL(req.url);
    const taskId = url.searchParams.get("taskId") ?? undefined;
    const status = url.searchParams.get("status") as RunStatus | null;
    const limit = url.searchParams.get("limit")
      ? Number(url.searchParams.get("limit"))
      : undefined;
    const offset = url.searchParams.get("offset")
      ? Number(url.searchParams.get("offset"))
      : undefined;
    const result = access.service.listRuns({
      ...(taskId ? { taskId } : {}),
      ...(status ? { status } : {}),
      ...(limit ? { limit } : {}),
      ...(offset ? { offset } : {}),
    });
    return NextResponse.json({
      items: result.items.map(runSummaryToDto),
      total: result.total,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
