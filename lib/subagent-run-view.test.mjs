import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildSubagentRunView,
  isPathWithin,
} from "./subagent-run-view.ts";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "pi-hub-subagent-view-"));
  const transcriptPath = join(dir, "worker_transcript.jsonl");
  const records = [
    {
      version: 1,
      recordType: "tool_start",
      sourceEventType: "tool_execution_start",
      agent: "worker",
      timestamp: "2026-08-09T05:00:00.000Z",
      toolCallId: "call-1",
      toolName: "read",
      argsPreview: "src/main.ts",
    },
    {
      version: 1,
      recordType: "message",
      sourceEventType: "message_end",
      agent: "worker",
      timestamp: "2026-08-09T05:00:01.000Z",
      role: "assistant",
      text: "I found the implementation seam.",
    },
    {
      version: 1,
      recordType: "tool_end",
      sourceEventType: "tool_execution_end",
      agent: "worker",
      timestamp: "2026-08-09T05:00:02.000Z",
      toolCallId: "call-1",
      toolName: "read",
      isError: false,
    },
    {
      version: 1,
      recordType: "message",
      sourceEventType: "message_end",
      agent: "worker",
      timestamp: "2026-08-09T05:00:02.100Z",
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      text: "file contents",
      isError: false,
    },
  ];
  await writeFile(transcriptPath, `${records.map((row) => JSON.stringify(row)).join("\n")}\n`);
  return { dir, transcriptPath };
}

test("normalizes transcript deltas and complete final output", async () => {
  const { dir, transcriptPath } = await fixture();
  try {
    const status = {
      state: "complete",
      workflow: {
        value: {
          results: [{
            agent: "worker",
            task: "Inspect the project",
            exitCode: 0,
            model: "provider/model",
            transcriptPath,
            finalOutput: "# Final result\n\nEverything passed.",
            progressSummary: { toolCount: 1, tokens: 1234, durationMs: 2100 },
            usage: { turns: 2 },
          }],
        },
      },
      steps: [{ agent: "worker", status: "completed" }],
    };

    const first = await buildSubagentRunView(status, [dir]);
    const child = first.children[0];
    assert.equal(child.status, "completed");
    assert.equal(child.finalOutput, "# Final result\n\nEverything passed.");
    assert.equal(child.toolCount, 1);
    assert.equal(child.turnCount, 2);
    assert.equal(child.tokens, 1234);
    assert.equal(child.events.length, 4);
    assert.equal(child.events[0].id, "tool:worker:call-1");
    assert.equal(child.events[0].phase, "running");

    const second = await buildSubagentRunView(status, [dir], {
      "0": { cursor: child.timelineCursor, source: child.timelineSource },
    });
    assert.deepEqual(second.children[0].events, []);
    assert.equal(second.children[0].timelineComplete, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("preserves complete assistant narration text", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-hub-subagent-narration-"));
  const transcriptPath = join(dir, "narration_transcript.jsonl");
  try {
    const narration = `Reasoning update: ${"detail ".repeat(900)}`;
    await writeFile(transcriptPath, `${JSON.stringify({
      recordType: "message",
      sourceEventType: "message_end",
      agent: "worker",
      role: "assistant",
      timestamp: "2026-08-09T05:00:03.000Z",
      text: narration,
    })}\n`);
    const view = await buildSubagentRunView({
      state: "complete",
      workflow: { value: { results: [{ agent: "worker", exitCode: 0, transcriptPath }] } },
    }, [dir]);
    assert.equal(view.children[0].events[0].detail, narration);
    assert.equal(view.children[0].events[0].detail.length > 4_000, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("uses bounded status snapshots before a transcript is available", async () => {
  const now = Date.now();
  const view = await buildSubagentRunView({
    state: "running",
    steps: [{
      agent: "researcher",
      status: "running",
      currentTool: "web_search",
      currentToolArgs: "Pi interfaces",
      currentToolStartedAt: now,
      recentTools: [{ tool: "read", args: "README.md", endMs: now - 1000 }],
      recentOutput: ["Gathering primary sources"],
      toolCount: 2,
    }],
  }, []);

  const child = view.children[0];
  assert.equal(child.status, "running");
  assert.equal(child.currentTool, "web_search");
  assert.equal(child.events.filter((event) => event.kind === "tool").length, 2);
  assert.equal(child.events.some((event) => event.detail === "Gathering primary sources"), true);
});

test("advances past an oversized JSONL record instead of stalling", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-hub-subagent-large-line-"));
  const transcriptPath = join(dir, "large_transcript.jsonl");
  try {
    const oversized = JSON.stringify({
      recordType: "message",
      sourceEventType: "message_end",
      agent: "worker",
      role: "toolResult",
      text: "x".repeat(300_000),
    });
    const normal = JSON.stringify({
      recordType: "message",
      sourceEventType: "message_end",
      agent: "worker",
      role: "assistant",
      timestamp: "2026-08-09T05:00:03.000Z",
      text: "Continued after the oversized result.",
    });
    await writeFile(transcriptPath, `${oversized}\n${normal}\n`);
    const status = {
      state: "running",
      steps: [{ agent: "worker", status: "running", transcriptPath }],
    };

    const first = await buildSubagentRunView(status, [dir]);
    assert.equal(first.children[0].timelineCursor > 0, true);
    assert.equal(first.children[0].timelineComplete, false);

    const second = await buildSubagentRunView(status, [dir], {
      "0": {
        cursor: first.children[0].timelineCursor,
        source: first.children[0].timelineSource,
      },
    });
    assert.equal(second.children[0].timelineComplete, true);
    assert.equal(
      second.children[0].events.some((event) => event.detail === "Continued after the oversized result."),
      true,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("does not fabricate a child before status exposes a step", async () => {
  const view = await buildSubagentRunView({ state: "queued", steps: [] }, []);
  assert.deepEqual(view.children, []);
});

test("rejects transcript paths outside allowed roots", () => {
  assert.equal(isPathWithin("C:/safe/root/child/file.jsonl", ["C:/safe/root"]), true);
  assert.equal(isPathWithin("C:/safe/other/file.jsonl", ["C:/safe/root"]), false);
});
