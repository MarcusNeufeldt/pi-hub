import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const dynamic = "force-dynamic";

// GET /api/subagent-run?dir=<asyncDir>
// Reads a pi-subagents async run's status.json (live state, steps, output,
// transcript paths). Only paths under the async-runs temp root are allowed.
export async function GET(req: NextRequest) {
  const dir = req.nextUrl.searchParams.get("dir");
  if (!dir) {
    return NextResponse.json({ error: "dir required" }, { status: 400 });
  }
  const resolved = resolve(dir);
  const allowedRoot = resolve(join(tmpdir(), "pi-subagents-user-marcu", "async-subagent-runs"));
  if (!resolved.startsWith(allowedRoot + "\\") && !resolved.startsWith(allowedRoot + "/")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  try {
    const status = JSON.parse(
      await readFile(join(resolved, "status.json"), "utf8"),
    ) as Record<string, unknown>;
    return NextResponse.json(status);
  } catch {
    return NextResponse.json({ error: "no status yet" }, { status: 404 });
  }
}
