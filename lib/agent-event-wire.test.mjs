import assert from "node:assert/strict";
import test from "node:test";
import { CODEMODE_SNAPSHOT_CALL_LIMIT, toClientAgentEvent, updateToolProgress } from "./agent-event-wire.ts";

const huge = "x".repeat(1_000_000);

test("omits large appended entries and all transcript system event variants", () => {
  assert.equal(toClientAgentEvent({ type: "entry_appended", entry: { data: huge } }), null);
  for (const type of ["message_start", "message_update", "message_end"]) {
    assert.equal(toClientAgentEvent({ type, message: { role: "system", content: huge, tools: [huge] } }), null);
  }
});

test("message updates retain the cumulative message, not duplicate partials or deltas", () => {
  const message = { role: "assistant", content: [{ type: "text", text: "Hello world" }] };
  assert.deepEqual(toClientAgentEvent({ type: "message_update", message, assistantMessageEvent: { delta: "world", partial: message } }), {
    type: "message_update", message,
  });
});

test("codemode snapshots bound both call count and per-call payload without mutation", () => {
  const calls = Array.from({ length: 900 }, (_, i) => ({ id: `parent/${i}`, name: "read", status: "error", args: huge, error: huge, result: huge }));
  const event = { type: "tool_execution_update", toolCallId: "parent", toolName: "codemode", partialResult: {
    content: [{ type: "text", text: huge }, { type: "image", data: huge }], details: { calls, storedValue: huge }, structuredContent: huge,
  } };
  const projected = toClientAgentEvent(event);
  assert.equal(projected.partialResult.details.calls.length, CODEMODE_SNAPSHOT_CALL_LIMIT);
  assert.equal(projected.partialResult.details.calls[0].id, "parent/700");
  assert.equal(projected.partialResult.details.omittedCalls, 700);
  assert.ok(JSON.stringify(projected).length < 180_000);
  assert.equal(event.partialResult.details.calls.length, 900);
  assert.equal(event.partialResult.content[0].text.length, huge.length);
});

test("nested start/end preserve parent identity but omit large args/results and updates", () => {
  for (const type of ["tool_execution_start", "tool_execution_update", "tool_execution_end"]) {
    const projected = toClientAgentEvent({ type, toolCallId: "p/1", toolName: "read", parentToolCallId: "p", args: huge, partialResult: huge, result: { content: [{ type: "text", text: huge }], structuredContent: huge }, isError: true });
    if (type === "tool_execution_update") assert.equal(projected, null);
    else {
      assert.equal(projected.parentToolCallId, "p");
      assert.equal(projected.toolCallId, "p/1");
      assert.equal(projected.args, undefined);
      assert.equal(projected.result, undefined);
      assert.ok(JSON.stringify(projected).length < 1_000);
    }
  }
});

test("subagent and logical-prompt lifecycle contracts are unchanged", () => {
  const partialResult = { details: { progress: [{ agent: "worker", status: "running" }] } };
  assert.deepEqual(toClientAgentEvent({ type: "tool_execution_update", toolCallId: "s", toolName: "subagent", partialResult }), { type: "subagent_update", toolCallId: "s", partialResult });
  const end = { type: "tool_execution_end", toolCallId: "s", toolName: "subagent", result: partialResult };
  assert.equal(toClientAgentEvent(end), end);
  for (const type of ["auto_retry_start", "auto_retry_end", "compaction_start", "compaction_end", "auto_compaction_start", "auto_compaction_end", "agent_settled", "prompt_done", "prompt_error", "connected"]) {
    const event = { type, reason: "fixture" };
    assert.equal(toClientAgentEvent(event), event);
  }
  assert.deepEqual(toClientAgentEvent({ type: "agent_end", messages: [huge] }), { type: "agent_end" });
});

test("final codemode snapshots carry bounded terminal statuses and reconcile observed children", () => {
  let progress = updateToolProgress([], { type: "tool_execution_start", toolCallId: "p/1", toolName: "read", parentToolCallId: "p" });
  const event = toClientAgentEvent({ type: "tool_execution_end", toolCallId: "p", toolName: "codemode", isError: true, result: {
    content: [{ type: "text", text: huge }], structuredContent: huge,
    details: { calls: [
      { id: "p/1", name: "read", status: "cancelled", args: huge },
      { id: "p/2", name: "bash", status: "ok" },
      { id: "p/3", name: "write", status: "error", error: "fixture failure" },
    ], storedValue: huge },
  } });
  assert.equal(event.result, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(event), "utf8") < 6_000);
  progress = updateToolProgress(progress, event);
  assert.equal(progress.find((item) => item.id === "p/1").status, "cancelled");
  assert.equal(progress.find((item) => item.id === "p/1").parentToolCallId, "p");
  assert.deepEqual(progress.find((item) => item.id === "p").calls.map((call) => call.status), ["cancelled", "ok", "error"]);
  const terminalOnly = updateToolProgress([], event);
  assert.equal(terminalOnly[0].calls[0].status, "cancelled");
});

test("progress keeps nested parent identity and completion without transcript messages", () => {
  let progress = [];
  for (const event of [
    { type: "tool_execution_start", toolCallId: "p", toolName: "codemode" },
    { type: "tool_execution_start", toolCallId: "p/1", toolName: "read", parentToolCallId: "p" },
    { type: "tool_execution_end", toolCallId: "p/1", toolName: "read", parentToolCallId: "p", isError: true },
    { type: "tool_execution_end", toolCallId: "p", toolName: "codemode", isError: false },
  ]) progress = updateToolProgress(progress, toClientAgentEvent(event));
  assert.equal(progress.find((item) => item.id === "p/1").parentToolCallId, "p");
  assert.equal(progress.find((item) => item.id === "p/1").status, "error");
  assert.equal(progress.find((item) => item.id === "p").status, "ok");
  assert.ok(progress.every((item) => !item.role));
  for (let i = 0; i < 400; i++) progress = updateToolProgress(progress, { type: "tool_execution_start", toolCallId: `p/${i}`, toolName: "read", parentToolCallId: "p" });
  assert.equal(progress.length, CODEMODE_SNAPSHOT_CALL_LIMIT);
});
