/**
 * Tests for the TaskNotifier port — focused on the generic safeNotify routing
 * (especially the new onRunDeferred path, which carries extra fields) and the
 * error-swallowing contract. The scheduler-runtime's "recovered → deferred,
 * terminal → failed" branching is driven by computeRecovery (covered in
 * recovery.test.mjs); here we verify the notification dispatch itself.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { safeNotify, NoopTaskNotifier } = await jiti.import(
  "./task-notifier.ts",
);

/** A notifier that records every hook invocation. */
function recordingNotifier() {
  const calls = [];
  return {
    calls,
    notifier: {
      async onRunStarted(e) {
        calls.push({ hook: "onRunStarted", e });
      },
      async onRunSucceeded(e) {
        calls.push({ hook: "onRunSucceeded", e });
      },
      async onRunFailed(e) {
        calls.push({ hook: "onRunFailed", e });
      },
      async onRunDeferred(e) {
        calls.push({ hook: "onRunDeferred", e });
      },
    },
  };
}

const baseEvent = { run: { id: "run_1" }, taskName: "T" };

test("safeNotify: routes onRunDeferred with the extra fields, not onRunFailed", async () => {
  const { calls, notifier } = recordingNotifier();
  await safeNotify(notifier, "onRunDeferred", {
    ...baseEvent,
    nextRunAt: 1_700_000_300_000,
    reason: "session_busy",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].hook, "onRunDeferred");
  assert.equal(calls[0].e.nextRunAt, 1_700_000_300_000);
  assert.equal(calls[0].e.reason, "session_busy");
});

test("safeNotify: terminal failures still route to onRunFailed", async () => {
  const { calls, notifier } = recordingNotifier();
  await safeNotify(notifier, "onRunFailed", baseEvent);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].hook, "onRunFailed");
});

test("safeNotify: success/succeeded routing unchanged", async () => {
  const { calls, notifier } = recordingNotifier();
  await safeNotify(notifier, "onRunSucceeded", baseEvent);
  await safeNotify(notifier, "onRunStarted", baseEvent);
  assert.deepEqual(
    calls.map((c) => c.hook),
    ["onRunSucceeded", "onRunStarted"],
  );
});

test("safeNotify: swallows notifier errors (run state must never flip)", async () => {
  const broken = {
    async onRunDeferred() {
      throw new Error("transport down");
    },
  };
  // Must NOT throw.
  await safeNotify(broken, "onRunDeferred", {
    ...baseEvent,
    nextRunAt: 1,
    reason: "rate_limit",
  });
});

test("safeNotify: missing hook is a no-op (partial notifiers)", async () => {
  const partial = { onRunSucceeded() {} }; // only implements one hook
  await safeNotify(partial, "onRunDeferred", {
    ...baseEvent,
    nextRunAt: 1,
    reason: "session_busy",
  });
  // No throw, nothing to assert beyond reaching here.
  assert.ok(true);
});

test("NoopTaskNotifier: implements onRunDeferred without throwing", async () => {
  const noop = new NoopTaskNotifier();
  await noop.onRunDeferred({
    ...baseEvent,
    nextRunAt: 1,
    reason: "session_busy",
  });
  assert.ok(true);
});
