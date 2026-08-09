import assert from "node:assert/strict";
import test from "node:test";

import {
  isSubagentSession,
  renameUnnamedSessions,
  selectUnnamedSessions,
} from "./rename-unnamed-sessions.mjs";

function session(overrides) {
  return {
    id: "session-1",
    name: undefined,
    path: "C:\\Users\\marcu\\.pi\\agent\\sessions\\project\\session.jsonl",
    firstMessage: "Build the feature",
    messageCount: 4,
    modified: "2026-08-09T10:00:00.000Z",
    ...overrides,
  };
}

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

test("recognizes every sidebar subagent signature", () => {
  assert.equal(isSubagentSession(session({ name: "subagent-worker-1" })), true);
  assert.equal(isSubagentSession(session({ path: "C:\\sessions\\subagents\\worker.jsonl" })), true);
  assert.equal(isSubagentSession(session({ firstMessage: "Parent agent: coordinator" })), true);
  assert.equal(isSubagentSession(session({ firstMessage: "Normal conversation" })), false);
});

test("selects only idle unnamed normal sessions, newest first", () => {
  const selected = selectUnnamedSessions([
    session({ id: "older", modified: "2026-08-08T10:00:00.000Z" }),
    session({ id: "newer", modified: "2026-08-09T10:00:00.000Z" }),
    session({ id: "named", name: "Already named" }),
    session({ id: "empty", messageCount: 0 }),
    session({ id: "worker", path: "C:\\sessions\\subagents\\worker.jsonl" }),
    session({ id: "running" }),
  ], ["running"], 2);

  assert.deepEqual(selected.map((item) => item.id), ["newer", "older"]);
});

test("renames candidates sequentially and preserves names won by a race", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/api/sessions")) {
      return response(200, {
        sessions: [session({ id: "first" }), session({ id: "second" })],
        runningSessionIds: [],
      });
    }
    if (url.includes("/first/")) return response(200, { title: "Pi Hub session naming automation" });
    return response(200, { title: "Manually named elsewhere", skipped: "already_named" });
  };

  const result = await renameUnnamedSessions({ fetchImpl, limit: 10 });

  assert.equal(result.renamed.length, 1);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.failed.length, 0);
  assert.equal(calls.length, 3);
  assert.ok(calls.slice(1).every((call) => call.url.endsWith("?onlyUnnamed=1")));
  assert.ok(calls.slice(1).every((call) => call.options.method === "POST"));
});
