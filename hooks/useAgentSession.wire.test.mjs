import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";
import { isNestedToolExecutionEvent, isSystemMessageEvent, toClientAgentEvent, updateToolProgress } from "../lib/agent-event-wire.ts";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true, jsx: { runtime: "automatic" } });
const { normalizeToolCalls } = await jiti.import("../lib/normalize.ts");
const { ToolExecutionProgressView } = await jiti.import("../components/MessageView.tsx");
const source = readFileSync(new URL("./useAgentSession.ts", import.meta.url), "utf8");
const handler = source.slice(source.indexOf("  const handleAgentEvent = useCallback"), source.indexOf("  handleAgentEventRef.current = handleAgentEvent;"));
const js = ts.transpileModule(handler, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function fixture() {
  const state = { messages: [], progress: [], phase: null, streaming: null, running: false, subagents: [], notices: [], retries: null, compacting: false };
  const setter = (key) => (value) => { state[key] = typeof value === "function" ? value(state[key]) : value; };
  const noop = () => {};
  const context = {
    useCallback: (fn) => fn, isNestedToolExecutionEvent, isSystemMessageEvent, updateToolProgress, normalizeToolCalls,
    agentRunningRef: { current: false }, sdkAgentActiveRef: { current: false }, rpcPromptPendingRef: { current: true },
    sessionIdRef: { current: null }, promptRunIdRef: { current: 1 }, optimisticUserMessageKeyRef: { current: null },
    pendingScrollToUserRef: { current: true }, isNearBottomRef: { current: false }, liveFollowFrameRef: { current: null },
    setMessages: setter("messages"), setAgentRunning: setter("running"), setAgentPhase: setter("phase"), setToolProgress: setter("progress"),
    setSubagents: setter("subagents"), setRetryInfo: setter("retries"), setIsCompacting: setter("compacting"),
    dispatch: (action) => { if (action.type === "update") state.streaming = action.message; else state.streaming = null; },
    addNotice: (notice) => state.notices.push(notice),
    settleUiStage: () => { state.running = context.agentRunningRef.current = false; state.streaming = null; return true; },
    cancelEventStreamGrace: noop, firePromptFinished: noop, handleExtensionUiRequest: noop, loadSession: noop,
    notifyPromptStage: () => true, onAgentEnd: noop, scheduleEventStreamClose: noop, scrollToBottom: noop,
    setCompactError: noop, setCompactResult: noop, readCompactResult: () => null,
  };
  const settle = source.slice(source.indexOf("  const settleUiStage = useCallback"), source.indexOf("  const notifyPromptStage = useCallback"));
  const settleJs = ts.transpileModule(settle, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  context.settleUiStage = runInNewContext(`${settleJs}; settleUiStage`, context);
  const handle = runInNewContext(`${js}; handleAgentEvent`, context);
  return { state, context, handle, send: (event) => { const client = toClientAgentEvent(event); if (client) handle(JSON.parse(JSON.stringify(client))); } };
}

test("wire to hook fixture keeps cumulative content and nested progress out of model phase/transcript/fleet", () => {
  const f = fixture();
  f.send({ type: "agent_start" });
  for (const text of ["Hello", "Hello world"]) f.send({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text }] }, assistantMessageEvent: { delta: text } });
  assert.equal(f.state.streaming.content[0].text, "Hello world");
  f.send({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "p", name: "codemode", arguments: {} }] } });
  f.send({ type: "tool_execution_start", toolCallId: "p", toolName: "codemode" });
  f.send({ type: "tool_execution_start", toolCallId: "p/1", toolName: "subagent", parentToolCallId: "p", args: { task: "Not a model delegation" } });
  assert.deepEqual(JSON.parse(JSON.stringify(f.state.phase.tools)), [{ id: "p", name: "codemode" }]);
  assert.equal(f.state.subagents.length, 0);
  f.send({ type: "tool_execution_end", toolCallId: "p/1", toolName: "subagent", parentToolCallId: "p", isError: true, result: { content: [{ type: "text", text: "Nested failure" }] } });
  assert.equal(f.state.progress.find((item) => item.id === "p/1").parentToolCallId, "p");
  assert.equal(f.state.progress.find((item) => item.id === "p/1").error, "Nested failure");
  assert.equal(f.state.phase.tools.length, 1);
  f.send({ type: "tool_execution_end", toolCallId: "p", toolName: "codemode", isError: false });
  assert.equal(f.state.progress.find((item) => item.id === "p").status, "ok");
  assert.equal(f.state.messages.length, 1);
  assert.equal(f.state.messages[0].content.length, 1);
  assert.equal(f.state.messages[0].content[0].toolCallId, "p");
});

test("final cancelled snapshots survive settlement and render once per nested call", () => {
  for (const observedStart of [false, true]) {
    const f = fixture();
    f.send({ type: "agent_start" });
    if (observedStart) f.send({ type: "tool_execution_start", toolCallId: "p/1", toolName: "read", parentToolCallId: "p" });
    f.send({ type: "tool_execution_update", toolCallId: "p", toolName: "codemode", partialResult: {
      details: { calls: [{ id: "p/1", name: "read", status: "running" }] },
    } });
    f.send({ type: "tool_execution_end", toolCallId: "p", toolName: "codemode", isError: true, result: {
      details: { calls: [{ id: "p/1", name: "read", status: "cancelled" }] },
    } });
    f.context.sdkAgentActiveRef.current = false;
    f.send({ type: "prompt_done" });
    const html = renderToStaticMarkup(React.createElement(ToolExecutionProgressView, { progress: f.state.progress }));
    assert.equal((html.match(/Cancelled/g) ?? []).length, 1);
    assert.doesNotMatch(html, /Unfinished/);
    assert.equal(f.state.messages.length, 0);
    assert.equal(f.state.running, false);
    assert.equal(f.state.progress.find((item) => item.id === "p").calls[0].status, "cancelled");
  }
});

test("filtered system events and late execution events cannot resurrect settled UI", () => {
  const f = fixture();
  f.send({ type: "agent_start" });
  f.handle({ type: "message_start", message: { role: "system", content: "prompt" } });
  f.handle({ type: "message_end", message: { role: "system", content: "tools" } });
  assert.equal(f.state.streaming, null);
  assert.equal(f.state.messages.length, 0);
  f.context.sdkAgentActiveRef.current = false;
  f.send({ type: "prompt_done" });
  f.send({ type: "tool_execution_start", toolCallId: "late", toolName: "read" });
  assert.equal(f.state.progress.length, 0);
  assert.equal(f.state.running, false);
});

test("retry/compaction events stay live until prompt settlement", () => {
  const f = fixture();
  f.send({ type: "agent_start" });
  f.send({ type: "auto_retry_start", attempt: 1, maxAttempts: 3 });
  assert.equal(f.state.retries.attempt, 1);
  f.send({ type: "agent_end" });
  assert.equal(f.state.running, true);
  f.send({ type: "compaction_start" });
  assert.equal(f.state.compacting, true);
  f.send({ type: "compaction_end", aborted: true });
  assert.equal(f.state.compacting, false);
  f.context.rpcPromptPendingRef.current = false;
  f.send({ type: "agent_settled" });
  assert.equal(f.state.running, false);
});
