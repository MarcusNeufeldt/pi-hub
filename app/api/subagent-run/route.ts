import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildSubagentRunView,
  type SubagentTimelineCursors,
} from "@/lib/subagent-run-view";

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
    let cursors: SubagentTimelineCursors = {};
    const rawCursors = req.nextUrl.searchParams.get("cursors");
    if (rawCursors && rawCursors.length <= 8_192) {
      try {
        const parsed = JSON.parse(rawCursors);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          cursors = parsed as SubagentTimelineCursors;
        }
      } catch {
        // Invalid cursors simply restart timeline delivery from byte zero.
      }
    }
    const cwd = typeof status.cwd === "string" ? status.cwd : undefined;
    const allowedArtifactRoots = [
      ...(cwd ? [resolve(cwd, ".pi-subagents", "artifacts")] : []),
      resolve(join(homedir(), ".pi", "agent", "sessions")),
    ];
    const piHub = await buildSubagentRunView(status, allowedArtifactRoots, cursors);
    return NextResponse.json({ ...status, piHub });
  } catch {
    return NextResponse.json({ error: "no status yet" }, { status: 404 });
  }
}
