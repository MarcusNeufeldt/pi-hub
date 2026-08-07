import { NextResponse } from "next/server";

import type {
  CreateTaskInput,
  TaskStatus,
} from "@/modules/scheduler";
import { errorResponse, taskToDto } from "@/lib/scheduler-dto";
import { coerceExecution, coerceSchedule } from "@/lib/scheduler-coerce";
import { getServiceOrError } from "@/lib/scheduler-service-access";

interface CreateBody {
  name?: unknown;
  cwd?: unknown;
  prompt?: unknown;
  schedule?: unknown;
  execution?: unknown;
}

export async function GET(req: Request) {
  try {
    const access = getServiceOrError();
    if (!access.ok) return access.response;
    const service = access.service;
    const url = new URL(req.url);
    const status = url.searchParams.get("status") as TaskStatus | null;
    const limit = url.searchParams.get("limit")
      ? Number(url.searchParams.get("limit"))
      : undefined;
    const offset = url.searchParams.get("offset")
      ? Number(url.searchParams.get("offset"))
      : undefined;
    const result = service.listTasks({
      ...(status ? { status } : {}),
      ...(limit ? { limit } : {}),
      ...(offset ? { offset } : {}),
    });
    return NextResponse.json({
      items: result.items.map((t) => taskToDto(t, t.lastRun)),
      total: result.total,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(req: Request) {
  try {
    const access = getServiceOrError();
    if (!access.ok) return access.response;
    const service = access.service;
    const body = (await req.json().catch(() => ({}))) as CreateBody;

    if (typeof body.name !== "string" || !body.name.trim()) {
      return NextResponse.json(
        { error: "name is required", code: "VALIDATION_ERROR" },
        { status: 400 },
      );
    }
    if (typeof body.cwd !== "string" || !body.cwd.trim()) {
      return NextResponse.json(
        { error: "cwd is required", code: "VALIDATION_ERROR" },
        { status: 400 },
      );
    }
    if (typeof body.prompt !== "string" || !body.prompt.trim()) {
      return NextResponse.json(
        { error: "prompt is required", code: "VALIDATION_ERROR" },
        { status: 400 },
      );
    }

    const input: CreateTaskInput = {
      name: body.name,
      cwd: body.cwd,
      prompt: body.prompt,
      schedule: coerceSchedule(body.schedule),
      execution: coerceExecution(body.execution),
    };
    const task = service.createTask(input);
    return NextResponse.json(taskToDto(task), { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
