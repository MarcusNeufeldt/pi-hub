import assert from "node:assert/strict";
import test from "node:test";
import {
  isSidebarConversationSession,
  isSubagentSession,
  isTaskRunSession,
} from "./session-visibility.ts";

test("hides named legacy subagent worker sessions", () => {
  assert.equal(isSubagentSession({
    name: "subagent-worker-4464dbe7-1",
    path: "C:\\Users\\dev\\.pi\\agent\\sessions\\project\\worker.jsonl",
  }), true);
});

test("hides collaborating-agent sessions by their persisted launch marker", () => {
  assert.equal(isSubagentSession({
    name: undefined,
    path: "C:\\Users\\dev\\.pi\\agent\\sessions\\project\\worker.jsonl",
    firstMessage: "Parent agent: CedarRiver Review the requested pull request.",
  }), true);
});

test("hides nested pi-subagents artifact sessions regardless of agent name", () => {
  assert.equal(isSubagentSession({
    name: "reviewer",
    path: "C:\\Users\\dev\\.pi\\agent\\sessions\\project\\subagents\\run-id\\run-0\\session.jsonl",
  }), true);
});

test("hides scheduled task runs by name or persisted execution marker", () => {
  assert.equal(isTaskRunSession({
    name: "[Task] Rename unnamed sessions · 2026-08-09 10:07",
  }), true);
  assert.equal(isTaskRunSession({
    name: undefined,
    firstMessage: "[Pi Hub Scheduled Execution]\nThis is an unattended task.",
  }), true);
});

test("keeps ordinary conversations and user-created forks visible", () => {
  const conversation = {
    name: "Improve subagent sidebar UX",
    path: "C:\\Users\\dev\\.pi\\agent\\sessions\\project\\conversation.jsonl",
  };
  const fork = {
    name: "forked conversation",
    path: "C:\\Users\\dev\\.pi\\agent\\sessions\\project\\fork.jsonl",
    firstMessage: "Discuss how a parent agent should coordinate workers.",
  };
  assert.equal(isSubagentSession(conversation), false);
  assert.equal(isSubagentSession(fork), false);
  assert.equal(isSidebarConversationSession(conversation), true);
  assert.equal(isSidebarConversationSession(fork), true);
});

test("normal sidebar conversations exclude both worker and task sessions", () => {
  assert.equal(isSidebarConversationSession({
    name: "[Task] Test · 2026-08-08 15:55",
    path: "C:\\sessions\\task.jsonl",
  }), false);
  assert.equal(isSidebarConversationSession({
    name: "reviewer",
    path: "C:\\sessions\\subagents\\run\\session.jsonl",
  }), false);
});
