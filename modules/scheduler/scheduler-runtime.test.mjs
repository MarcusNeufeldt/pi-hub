import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { SchedulerRuntime } = await jiti.import("./scheduler-runtime.ts");

test("failed scheduler startup still exposes safe status and rejects service access", () => {
  const runtime = new SchedulerRuntime();
  runtime.inner = { error: "database migration failed" };

  const status = runtime.getStatus();
  assert.equal(status.running, false);
  assert.equal(status.error, "database migration failed");
  assert.equal(status.queuedRuns, 0);
  assert.equal(status.runningRuns, 0);
  assert.throws(() => runtime.getTaskService(), /database migration failed/);
});
