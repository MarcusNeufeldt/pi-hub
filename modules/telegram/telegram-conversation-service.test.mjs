import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { SqliteTelegramStore } = await jiti.import("./sqlite-telegram-store.ts");
const { TelegramConversationService, ConversationBusyError, sessionLabel } = await jiti.import(
  "./telegram-conversation-service.ts",
);

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "pihub-tg-conv-"));
  const store = SqliteTelegramStore.open(join(dir, "app.db"));
  store.upsertUser({ telegramUserId: 42, role: "owner", enabled: true });
  return { store, dir };
}

function baseInput(overrides = {}) {
  return {
    chatId: 100,
    threadId: 0,
    userId: 42,
    chatType: "private",
    workspace: "/repo",
    ...overrides,
  };
}

test("ensure: creates the conversation + chat row on first use", () => {
  const { store, dir } = makeStore();
  try {
    const svc = new TelegramConversationService(store);
    const conv = svc.ensure(baseInput());
    assert.equal(conv.workspace, "/repo");
    assert.equal(conv.state, "idle");
    assert.ok(store.getChat(100), "chat row created");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensure: returns the existing row on subsequent calls (idempotent)", () => {
  const { store, dir } = makeStore();
  try {
    const svc = new TelegramConversationService(store);
    svc.ensure(baseInput());
    const conv2 = svc.ensure(baseInput());
    assert.equal(conv2.state, "idle");
    assert.equal(store.conversationCount(), 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensure: throws ConversationBusyError when state is running", () => {
  const { store, dir } = makeStore();
  try {
    const svc = new TelegramConversationService(store);
    svc.ensure(baseInput());
    svc.setActiveSession(100, 0, "sess-1", "/data/sess-1.jsonl"); // state → running
    assert.throws(() => svc.ensure(baseInput()), (err) => err instanceof ConversationBusyError);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setActiveSession + markIdle + recordPrompt + rebind round-trip", () => {
  const { store, dir } = makeStore();
  try {
    const svc = new TelegramConversationService(store);
    svc.ensure(baseInput());
    svc.setActiveSession(100, 0, "sess-1", "/data/sess-1.jsonl");
    let conv = store.getConversation(100, 0);
    assert.equal(conv?.activeSessionId, "sess-1");
    assert.equal(conv?.state, "running");

    svc.recordPrompt(100, 0, "fix the bug");
    svc.markIdle(100, 0);
    conv = store.getConversation(100, 0);
    assert.equal(conv?.state, "idle");
    assert.equal(conv?.lastPrompt, "fix the bug");

    svc.rebind(100, 0, "sess-2", "/data/sess-2.jsonl");
    conv = store.getConversation(100, 0);
    assert.equal(conv?.activeSessionId, "sess-2");
    assert.equal(conv?.state, "idle");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sessionLabel produces the [TG] name · stamp format", () => {
  const label = sessionLabel("jarome", new Date(2026, 0, 7, 12, 30));
  assert.match(label, /^\[TG\] jarome · 0107 12:30$/);
});
