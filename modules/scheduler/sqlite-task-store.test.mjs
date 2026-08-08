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

test("resume: insert/get/update/clear resume target", () => {
  const { store, dir } = makeStore();
  try {
    const resume = {
      sessionFile: "/home/u/.pi/agent/sessions/x/abc.jsonl",
      sessionId: "abc-123",
    };
    seedTask(store, { id: "resume-task", resume });
    let t = store.getTask("resume-task");
    assert.deepEqual(t.resume, resume);

    // Update resume (different session + model override).
    const resume2 = {
      sessionFile: "/home/u/.pi/agent/sessions/y/def.jsonl",
      sessionId: "def-456",
      provider: "anthropic",
      modelId: "claude-3",
    };
    const updated = store.updateTask("resume-task", t.revision, {
      resume: resume2,
      updatedAt: Date.now(),
    });
    assert.deepEqual(updated.resume, resume2);

    // Clear resume → null.
    const cleared = store.updateTask("resume-task", updated.revision, {
      resume: null,
      updatedAt: Date.now(),
    });
    assert.equal(cleared.resume, null);

    // undefined resume on update keeps the current value (null).
    const untouched = store.updateTask("resume-task", cleared.revision, {
      name: "Renamed",
      updatedAt: Date.now(),
    });
    assert.equal(untouched.resume, null);
    assert.equal(untouched.name, "Renamed");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume: claim snapshots resume target into the run", () => {
  const { store, dir } = makeStore();
  try {
    const resume = {
      sessionFile: "/home/u/.pi/agent/sessions/x/abc.jsonl",
      sessionId: "abc-123",
    };
    seedTask(store, { id: "resume-claim", resume });
    const claim = store.claimScheduledRun(
      "resume-claim",
      Date.now(),
      (task) => ({
        dedupeKey: `scheduled:resume-claim:${task.nextRunAt}`,
        scheduledFor: task.nextRunAt,
      }),
      () => ({ nextRunAt: Date.now() + 86400000, status: "active" }),
    );
    assert.ok(claim?.inserted);
    assert.equal(
      store.getRun(claim.run.id).resumeSnapshotJson,
      JSON.stringify(resume),
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume: non-resume task run has null resumeSnapshotJson", () => {
  const { store, dir } = makeStore();
  try {
    seedTask(store, { id: "plain" });
    const claim = store.claimScheduledRun(
      "plain",
      Date.now(),
      (task) => ({
        dedupeKey: `scheduled:plain:${task.nextRunAt}`,
        scheduledFor: task.nextRunAt,
      }),
      () => ({ nextRunAt: Date.now() + 86400000, status: "active" }),
    );
    assert.ok(claim?.inserted);
    assert.equal(store.getRun(claim.run.id).resumeSnapshotJson, null);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("retryOnRateLimit: insert/get/update/clear policy", () => {
  const { store, dir } = makeStore();
  try {
    const policy = { enabled: true, intervalMinutes: 300, maxAttempts: 3 };
    seedTask(store, { id: "rl-task", retryOnRateLimit: policy });
    let t = store.getTask("rl-task");
    assert.deepEqual(t.retryOnRateLimit, policy);
    assert.equal(t.attemptCount, 0);

    // Update policy.
    const policy2 = { enabled: true, intervalMinutes: 60, maxAttempts: 5 };
    const updated = store.updateTask("rl-task", t.revision, {
      retryOnRateLimit: policy2,
      updatedAt: Date.now(),
    });
    assert.deepEqual(updated.retryOnRateLimit, policy2);

    // Clear policy.
    const cleared = store.updateTask("rl-task", updated.revision, {
      retryOnRateLimit: null,
      updatedAt: Date.now(),
    });
    assert.equal(cleared.retryOnRateLimit, null);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rescheduleTask: reactivates a completed task and bumps attemptCount", () => {
  const { store, dir } = makeStore();
  try {
    const now = Date.now();
    store.insertTask({
      id: "once-rl",
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
    // Claim consumes the once schedule → status completed.
    store.claimScheduledRun(
      "once-rl",
      now,
      (task) => ({
        dedupeKey: `scheduled:once-rl:${task.nextRunAt}`,
        scheduledFor: task.nextRunAt,
      }),
      () => ({ nextRunAt: null, status: "completed" }),
    );
    assert.equal(store.getTask("once-rl").status, "completed");

    // Reschedule: completed → active, nextRunAt set, attemptCount bumped.
    const next = now + 60000;
    store.rescheduleTask("once-rl", next, 1);
    const after = store.getTask("once-rl");
    assert.equal(after.status, "active");
    assert.equal(after.nextRunAt, next);
    assert.equal(after.attemptCount, 1);

    // It is now due again and picked up by the scanner.
    const due = store.listDueTasks(next);
    assert.ok(due.some((t) => t.id === "once-rl"));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rescheduleTask: does NOT override a paused task", () => {
  const { store, dir } = makeStore();
  try {
    seedTask(store, { id: "paused-rl", status: "paused" });
    store.rescheduleTask("paused-rl", Date.now() + 60000, 1);
    const t = store.getTask("paused-rl");
    assert.equal(t.status, "paused");
    assert.equal(t.attemptCount, 0); // unchanged — user pause respected
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resetAttemptCount: zeroes the counter", () => {
  const { store, dir } = makeStore();
  try {
    seedTask(store, { id: "reset-rl" });
    store.rescheduleTask("reset-rl", Date.now() + 60000, 2);
    assert.equal(store.getTask("reset-rl").attemptCount, 2);
    store.resetAttemptCount("reset-rl");
    assert.equal(store.getTask("reset-rl").attemptCount, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
