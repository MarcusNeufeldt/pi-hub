/**
 * Tests for computeRecovery — the pure decision behind the scheduler's
 * recoverable-failure auto-reschedule. Covers both paths:
 *   - SESSION_BUSY (resume §9): fixed short interval + fixed cap, NOT opt-in.
 *   - rate-limit (resume §11): opt-in policy with user interval + cap.
 * Plus the "only once tasks are rescued" guard (recurring tasks are left
 * alone, since their claim already advanced the schedule).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  computeRecovery,
  SESSION_BUSY_RETRY_INTERVAL_MS,
  MAX_SESSION_BUSY_ATTEMPTS,
} = await jiti.import("./scheduler-runtime.ts");

const NOW = 1_700_000_000_000;

function makeTask(overrides = {}) {
  return {
    id: "t1",
    name: "Resume Task",
    prompt: "do it",
    cwd: "/tmp",
    schedule: { scheduleType: "once", cronExpression: null, executeAt: NOW - 1, timezone: "UTC" },
    nextRunAt: null,
    execution: {
      provider: null,
      modelId: null,
      thinkingLevel: null,
      toolNames: [],
      timeoutSeconds: 7200,
      notifyOnSuccess: false,
      notifyOnFailure: true,
    },
    resume: { sessionFile: "/x.jsonl", sessionId: "s1" },
    retryOnRateLimit: null,
    attemptCount: 0,
    status: "completed",
    overlapPolicy: "skip",
    misfirePolicy: "run_once",
    misfireGraceSeconds: 86400,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeRun({ errorCode = null, errorMessage = null } = {}) {
  return {
    id: "run_1",
    taskId: "t1",
    dedupeKey: "scheduled:t1:1",
    taskNameSnapshot: "Resume Task",
    promptSnapshot: "do it",
    cwdSnapshot: "/tmp",
    scheduleSnapshotJson: "{}",
    executionOptionsSnapshotJson: "{}",
    resumeSnapshotJson: JSON.stringify({ sessionFile: "/x.jsonl", sessionId: "s1" }),
    triggerType: "scheduled",
    scheduledFor: NOW - 1,
    status: "failed",
    sessionId: null,
    resultExcerpt: null,
    errorCode,
    errorMessage,
    queuedAt: NOW,
    startedAt: NOW,
    finishedAt: NOW,
    heartbeatAt: NOW,
    createdAt: NOW,
  };
}

// ---- SESSION_BUSY (resume §9) --------------------------------------------

test("session_busy: reschedules a once resume task at the fixed interval", () => {
  const task = makeTask({ attemptCount: 0 });
  const run = makeRun({ errorCode: "SESSION_BUSY" });
  const d = computeRecovery(task, run, NOW);
  assert.ok(d);
  assert.equal(d.reason, "session_busy");
  assert.equal(d.nextRunAt, NOW + SESSION_BUSY_RETRY_INTERVAL_MS);
  assert.equal(d.attemptCount, 1);
  assert.equal(d.cap, MAX_SESSION_BUSY_ATTEMPTS);
});

test("session_busy: is NOT opt-in — works even without retryOnRateLimit", () => {
  const task = makeTask({ attemptCount: 0, retryOnRateLimit: null });
  const run = makeRun({ errorCode: "SESSION_BUSY" });
  assert.ok(computeRecovery(task, run, NOW));
});

test("session_busy: stops at the cap", () => {
  // attemptCount = cap - 1 → attemptsSoFar = cap → no more reschedule.
  const task = makeTask({ attemptCount: MAX_SESSION_BUSY_ATTEMPTS - 1 });
  const run = makeRun({ errorCode: "SESSION_BUSY" });
  assert.equal(computeRecovery(task, run, NOW), null);
});

test("session_busy: one-below-cap is the last reschedule", () => {
  const task = makeTask({ attemptCount: MAX_SESSION_BUSY_ATTEMPTS - 2 });
  const run = makeRun({ errorCode: "SESSION_BUSY" });
  const d = computeRecovery(task, run, NOW);
  assert.ok(d);
  assert.equal(d.attemptCount, MAX_SESSION_BUSY_ATTEMPTS - 1);
});

// ---- rate-limit (resume §11) ----------------------------------------------

test("rate_limit: reschedules when opted in and under the cap", () => {
  const task = makeTask({
    attemptCount: 0,
    retryOnRateLimit: { enabled: true, intervalMinutes: 300, maxAttempts: 3 },
  });
  const run = makeRun({ errorMessage: "Rate limit exceeded" });
  const d = computeRecovery(task, run, NOW);
  assert.ok(d);
  assert.equal(d.reason, "rate_limit");
  assert.equal(d.nextRunAt, NOW + 300 * 60_000);
  assert.equal(d.attemptCount, 1);
  assert.equal(d.cap, 3);
});

test("rate_limit: ignored when the policy is disabled / absent", () => {
  const task = makeTask({ retryOnRateLimit: null });
  const run = makeRun({ errorMessage: "Rate limit exceeded" });
  assert.equal(computeRecovery(task, run, NOW), null);
});

test("rate_limit: stops at the user cap", () => {
  const task = makeTask({
    attemptCount: 2, // attemptsSoFar = 3 >= maxAttempts(3)
    retryOnRateLimit: { enabled: true, intervalMinutes: 300, maxAttempts: 3 },
  });
  const run = makeRun({ errorMessage: "HTTP 429 Too Many Requests" });
  assert.equal(computeRecovery(task, run, NOW), null);
});

test("rate_limit: non-rate-limit errors are not recovered", () => {
  const task = makeTask({
    retryOnRateLimit: { enabled: true, intervalMinutes: 300, maxAttempts: 3 },
  });
  const run = makeRun({ errorMessage: "Permission denied" });
  assert.equal(computeRecovery(task, run, NOW), null);
});

// ---- guards ---------------------------------------------------------------

test("recurring tasks are never rescued (claim already advanced the schedule)", () => {
  const recurring = makeTask({
    schedule: { scheduleType: "recurring", cronExpression: "0 8 * * *", executeAt: null, timezone: "UTC" },
    retryOnRateLimit: { enabled: true, intervalMinutes: 300, maxAttempts: 3 },
  });
  // SESSION_BUSY on a recurring task → null (don't overwrite the next cycle).
  assert.equal(
    computeRecovery(recurring, makeRun({ errorCode: "SESSION_BUSY" }), NOW),
    null,
  );
  // rate-limit on a recurring task → null too (fixes the recurring-cadence
  // overwrite issue; recurring tasks retry on their own next cycle).
  assert.equal(
    computeRecovery(recurring, makeRun({ errorMessage: "Rate limit" }), NOW),
    null,
  );
});

test("SESSION_NOT_FOUND is not recoverable (the session file is gone)", () => {
  const task = makeTask({ attemptCount: 0 });
  const run = makeRun({ errorCode: "SESSION_NOT_FOUND" });
  assert.equal(computeRecovery(task, run, NOW), null);
});

test("manually-triggered runs are never auto-recovered", () => {
  // Recovery preserves the *scheduler's* execution plan; a manual trigger is
  // the user's explicit action, so even a once + SESSION_BUSY run that would
  // otherwise be rescued is left alone (no surprise retry loop).
  const task = makeTask({ attemptCount: 0 });
  const busyManual = makeRun({ errorCode: "SESSION_BUSY" });
  busyManual.triggerType = "manual";
  assert.equal(computeRecovery(task, busyManual, NOW), null);

  // Same for a manual rate-limit run on an opted-in task.
  const task2 = makeTask({
    retryOnRateLimit: { enabled: true, intervalMinutes: 300, maxAttempts: 3 },
  });
  const rlManual = makeRun({ errorMessage: "Rate limit exceeded" });
  rlManual.triggerType = "manual";
  assert.equal(computeRecovery(task2, rlManual, NOW), null);
});
