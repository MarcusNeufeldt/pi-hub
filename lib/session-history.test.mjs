import assert from "node:assert/strict";
import test from "node:test";
import { buildHistoryFromChain } from "./session-history.ts";


// Stands in for entryToUiMessage: renders messages and compactions, nothing else.
const toMessage = (entry) => {
  if (entry.type === "message") return { role: entry.message.role, content: entry.message.content };
  if (entry.type === "compaction") return { role: "custom", customType: "compaction", content: entry.summary };
  return null;
};

const ts = "2026-08-15T09:00:00.000Z";
const msg = (id, parentId, role, text) => ({
  id, parentId, type: "message", timestamp: ts,
  message: { role, content: [{ type: "text", text }] },
});

test("returns the whole chain and marks where the context begins", () => {
  // a -> b -> compaction -> d, where the compaction drops a and b.
  const entries = [
    msg("a", null, "user", "first"),
    msg("b", "a", "assistant", "second"),
    { id: "c", parentId: "b", type: "compaction", timestamp: ts, summary: "summary", tokensBefore: 1000, firstKeptEntryId: "d" },
    msg("d", "c", "user", "after"),
  ];
  const history = buildHistoryFromChain(entries, "d", new Set(["c", "d"]), toMessage);
  assert.equal(history.messages.length, 4, "nothing is dropped from the history");
  assert.deepEqual(history.entryIds, ["a", "b", "c", "d"]);
  assert.equal(history.contextStartIndex, 2, "context starts at the compaction summary");
  assert.equal(history.droppedCount, 2, "two messages precede the context");
  assert.equal(history.messages[2].customType, "compaction");
});

test("an uncompacted session has no dropped history", () => {
  const entries = [msg("a", null, "user", "hi"), msg("b", "a", "assistant", "hello")];
  const history = buildHistoryFromChain(entries, "b", new Set(["a", "b"]), toMessage);
  assert.equal(history.messages.length, 2);
  assert.equal(history.contextStartIndex, 0);
  assert.equal(history.droppedCount, 0);
});

test("messages and entryIds stay parallel, so fork targets survive", () => {
  const entries = [
    msg("a", null, "user", "one"),
    { id: "x", parentId: "a", type: "model_change", timestamp: ts, provider: "p", modelId: "m" },
    msg("b", "x", "assistant", "two"),
  ];
  const history = buildHistoryFromChain(entries, "b", new Set(["a", "b"]), toMessage);
  // model_change renders nothing, so it must be absent from BOTH arrays.
  assert.equal(history.messages.length, history.entryIds.length);
  assert.deepEqual(history.entryIds, ["a", "b"]);
});

test("a cyclic parent chain terminates instead of hanging", () => {
  const entries = [
    { ...msg("a", "b", "user", "one") },
    { ...msg("b", "a", "assistant", "two") },
  ];
  const history = buildHistoryFromChain(entries, "b", new Set(), toMessage);
  assert.ok(history.messages.length <= 2, "visited-set stops the walk");
});

test("falls back to the last entry when no leaf is given", () => {
  const entries = [msg("a", null, "user", "one"), msg("b", "a", "assistant", "two")];
  const history = buildHistoryFromChain(entries, null, new Set(["a", "b"]), toMessage);
  assert.deepEqual(history.entryIds, ["a", "b"]);
});
