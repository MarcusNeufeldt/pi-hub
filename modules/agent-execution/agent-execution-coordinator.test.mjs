import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  AgentExecutionCoordinator,
} = await jiti.import("./agent-execution-coordinator.ts");
const {
  telegramOwnerKey,
  webOwnerKey,
  schedulerOwnerKey,
} = await jiti.import("./run-context.ts");

function ctx(sessionId, runId, source = "telegram", ownerKey = "telegram:1:0") {
  return { runId, sessionId, source, ownerKey };
}

test("acquire then release: session is exclusively owned", () => {
  const c = new AgentExecutionCoordinator();
  assert.equal(c.acquire(ctx("s1", "r1")).ok, true);
  assert.equal(c.getOwner("s1")?.runId, "r1");
  assert.equal(c.release("s1", "r1"), true);
  assert.equal(c.getOwner("s1"), null);
});

test("second acquire on a held session fails fast with the live owner", () => {
  const c = new AgentExecutionCoordinator();
  c.acquire({ ...ctx("s1", "r1"), sourceLabel: "Telegram" });
  const res = c.acquire(ctx("s1", "r2-web"));
  assert.equal(res.ok, false);
  assert.equal(res.owner?.runId, "r1");
  assert.equal(res.owner?.sourceLabel, "Telegram");
});

test("re-acquire with the same runId is idempotent", () => {
  const c = new AgentExecutionCoordinator();
  c.acquire(ctx("s1", "r1"));
  const res = c.acquire(ctx("s1", "r1"));
  assert.equal(res.ok, true);
  assert.equal(c.size(), 1);
});

test("release by a non-owner runId is rejected (without force)", () => {
  const c = new AgentExecutionCoordinator();
  c.acquire(ctx("s1", "r1"));
  assert.equal(c.release("s1", "r2"), false);
  assert.equal(c.getOwner("s1")?.runId, "r1"); // still held
  // force release works regardless
  assert.equal(c.release("s1", "r2", { force: true }), true);
  assert.equal(c.getOwner("s1"), null);
});

test("different sessions run independently", () => {
  const c = new AgentExecutionCoordinator();
  assert.equal(c.acquire(ctx("s1", "r1")).ok, true);
  assert.equal(c.acquire(ctx("s2", "r2")).ok, true);
  assert.equal(c.size(), 2);
  c.release("s1", "r1");
  assert.equal(c.size(), 1);
  // s1 free again
  assert.equal(c.acquire(ctx("s1", "r3")).ok, true);
});

test("isOwnedBy matches owner key, not runId", () => {
  const c = new AgentExecutionCoordinator();
  c.acquire({ runId: "r1", sessionId: "s1", source: "web", ownerKey: webOwnerKey("client-7") });
  assert.equal(c.isOwnedBy("s1", webOwnerKey("client-7")), true);
  assert.equal(c.isOwnedBy("s1", webOwnerKey("client-8")), false);
  assert.equal(c.isOwnedBy("s2", webOwnerKey("client-7")), false);
});

test("stale lock past maxTtl is reclaimable by a new acquire", () => {
  const c = new AgentExecutionCoordinator({ maxTtlMs: 1 });
  c.acquire(ctx("s1", "r1"));
  // wait past ttl
  const start = Date.now();
  while (Date.now() - start < 5) { /* spin ~5ms */ }
  // getOwner reclaims lazily
  assert.equal(c.getOwner("s1"), null);
  // a new run can now acquire
  assert.equal(c.acquire(ctx("s1", "r2")).ok, true);
});

test("sweep removes only locks older than maxTtl", () => {
  const c = new AgentExecutionCoordinator({ maxTtlMs: 100_000 });
  c.acquire(ctx("s1", "r1"));
  // force one to be old by recreating with a backdated startedAt via internal map
  // (simulate by using a second coordinator with tiny ttl + sleep)
  const c2 = new AgentExecutionCoordinator({ maxTtlMs: 1 });
  c2.acquire(ctx("s2", "r2"));
  const start = Date.now();
  while (Date.now() - start < 5) { /* spin */ }
  assert.equal(c2.sweep(), 1);
  assert.equal(c2.size(), 0);
  // c (long ttl) unaffected
  assert.equal(c.sweep(), 0);
});

test("owner-key builders produce stable, source-scoped strings", () => {
  assert.equal(telegramOwnerKey(123, 0), "telegram:123:0");
  assert.equal(telegramOwnerKey(123, 45), "telegram:123:45");
  assert.equal(webOwnerKey("abc"), "web:abc");
  assert.equal(schedulerOwnerKey("run_1"), "scheduler:run_1");
});
