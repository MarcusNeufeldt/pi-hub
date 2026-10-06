import assert from "node:assert/strict";
import test from "node:test";
import { buildSessionProjection } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const { buildSessionContext, buildSessionHistory } = await createJiti(import.meta.url).import("./session-reader.ts");
const timestamp = "2026-01-01T00:00:00.000Z";
const entry = (id, parentId, message) => ({ type: "message", id, parentId, timestamp, message });
const edit = (id, parentId, targetId, content) => ({
  type: "context_edit", id, parentId, timestamp, targetId,
  replacement: content === null ? null : { content },
});
const user = (content) => ({ role: "user", content, timestamp: 123 });
const assistant = (content) => ({
  role: "assistant", content, provider: "test", model: "test-model", timestamp: 123,
});
const compaction = (id, parentId, firstKeptEntryId) => ({
  type: "compaction", id, parentId, firstKeptEntryId, summary: id, tokensBefore: 100,
  timestamp, systemMessage: { role: "system", content: "recorded prompt", timestamp: 123 },
});

// Check provenance against the installed SDK rather than reimplementing selection.
function assertSdkIds(entries, leafId) {
  const sdk = buildSessionProjection(entries, leafId);
  const expectedIds = sdk.entries.flatMap(({ sourceEntry, messages }) =>
    messages.filter((message) => message.role !== "system").map(() => sourceEntry.id));
  const ui = buildSessionContext(entries, leafId);
  assert.deepEqual(ui.entryIds, expectedIds);
  assert.equal(ui.messages.length, ui.entryIds.length);
  assert.deepEqual(ui.model, sdk.model);
  assert.equal(ui.thinkingLevel, sdk.thinkingLevel);
  return ui;
}

test("replacement/removal use SDK content and original IDs without mutating raw history", () => {
  const entries = [
    entry("sys", null, { role: "system", content: "private prompt" }),
    entry("u", "sys", user("raw request")),
    entry("a", "u", assistant([{ type: "text", text: "raw answer" }])),
    edit("replace", "a", "a", "replacement answer"),
    edit("remove", "replace", "u", null),
  ];
  const original = structuredClone(entries);
  const ui = assertSdkIds(entries);
  assert.deepEqual(ui.entryIds, ["a"]);
  assert.deepEqual(ui.messages[0].content, buildSessionProjection(entries).messages.at(-1).content);
  assert.equal(ui.messages[0].timestamp, 123);
  assert.equal(ui.messages[0].endedAt, Date.parse(timestamp));
  const history = buildSessionHistory(entries);
  assert.deepEqual(history.entryIds, ["u", "a"]);
  assert.equal(history.contextStartIndex, 1);
  assert.equal(history.messages[0].content, "raw request");
  assert.deepEqual(history.messages[1].content, [{ type: "text", text: "raw answer" }]);
  assert.deepEqual(entries, original);
});

test("latest edit restores a removal and edits follow the selected branch", () => {
  const entries = [
    entry("u", null, user("original")),
    edit("remove", "u", "u", null),
    edit("restore", "remove", "u", "restored"),
    entry("alt", "u", user("other branch")),
  ];
  assert.equal(assertSdkIds(entries, "remove").messages.length, 0);
  assert.equal(assertSdkIds(entries, "restore").messages[0].content, "restored");
  assert.deepEqual(assertSdkIds(entries, "alt").messages.map((m) => m.content), ["original", "other branch"]);
});

test("edited thinking remains inline and tool calls retain normalized provenance", () => {
  const entries = [
    entry("a", null, assistant([{ type: "thinking", thinking: "raw" }])),
    edit("e", "a", "a", [
      { type: "thinking", thinking: "edited" },
      { type: "toolCall", id: "call", name: "read", arguments: { path: "fixture" } },
    ]),
  ];
  const ui = buildSessionContext(entries, undefined, { deferThinking: true });
  assert.deepEqual(ui.entryIds, ["a"]);
  assert.equal(ui.messages[0].content[0].thinking, "edited");
  assert.equal(ui.messages[0].content[0].deferred, undefined);
  assert.equal(ui.messages[0].content[1].toolCallId, "call");
  assert.equal(ui.messages[0].content[1].toolName, "read");
});

test("custom message replacement preserves display metadata", () => {
  const entries = [
    { type: "custom_message", id: "c", parentId: null, timestamp, customType: "test",
      content: "raw", display: false, details: { fixture: true } },
    edit("e", "c", "c", "edited"),
  ];
  const ui = assertSdkIds(entries);
  assert.equal(ui.messages[0].content, "edited");
  assert.equal(ui.messages[0].display, false);
  assert.deepEqual(ui.messages[0].details, { fixture: true });
});

test("latest compaction precedes kept entries and suppresses older summaries", () => {
  const entries = [
    entry("old", null, user("dropped")),
    entry("kept", "old", user("raw kept")),
    compaction("cmp1", "kept", "kept"),
    entry("after", "cmp1", user("after first compaction")),
    compaction("cmp2", "after", "kept"),
    edit("replace", "cmp2", "kept", "edited kept"),
    edit("remove", "replace", "after", null),
  ];
  const ui = assertSdkIds(entries);
  assert.deepEqual(ui.entryIds, ["cmp2", "kept"]);
  assert.equal(ui.messages[0].content, "cmp2");
  assert.equal(ui.messages[1].content, "edited kept");
  const history = buildSessionHistory(entries);
  assert.deepEqual(history.entryIds, ["old", "kept", "cmp1", "after", "cmp2"]);
  assert.equal(history.messages[1].content, "raw kept");
  assert.equal(history.messages[2].content, "cmp1");
});

test("compacted-out edit directives no longer contribute context", () => {
  const entries = [
    entry("u", null, user("raw")),
    edit("e", "u", "u", "edited"),
    compaction("cmp1", "e", "e"),
    compaction("cmp2", "cmp1", "u"),
  ];
  assert.equal(assertSdkIds(entries).messages[1].content, "edited");
  entries.push(compaction("cmp3", "cmp2", "cmp1"));
  assert.deepEqual(assertSdkIds(entries).entryIds, ["cmp3"]);
});
