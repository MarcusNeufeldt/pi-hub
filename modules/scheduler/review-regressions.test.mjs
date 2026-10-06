import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { SchedulerRuntime } = await jiti.import("./scheduler-runtime.ts");
const { TaskService } = await jiti.import("./task-service.ts");
const { SqliteTaskStore } = await jiti.import("./sqlite-task-store.ts");
const { migrate } = await jiti.import("./schema-migrations.ts");
const { NoopTaskNotifier } = await jiti.import("./task-notifier.ts");

function task(store, id, toolNames) {
  return store.insertTask({
    id, name: "test", prompt: "test", cwd: process.cwd(),
    schedule: { scheduleType: "once", executeAt: Date.now(), cronExpression: null, timezone: "UTC" },
    nextRunAt: Date.now(), status: "active", misfirePolicy: "run_once", misfireGraceSeconds: 3600,
    execution: { provider: null, modelId: null, thinkingLevel: null, toolNames,
      timeoutSeconds: 60, notifyOnSuccess: false, notifyOnFailure: true },
    createdAt: Date.now(), updatedAt: Date.now(),
  });
}
function run(store, definition, id = "run", status = "queued") {
  return store.insertRunIfAbsent({
    id, taskId: definition.id, dedupeKey: id, taskNameSnapshot: definition.name,
    promptSnapshot: definition.prompt, cwdSnapshot: definition.cwd,
    scheduleSnapshotJson: JSON.stringify(definition.schedule),
    executionOptionsSnapshotJson: JSON.stringify(definition.execution),
    triggerType: "manual", scheduledFor: Date.now(), status, queuedAt: Date.now(), createdAt: Date.now(),
  }).run;
}

test("legacy empty tool settings retain defaults; new explicit empty selections remain disabled", () => {
  const store = SqliteTaskStore.open(":memory:");
  try {
    // Simulate version 3 records without touching the live database.
    store.db.exec("DELETE FROM schema_migrations WHERE version = 4");
    const legacy = task(store, "legacy", []);
    run(store, legacy, "queued");
    run(store, legacy, "history", "success");
    assert.equal(migrate(store.db), 5); // v5 = gate_command column
    assert.equal(store.getTask("legacy").execution.toolNames, undefined);
    assert.equal(JSON.parse(store.getRun("queued").executionOptionsSnapshotJson).toolNames, undefined);
    assert.deepEqual(JSON.parse(store.getRun("history").executionOptionsSnapshotJson).toolNames, []);
    assert.equal(store.getTask("legacy").revision, legacy.revision + 1);
    task(store, "disabled", []);
    task(store, "defaults", undefined);
    task(store, "named", ["Read", "Bash", "extension_tool"]);
    migrate(store.db);
    assert.deepEqual(store.getTask("disabled").execution.toolNames, []);
    assert.equal(store.getTask("defaults").execution.toolNames, undefined);
    assert.deepEqual(store.getTask("named").execution.toolNames, ["read", "bash", "extension_tool"]);
  } finally { store.close(); }
});

for (const timing of ["during prompt", "after prompt", "before startup"]) {
  test(`runtime cancellation reaches the agent and stays terminal: ${timing}`, async () => {
    const store = SqliteTaskStore.open(":memory:");
    const runtime = new SchedulerRuntime();
    const service = new TaskService(store, (id) => runtime.abortRun(id));
    const definition = task(store, "task", undefined);
    const record = run(store, definition);
    const listeners = new Set(), commands = [];
    let starts = 0, shutdowns = 0, promptStarted;
    const entered = new Promise((resolve) => { promptStarted = resolve; });
    const notifier = new NoopTaskNotifier();
    if (timing === "before startup") notifier.onRunStarted = async () => { service.cancelRun(record.id); };
    const inner = {
      store, service, notifier, active: new Map(), isSessionInUse: () => false,
      startSession: async () => {
        starts++;
        return {
          sessionId: "fake", sessionFile: "",
          onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); },
          async send(command) {
            commands.push(command.type);
            if (command.type === "prompt") {
              promptStarted();
              if (timing === "after prompt") for (const fn of listeners) fn({ type: "prompt_done" });
            }
            if (command.type === "get_last_assistant_text") {
              service.cancelRun(record.id);
              return { text: "finished concurrently" };
            }
            return null;
          },
          async shutdown() { shutdowns++; },
        };
      },
    };
    runtime.inner = inner;
    try {
      const execution = runtime.execute(inner, record);
      if (timing === "during prompt") {
        await entered;
        service.cancelRun(record.id);
      }
      await execution;
      assert.equal(store.getRun(record.id).status, "cancelled");
      assert.equal(store.getRun(record.id).errorCode, "TASK_CANCELLED");
      assert.equal(inner.active.size, 0);
      // A late writer in another process cannot replace the cancellation.
      store.updateRun(record.id, { status: "success", errorCode: null });
      assert.equal(store.getRun(record.id).status, "cancelled");
      assert.equal(store.getRun(record.id).errorCode, "TASK_CANCELLED");
      if (timing === "before startup") assert.equal(starts, 0);
      else assert.equal(shutdowns, 1);
      if (timing === "during prompt") assert.ok(commands.includes("abort"));
      // A stale queued snapshot cannot resurrect the cancelled row.
      const oldStarts = starts;
      await runtime.execute(inner, record);
      assert.equal(starts, oldStarts);
    } finally { store.close(); }
  });
}
