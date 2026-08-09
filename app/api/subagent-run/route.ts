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
// GET /api/subagent-run?artifacts=<foreground child artifact descriptors>
// Reads either a detached run's status.json or path-restricted foreground
// child artifacts. Client-provided paths never bypass the approved artifact
// and session roots enforced by buildSubagentRunView.
export async function GET(req: NextRequest) {
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

  try {
    const dir = req.nextUrl.searchParams.get("dir");
    let status: Record<string, unknown>;
    let artifactRoot: string | undefined;

    if (dir) {
      const resolved = resolve(dir);
      const allowedRoot = resolve(join(tmpdir(), "pi-subagents-user-marcu", "async-subagent-runs"));
      if (!resolved.startsWith(allowedRoot + "\\") && !resolved.startsWith(allowedRoot + "/")) {
        return NextResponse.json({ error: "forbidden" }, { status: 403 });
      }
      status = JSON.parse(
        await readFile(join(resolved, "status.json"), "utf8"),
      ) as Record<string, unknown>;
      const cwd = typeof status.cwd === "string" ? status.cwd : undefined;
      artifactRoot = cwd ? resolve(cwd, ".pi-subagents", "artifacts") : undefined;
    } else {
      const rawArtifacts = req.nextUrl.searchParams.get("artifacts");
      if (!rawArtifacts || rawArtifacts.length > 32_768) {
        return NextResponse.json({ error: "dir or artifacts required" }, { status: 400 });
      }
      const parsed = JSON.parse(rawArtifacts);
      if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 50) {
        return NextResponse.json({ error: "invalid artifacts" }, { status: 400 });
      }
      const results = parsed.map((value) => {
        const item = value && typeof value === "object" && !Array.isArray(value)
          ? value as Record<string, unknown>
          : {};
        return {
          agent: typeof item.agent === "string" ? item.agent : "agent",
          task: typeof item.task === "string" ? item.task : undefined,
          transcriptPath: typeof item.transcriptPath === "string" ? item.transcriptPath : undefined,
          sessionFile: typeof item.sessionFile === "string" ? item.sessionFile : undefined,
          outputReference:
            typeof item.outputReference === "string"
              ? { path: item.outputReference }
              : undefined,
          exitCode: 0,
        };
      });
      artifactRoot = resolve(process.cwd(), ".pi-subagents", "artifacts");
      status = {
        state: "complete",
        cwd: process.cwd(),
        workflow: { value: { results } },
      };
    }

    const allowedArtifactRoots = [
      ...(artifactRoot ? [artifactRoot] : []),
      resolve(join(homedir(), ".pi", "agent", "sessions")),
    ];
    const piHub = await buildSubagentRunView(status, allowedArtifactRoots, cursors);
    return NextResponse.json({ ...status, piHub });
  } catch {
    return NextResponse.json({ error: "no status yet" }, { status: 404 });
  }
}
