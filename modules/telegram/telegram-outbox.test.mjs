import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { SqliteTelegramStore } = await jiti.import("./sqlite-telegram-store.ts");
const { OutboxWriter, OutboxWorker } = await jiti.import("./telegram-outbox.ts");
const { ActionService } = await jiti.import("./telegram-actions.ts");

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "pihub-tg-out-"));
  const store = SqliteTelegramStore.open(join(dir, "app.db"));
  return { store, dir };
}

/** Records every sendMessage call; can be programmed to fail N times. */
function fakeTransport() {
  const calls = [];
  let failNTimes = 0;
  let failCode = null;
  let failMsg = "boom";
  return {
    calls,
    failTimes(n, code = null, msg = "boom") {
      failNTimes = n;
      failCode = code;
      failMsg = msg;
    },
    lastSuccessfulSendAt: null,
    async sendMessage(input) {
      calls.push(input);
      if (failNTimes > 0) {
        failNTimes--;
        const err = new Error(failMsg);
        if (failCode) err.code = failCode;
        throw err;
      }
      return { messageId: calls.length, chatId: input.chatId, date: 1 };
    },
  };
}

test("outbox writer enqueues and dedupes by key", () => {
  const { store, dir } = makeStore();
  try {
    const w = new OutboxWriter(store);
    const a = w.enqueue({ dedupeKey: "k1", chatId: 1, threadId: 0, eventType: "test", message: { text: "hi" } });
    const b = w.enqueue({ dedupeKey: "k1", chatId: 1, threadId: 0, eventType: "test", message: { text: "hi" } });
    assert.equal(a, true);
    assert.equal(b, false); // duplicate dropped
    assert.equal(store.countOutbox("pending"), 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("outbox worker sends pending entries via transport", async () => {
  const { store, dir } = makeStore();
  try {
    const w = new OutboxWriter(store);
    const t = fakeTransport();
    w.enqueue({ dedupeKey: "k1", chatId: 100, threadId: 0, eventType: "test", message: { text: "one" } });
    w.enqueue({ dedupeKey: "k2", chatId: 100, threadId: 0, eventType: "test", message: { text: "two" } });

    const worker = new OutboxWorker({ store, getTransport: () => t });
    const processed = await worker.runOnce(Date.now());
    assert.equal(processed, 2);
    assert.equal(store.countOutbox("sent"), 2);
    assert.equal(store.countOutbox("pending"), 0);
    assert.equal(t.calls.length, 2);
    assert.deepEqual(t.calls.map((c) => c.text).sort(), ["one", "two"]);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("outbox worker retries with backoff and eventually fails after max attempts", async () => {
  const { store, dir } = makeStore();
  try {
    const w = new OutboxWriter(store);
    const t = fakeTransport();
    t.failTimes(99); // always fail
    w.enqueue({ dedupeKey: "k1", chatId: 1, threadId: 0, eventType: "test", message: { text: "x" }, runAt: 1 });

    const worker = new OutboxWorker({
      store,
      getTransport: () => t,
      maxAttempts: 3,
      baseBackoffMs: 1_000,
      maxBackoffMs: 5_000,
    });

    let now = 1_000_000;
    // attempt 1 → fail → attemptCount=1, pending, nextAttempt in future
    await worker.runOnce(now);
    assert.equal(store.countOutbox("pending"), 1);
    let entry = store.listOutbox("pending", 1)[0];
    assert.equal(entry.attemptCount, 1);
    assert.ok(entry.nextAttemptAt > now, "next attempt is in the future");

    // jump to just before nextAttempt → skipped
    let n = await worker.runOnce(entry.nextAttemptAt - 1);
    assert.equal(n, 0);

    // attempt 2
    await worker.runOnce(entry.nextAttemptAt);
    entry = store.listOutbox("pending", 1)[0];
    assert.equal(entry.attemptCount, 2);

    // attempt 3 → max reached → failed
    await worker.runOnce(entry.nextAttemptAt);
    assert.equal(store.countOutbox("failed"), 1);
    assert.equal(store.countOutbox("pending"), 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("outbox worker honors 429 retry_after over exponential backoff", async () => {
  const { store, dir } = makeStore();
  try {
    const w = new OutboxWriter(store);
    const t = fakeTransport();
    t.failTimes(0, "TELEGRAM_RATE_LIMITED", "Rate limited by Telegram (retry after 42s).");
    // force a failure with 429 on first (only) attempt
    t.failTimes(1, "TELEGRAM_RATE_LIMITED", "Rate limited by Telegram (retry after 42s).");
    w.enqueue({ dedupeKey: "k1", chatId: 1, threadId: 0, eventType: "test", message: { text: "x" }, runAt: 1 });

    const now = 5_000_000;
    const worker = new OutboxWorker({ store, getTransport: () => t, baseBackoffMs: 1_000 });
    await worker.runOnce(now);
    const entry = store.listOutbox("pending", 1)[0];
    assert.equal(entry.attemptCount, 1);
    // retry_after 42s should beat the small exponential backoff
    assert.ok(entry.nextAttemptAt - now >= 42_000, `expected ~42s delay, got ${entry.nextAttemptAt - now}`);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("outbox worker stops immediately on invalid token and marks failed", async () => {
  const { store, dir } = makeStore();
  try {
    const w = new OutboxWriter(store);
    const t = fakeTransport();
    t.failTimes(0, "TELEGRAM_TOKEN_INVALID", "Unauthorized");
    // force a failure with invalid-token code on first (only) attempt
    t.failTimes(1, "TELEGRAM_TOKEN_INVALID", "Unauthorized");
    w.enqueue({ dedupeKey: "k1", chatId: 1, threadId: 0, eventType: "test", message: { text: "x" } });

    let terminal = null;
    const worker = new OutboxWorker({
      store,
      getTransport: () => t,
      maxAttempts: 5,
      onTerminal: (e) => {
        terminal = e;
      },
    });
    await worker.runOnce(Date.now());
    assert.equal(store.countOutbox("failed"), 1);
    assert.equal(store.countOutbox("pending"), 0);
    assert.equal(terminal?.reason, "invalid_token");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("outbox worker does nothing when transport is unavailable (not leader)", async () => {
  const { store, dir } = makeStore();
  try {
    const w = new OutboxWriter(store);
    w.enqueue({ dedupeKey: "k1", chatId: 1, threadId: 0, eventType: "test", message: { text: "x" } });
    const worker = new OutboxWorker({ store, getTransport: () => null });
    const n = await worker.runOnce(Date.now());
    assert.equal(n, 0);
    assert.equal(store.countOutbox("pending"), 1); // untouched, no attempts burned
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("outbox worker reclaims entries stuck in 'sending'", async () => {
  const { store, dir } = makeStore();
  try {
    const w = new OutboxWriter(store);
    w.enqueue({ dedupeKey: "k1", chatId: 1, threadId: 0, eventType: "test", message: { text: "x" }, runAt: 1 });
    // simulate a crash mid-send: flip to "sending".
    const entry = store.listOutbox("pending", 1)[0];
    store.updateOutbox(entry.id, { status: "sending" });

    const t = fakeTransport();
    const worker = new OutboxWorker({ store, getTransport: () => t, staleSendingMs: 5 });

    // Immediately (within the staleness window): not reclaimed, no pending → no send.
    let n = await worker.runOnce(Date.now());
    assert.equal(n, 0);
    assert.equal(store.countOutbox("sent"), 0);

    // After the staleness window elapses, the stuck entry is reclaimed + sent.
    await new Promise((r) => setTimeout(r, 20));
    n = await worker.runOnce(Date.now());
    assert.equal(n, 1);
    assert.equal(store.countOutbox("sent"), 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Action tokens
// ---------------------------------------------------------------------------

test("action service: create + consume is single-use and identity-bound", () => {
  const { store, dir } = makeStore();
  try {
    const a = new ActionService(store);
    const { token, callbackData } = a.create({
      actionType: "task_run",
      payload: { taskId: "t1" },
      userId: 42,
      chatId: 0,
      threadId: 0,
    });
    assert.equal(callbackData, `a:${token}`);

    // wrong user → forbidden, token NOT consumed
    const forbidden = a.consume(token, 99);
    assert.equal(forbidden.ok, false);
    assert.equal(forbidden.reason, "forbidden");

    // correct user → ok
    const ok = a.consume(token, 42);
    assert.equal(ok.ok, true);
    assert.equal(ok.action.actionType, "task_run");
    assert.equal(ok.action.payload.taskId, "t1");

    // second consume → used
    const used = a.consume(token, 42);
    assert.equal(used.ok, false);
    assert.equal(used.reason, "used");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("action service: unbound token usable by any caller", () => {
  const { store, dir } = makeStore();
  try {
    const a = new ActionService(store);
    const { token } = a.create({
      actionType: "task_run",
      payload: {},
      userId: null,
      chatId: 0,
      threadId: 0,
    });
    assert.equal(a.consume(token, 1).ok, true);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("action service: expired token rejected", async () => {
  const { store, dir } = makeStore();
  try {
    const a = new ActionService(store);
    const { token } = a.create({
      actionType: "task_run",
      payload: {},
      userId: null,
      chatId: 0,
      threadId: 0,
      ttlMs: 1,
    });
    // wait past the 1ms expiry
    await new Promise((r) => setTimeout(r, 10));
    const res = a.consume(token, 1);
    assert.equal(res.ok, false);
    assert.equal(res.reason, "expired");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
