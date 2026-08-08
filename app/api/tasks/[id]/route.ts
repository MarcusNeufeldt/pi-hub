import { NextResponse } from "next/server";

import type {
  ExecutionOptions,
  ScheduleInput,
  TaskStatus,
  UpdateTaskPatch,
} from "@/modules/scheduler";
import { errorResponse, taskToDto } from "@/lib/scheduler-dto";
import { coercePartialExecution, coerceResume, coerceRetryOnRateLimit, coerceSchedule } from "@/lib/scheduler-coerce";
import { getServiceOrError } from "@/lib/scheduler-service-access";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const access = getServiceOrError();
    if (!access.ok) return access.response;
    const { id } = await params;
    const task = access.service.getTaskWithLastRun(id);
    return NextResponse.json(taskToDto(task, task.lastRun));
  } catch (error) {
    return errorResponse(error);
  }
}

interface PatchBody {
  name?: unknown;
  cwd?: unknown;
  prompt?: unknown;
  schedule?: unknown;
  execution?: unknown;
  resume?: unknown;
  retryOnRateLimit?: unknown;
  status?: unknown;
  revision?: unknown;
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const access = getServiceOrError();
    if (!access.ok) return access.response;
    const { id } = await params;
    const body = (await req.json().catch(() => ({}))) as PatchBody;

    if (typeof body.revision !== "number") {
      return NextResponse.json(
        { error: "revision is required for optimistic locking", code: "VALIDATION_ERROR" },
        { status: 400 },
      );
    }

    const patch: UpdateTaskPatch = { revision: body.revision };
    if (typeof body.name === "string") patch.name = body.name;
    if (typeof body.cwd === "string") patch.cwd = body.cwd;
    if (typeof body.prompt === "string") patch.prompt = body.prompt;
    if (body.schedule !== undefined) {
      patch.schedule = coerceSchedule(body.schedule) as ScheduleInput;
    }
    if (body.execution !== undefined) {
      patch.execution = coercePartialExecution(body.execution) as Partial<ExecutionOptions>;
    }
    if (body.resume !== undefined) {
      patch.resume = coerceResume(body.resume);
    }
    if (body.retryOnRateLimit !== undefined) {
      patch.retryOnRateLimit = coerceRetryOnRateLimit(body.retryOnRateLimit);
    }
    if (body.status === "active" || body.status === "paused" || body.status === "completed") {
      patch.status = body.status as TaskStatus;
    }

    const task = access.service.updateTask(id, patch);
    return NextResponse.json(taskToDto(task));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const access = getServiceOrError();
    if (!access.ok) return access.response;
    const { id } = await params;
    access.service.deleteTask(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    return errorResponse(error);
  }
}
