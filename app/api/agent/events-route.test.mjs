import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const agentEventsSource = await readFile(new URL("./[id]/events/route.ts", import.meta.url), "utf8");
const runningEventsSource = await readFile(new URL("./running/events/route.ts", import.meta.url), "utf8");

test("agent SSE uses the shared cumulative-message wire projection", () => {
  assert.match(agentEventsSource, /import \{ toClientAgentEvent \} from "@\/lib\/agent-event-wire"/);
  assert.match(agentEventsSource, /const clientEvent = toClientAgentEvent\(event\)/);
});

test("SSE routes reuse one TextEncoder per stream", () => {
  for (const source of [agentEventsSource, runningEventsSource]) {
    assert.equal((source.match(/new TextEncoder\(\)/g) ?? []).length, 1);
    assert.match(source, /controller\.enqueue\(encoder\.encode\(text\)\)/);
    assert.match(source, /encoder\.encode\(`:\$\{" "\.repeat\(2048\)\}\\n\\n`\)/);
    assert.match(source, /"Cache-Control": "no-cache, no-transform"/);
    assert.match(source, /"X-Accel-Buffering": "no"/);
    assert.match(source, /controller\.enqueue\(encoder\.encode\(":\\n\\n"\)\)/);
  }
});

test("agent event SSE opens before AgentSession startup", () => {
  const streamStart = agentEventsSource.indexOf("start(controller) {");
  const connected = agentEventsSource.indexOf('encode({ type: "connected", sessionId: id })');

  assert.ok(streamStart >= 0, "ReadableStream.start must remain synchronous");
  assert.ok(connected > streamStart, "the stream must emit a connected event");
  const attach = agentEventsSource.indexOf("attachSession();");
  assert.ok(attach > streamStart && attach < connected, "subscription must precede readiness");
  assert.match(agentEventsSource, /subscribeRpcSessionAvailability\(id, attach\)/);
  assert.match(agentEventsSource, /session\.onDestroy\(\(\) => cleanup\(\)\)/);
  assert.doesNotMatch(agentEventsSource, /AGENT_SESSION_ATTACH_DELAY_MS|attachTimer/);
  assert.doesNotMatch(agentEventsSource, /startRpcSession/);
  assert.doesNotMatch(agentEventsSource, /async start\(controller\)/);
});
