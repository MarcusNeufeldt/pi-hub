import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { SqliteTelegramStore } = await jiti.import("./sqlite-telegram-store.ts");
const { notifyManualRun } = await jiti.import("./telegram-manual-run-notifier.ts");

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "pihub-tg-mrn-"));
  return { store: SqliteTelegramStore.open(join(dir, "app.db")), dir };
}

function seedOwner(store) {
  store.upsertUser({ telegramUserId: 42, role: "owner", enabled: true });
  store.upsertChat({ chatId: 100, chatType: "private", approvedBy: 42 });
  store.upsertConversation({ chatId: 100, threadId: 0, ownerUserId: 42 });
}

test("manual-run: success enqueues to every owner chat", () => {
  const { store, dir } = makeStore();
  try {
    seedOwner(store);
    const result = notifyManualRun(store, {
      sessionId: "sess-1",
      status: "success",
      sessionName: "My Chat",
      prompt: "refactor the parser",
      resultExcerpt: "done",
      finishedAt: 1_700_000_000_000,
    });
    assert.equal(result.notified, 1);
    const entry = store.listOutbox("pending", 5)[0];
    const payload = JSON.parse(entry.payloadJson);
    assert.equal(payload.parseMode, "HTML");
    assert.match(payload.text, /✅ 手动任务完成/);
    assert.match(payload.text, /My Chat/);
    assert.match(payload.text, /refactor the parser/);
    assert.match(payload.text, /sess-1/);
    assert.ok(entry.dedupeKey.startsWith("manual-run:sess-1:"));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("manual-run: failure renders error message", () => {
  const { store, dir } = makeStore();
  try {
    seedOwner(store);
    const result = notifyManualRun(store, {
      sessionId: "sess-2",
      status: "failed",
      errorMessage: "model rate limited",
      finishedAt: 1_700_000_000_001,
    });
    assert.equal(result.notified, 1);
    const payload = JSON.parse(store.listOutbox("pending", 1)[0].payloadJson);
    assert.match(payload.text, /❌ 手动任务失败/);
    assert.match(payload.text, /model rate limited/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("manual-run: no targets / no store → silent no-op", () => {
  const { store, dir } = makeStore();
  try {
    // no users → nothing to enqueue, no throw
    const result = notifyManualRun(store, { sessionId: "s", status: "success" });
    assert.equal(result.notified, 0);
    assert.equal(result.skipped, true);
    assert.equal(store.countOutbox("pending"), 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("manual-run: publicUrl renders an open-session link", () => {
  const { store, dir } = makeStore();
  try {
    seedOwner(store);
    notifyManualRun(store, {
      sessionId: "sess-3",
      status: "success",
      publicUrl: "https://hub.example.com/",
    });
    const payload = JSON.parse(store.listOutbox("pending", 1)[0].payloadJson);
    assert.match(payload.text, /打开会话/);
    assert.match(payload.text, /https:\/\/hub\.example\.com\/\?session=sess-3/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
