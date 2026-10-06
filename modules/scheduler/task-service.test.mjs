import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { TaskService } = await jiti.import("./task-service.ts");

function makeRun() {
  return {
    id: "run-1",
    taskId: "task-1",
    dedupeKey: "manual:run-1",
    taskNameSnapshot: "Task",
    promptSnapshot: "run it",
    cwdSnapshot: "/tmp",
    scheduleSnapshotJson: "{}",
    executionOptionsSnapshotJson: "{}",
    resumeSnapshotJson: null,
    triggerType: "manual",
    scheduledFor: 1,
    status: "running",
    sessionId: "session-1",
    resultExcerpt: null,
    errorCode: null,
    errorMessage: null,
    queuedAt: 1,
    startedAt: 1,
    finishedAt: null,
    heartbeatAt: 1,
    createdAt: 1,
  };
}

test("cancelling a running run aborts it and keeps a terminal cancellation row", () => {
  let run = makeRun();
  let aborts = 0;
  const store = {
    getRun(id) {
      return id === run.id ? run : null;
    },
    updateRun(id, patch) {
      assert.equal(id, run.id);
      run = { ...run, ...patch };
      return run;
    },
  };
  const service = new TaskService(store, () => { aborts += 1; });

  const cancelled = service.cancelRun(run.id);
  assert.equal(aborts, 1);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.errorCode, "TASK_CANCELLED");
  assert.match(cancelled.errorMessage, /while running/);
});
