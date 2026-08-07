import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { SqliteTaskStore } = await jiti.import("./sqlite-task-store.ts");

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "pihub-store-"));
  const store = SqliteTaskStore.open(join(dir, "app.db"));
  return { store, dir };
}

function seedTask(store, overrides = {}) {
  const now = Date.now();
  return store.insertTask({
    id: overrides.id ?? "task_1",
    name: "Daily Review",
    prompt: "check",
    cwd: overrides.cwd ?? "/tmp",
    schedule: {
      scheduleType: "recurring",
      cronExpression: "0 8 * * *",
      executeAt: null,
      timezone: "Asia/Singapore",
    },
    nextRunAt: overrides.nextRunAt ?? now - 1,
    execution: {
      provider: null,
      modelId: null,
      thinkingLevel: null,
      toolNames: ["Read", "Bash"],
      timeoutSeconds: 7200,
      notifyOnSuccess: false,
      notifyOnFailure: true,
    },
    status: "active",
    misfirePolicy: "run_once",
    misfireGraceSeconds: 3600,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}

test("migration: opens a fresh db and creates all tables", () => {
  const { store, dir } = makeStore();
  try {
    // Re-opening should be idempotent (migrations already applied).
    store.close();
    const store2 = SqliteTaskStore.open(join(dir, "app.db"));
    const t = seedTask(store2);
    assert.equal(t.revision, 1);
    store2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CRUD: insert, get, update, delete", () => {
  const { store, dir } = makeStore();
  try {
    seedTask(store, { id: "crud" });
    assert.equal(store.getTask("crud").name, "Daily Review");

    const updated = store.updateTask("crud", 1, { name: "Renamed", updatedAt: Date.now() });
    assert.equal(updated.name, "Renamed");
    assert.equal(updated.revision, 2);

    assert.equal(store.deleteTask("crud"), true);
    assert.equal(store.getTask("crud"), null);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("revision conflict: stale revision returns null", () => {
  const { store, dir } = makeStore();
  try {
    seedTask(store, { id: "conflict" });
    const result = store.updateTask("conflict", 999, { name: "x", updatedAt: Date.now() });
    assert.equal(result, null);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claim: dedupe_key prevents duplicate runs for the same instant", () => {
  const { store, dir } = makeStore();
  try {
    const t = seedTask(store, { id: "claim", nextRunAt: 1000000 });
    const dueAt = t.nextRunAt;
    const claim1 = store.claimScheduledRun(
      "claim",
      Date.now(),
      (task) => ({ dedupeKey: `scheduled:claim:${task.nextRunAt}`, scheduledFor: task.nextRunAt }),
      () => ({ nextRunAt: dueAt + 86400000, status: "active" }),
    );
    assert.ok(claim1?.inserted);

    // Second claim with the SAME dedupe key must not insert.
    const claim2 = store.claimScheduledRun(
      "claim",
      Date.now(),
      () => ({ dedupeKey: `scheduled:claim:${dueAt}`, scheduledFor: dueAt }),
      () => ({ nextRunAt: dueAt + 86400000, status: "active" }),
    );
    assert.equal(claim2?.inserted, false);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claim: once-task is marked completed after claim", () => {
  const { store, dir } = makeStore();
  try {
    const now = Date.now();
    store.insertTask({
      id: "once",
      name: "once",
      prompt: "p",
      cwd: "/tmp",
      schedule: { scheduleType: "once", cronExpression: null, executeAt: now - 1, timezone: "UTC" },
      nextRunAt: now - 1,
      execution: { provider: null, modelId: null, thinkingLevel: null, toolNames: [], timeoutSeconds: 7200, notifyOnSuccess: false, notifyOnFailure: true },
      status: "active",
      misfirePolicy: "run_once",
      misfireGraceSeconds: 86400,
      createdAt: now,
      updatedAt: now,
    });
    const claim = store.claimScheduledRun(
      "once",
      now,
      (task) => ({ dedupeKey: `scheduled:once:${task.nextRunAt}`, scheduledFor: task.nextRunAt }),
      () => ({ nextRunAt: null, status: "completed" }),
    );
    assert.ok(claim?.inserted);
    assert.equal(store.getTask("once").status, "completed");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lease: acquire, renew, isLeader, takeover after expiry", () => {
  const { store, dir } = makeStore();
  try {
    // proc-1 acquires a 1-hour lease.
    assert.equal(store.tryAcquireLease("scheduler", "proc-1", 3600000), true);
    assert.equal(store.isLeader("scheduler", "proc-1"), true);
    assert.equal(store.isLeader("scheduler", "proc-2"), false);
    // proc-2 cannot acquire while proc-1 holds it.
    assert.equal(store.tryAcquireLease("scheduler", "proc-2", 3600000), false);
    // proc-1 renews.
    assert.equal(store.renewLease("scheduler", "proc-1", 3600000), true);

    // Simulate proc-1's lease expiring by backdating it, then proc-2 takes over.
    store.db
      .prepare(
        "UPDATE scheduler_leases SET lease_until = ? WHERE lease_name = 'scheduler'",
      )
      .run(Date.now() - 1000);
    assert.equal(store.tryAcquireLease("scheduler", "proc-2", 3600000), true);
    assert.equal(store.isLeader("scheduler", "proc-2"), true);
    assert.equal(store.isLeader("scheduler", "proc-1"), false);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recovery: stale running runs are marked interrupted", () => {
  const { store, dir } = makeStore();
  try {
    const now = Date.now();
    seedTask(store, { id: "recover" });
    store.claimScheduledRun(
      "recover",
      now,
      (task) => ({ dedupeKey: `scheduled:recover:${task.nextRunAt}`, scheduledFor: task.nextRunAt }),
      () => ({ nextRunAt: now + 86400000, status: "active" }),
    );
    // Find the run and mark it running with a stale heartbeat.
    const runs = store.listRuns({ taskId: "recover" });
    assert.equal(runs.length, 1);
    store.updateRun(runs[0].id, { status: "running", startedAt: now, heartbeatAt: now - 200000 });
    const recovered = store.markStaleRunningAsInterrupted(now, 90000);
    assert.equal(recovered, 1);
    const after = store.getRun(runs[0].id);
    assert.equal(after.status, "interrupted");
    assert.equal(after.errorCode, "PROCESS_RESTARTED");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listTaskCwds: returns distinct cwds", () => {
  const { store, dir } = makeStore();
  try {
    seedTask(store, { id: "a", cwd: "/x" });
    seedTask(store, { id: "b", cwd: "/y" });
    seedTask(store, { id: "c", cwd: "/x" });
    const cwds = store.listTaskCwds().sort();
    assert.deepEqual(cwds, ["/x", "/y"]);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
