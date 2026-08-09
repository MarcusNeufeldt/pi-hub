import assert from "node:assert/strict";
import test from "node:test";
import { isSubagentSession } from "./session-visibility.ts";

test("hides named legacy subagent worker sessions", () => {
  assert.equal(isSubagentSession({
    name: "subagent-worker-4464dbe7-1",
    path: "C:\\Users\\marcu\\.pi\\agent\\sessions\\project\\worker.jsonl",
  }), true);
});

test("hides collaborating-agent sessions by their persisted launch marker", () => {
  assert.equal(isSubagentSession({
    name: undefined,
    path: "C:\\Users\\marcu\\.pi\\agent\\sessions\\project\\worker.jsonl",
    firstMessage: "Parent agent: CedarRiver Review the requested pull request.",
  }), true);
});

test("hides nested pi-subagents artifact sessions regardless of agent name", () => {
  assert.equal(isSubagentSession({
    name: "reviewer",
    path: "C:\\Users\\marcu\\.pi\\agent\\sessions\\project\\subagents\\run-id\\run-0\\session.jsonl",
  }), true);
});

test("keeps ordinary conversations and user-created forks visible", () => {
  assert.equal(isSubagentSession({
    name: "Improve subagent sidebar UX",
    path: "C:\\Users\\marcu\\.pi\\agent\\sessions\\project\\conversation.jsonl",
  }), false);
  assert.equal(isSubagentSession({
    name: "forked conversation",
    path: "C:\\Users\\marcu\\.pi\\agent\\sessions\\project\\fork.jsonl",
    firstMessage: "Discuss how a parent agent should coordinate workers.",
  }), false);
});
