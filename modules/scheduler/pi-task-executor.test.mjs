/**
 * Tests for pi-task-executor — covers both the new-session path and the
 * resume path (resume mode): sessionFile is forwarded, model override is
 * applied, naming is skipped, and the SESSION_NOT_FOUND / SESSION_BUSY
 * guards short-circuit before starting a session.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { executeRun, buildResumePrompt, buildPrompt } = await jiti.import(
  "./pi-task-executor.ts",
);

function makeRun({ resume, prompt = "do the thing", cwd }) {
  return {
    id: "run_1",
    taskId: "task_1",
    dedupeKey: "manual:run_1",
    taskNameSnapshot: "Resume Task",
    promptSnapshot: prompt,
    cwdSnapshot: cwd,
    scheduleSnapshotJson: "{}",
    executionOptionsSnapshotJson: JSON.stringify({
      provider: null,
      modelId: null,
      thinkingLevel: null,
      toolNames: [],
      timeoutSeconds: 7200,
      notifyOnSuccess: false,
      notifyOnFailure: true,
    }),
    resumeSnapshotJson: resume ? JSON.stringify(resume) : null,
    triggerType: "manual",
    scheduledFor: Date.now(),
    status: "running",
    sessionId: null,
    resultExcerpt: null,
    errorCode: null,
    errorMessage: null,
    queuedAt: Date.now(),
    startedAt: Date.now(),
    finishedAt: null,
    heartbeatAt: null,
    createdAt: Date.now(),
  };
}

/** Fake RpcSession: records sent commands and auto-emits prompt_done. */
function makeFakeSession() {
  const sent = [];
  const listeners = new Set();
  return {
    sessionId: "real-session-1",
    sessionFile: "",
    sent,
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send(command) {
      sent.push(command);
      if (command.type === "prompt") {
        // runPromptAndWait subscribes before send(), so the listener is set.
        queueMicrotask(() => {
          for (const l of listeners) l({ type: "prompt_done" });
        });
      }
      return Promise.resolve(
        command.type === "get_last_assistant_text" ? { text: "all done" } : null,
      );
    },
    shutdown() {
      return Promise.resolve();
    },
  };
}

function makeProgress() {
  let finish = null;
  let sessionStarted = null;
  return {
    onSessionStarted: (id) => {
      sessionStarted = id;
    },
    onHeartbeat: () => {},
    onFinish: (r) => {
      finish = r;
    },
    getFinish: () => finish,
    getSessionStarted: () => sessionStarted,
  };
}

test("buildResumePrompt: instructs continuation and embeds the original task", () => {
  const p = buildResumePrompt("fix the bug");
  assert.match(p, /Resume Execution/);
  assert.match(p, /interrupted/i);
  assert.match(p, /Do NOT redo/);
  assert.ok(p.includes("fix the bug"));
});

test("buildResumePrompt: distinct from buildPrompt", () => {
  assert.ok(!buildResumePrompt("x").includes("unattended", "i"));
  assert.ok(buildPrompt("x").includes("Scheduled Execution"));
});

test("executeRun resume: opens the session file, overrides model, skips naming", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pihub-exec-"));
  const sessionFile = join(dir, "s.jsonl");
  writeFileSync(sessionFile, "{}\n");
  try {
    const resume = {
      sessionFile,
      sessionId: "real-session-1",
      provider: "anthropic",
      modelId: "claude-3-5-sonnet",
    };
    const run = makeRun({ resume, cwd: dir });
    const fake = makeFakeSession();
    const startCalls = [];
    const startSession = async (tempKey, file, cwd) => {
      startCalls.push({ sessionFile: file, cwd });
      return fake;
    };
    const progress = makeProgress();
    await executeRun(run, { startSession, progress });

    // startSession received the resume sessionFile (NOT "").
    assert.equal(startCalls[0].sessionFile, resume.sessionFile);
    // onSessionStarted surfaced the fake session id.
    assert.equal(progress.getSessionStarted(), "real-session-1");
    // No set_session_name in resume mode (keep the original name).
    assert.ok(!fake.sent.some((c) => c.type === "set_session_name"));
    // set_model issued with the override values.
    const setModel = fake.sent.find((c) => c.type === "set_model");
    assert.ok(setModel, "expected set_model command");
    assert.equal(setModel.provider, "anthropic");
    assert.equal(setModel.modelId, "claude-3-5-sonnet");
    // Prompt used the resume envelope (not the new-session one).
    const prompt = fake.sent.find((c) => c.type === "prompt");
    assert.match(prompt.message, /Resume Execution/);
    // Finished successfully with the excerpt captured.
    const finish = progress.getFinish();
    assert.equal(finish.status, "success");
    assert.equal(finish.resultExcerpt, "all done");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("executeRun resume: SESSION_NOT_FOUND when the session file is gone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pihub-exec-"));
  try {
    const resume = { sessionFile: join(dir, "missing.jsonl"), sessionId: "x" };
    const run = makeRun({ resume, cwd: dir });
    const startSession = async () => {
      throw new Error("should not start a session");
    };
    const progress = makeProgress();
    await executeRun(run, { startSession, progress });
    const finish = progress.getFinish();
    assert.equal(finish.status, "failed");
    assert.equal(finish.errorCode, "SESSION_NOT_FOUND");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("executeRun resume: SESSION_BUSY short-circuits when the session is in use", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pihub-exec-"));
  const sessionFile = join(dir, "s.jsonl");
  writeFileSync(sessionFile, "{}\n");
  try {
    const resume = { sessionFile, sessionId: "busy-1" };
    const run = makeRun({ resume, cwd: dir });
    const startSession = async () => {
      throw new Error("should not start a session");
    };
    const isSessionInUse = (id) => id === "busy-1";
    const progress = makeProgress();
    await executeRun(run, { startSession, progress, isSessionInUse });
    const finish = progress.getFinish();
    assert.equal(finish.status, "failed");
    assert.equal(finish.errorCode, "SESSION_BUSY");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("executeRun resume without model override: no set_model sent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pihub-exec-"));
  const sessionFile = join(dir, "s.jsonl");
  writeFileSync(sessionFile, "{}\n");
  try {
    const resume = { sessionFile, sessionId: "s-2" }; // no provider/modelId
    const run = makeRun({ resume, cwd: dir });
    const fake = makeFakeSession();
    const startSession = async () => fake;
    const progress = makeProgress();
    await executeRun(run, { startSession, progress });
    assert.ok(!fake.sent.some((c) => c.type === "set_model"));
    assert.equal(progress.getFinish().status, "success");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("executeRun new-session: creates a fresh session (sessionFile='')", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pihub-exec-"));
  try {
    const run = makeRun({ cwd: dir }); // no resume
    const fake = makeFakeSession();
    const startCalls = [];
    const startSession = async (tempKey, file) => {
      startCalls.push({ sessionFile: file });
      return fake;
    };
    const progress = makeProgress();
    await executeRun(run, { startSession, progress });
    assert.equal(startCalls[0].sessionFile, "");
    // set_session_name IS issued in new-session mode.
    assert.ok(fake.sent.some((c) => c.type === "set_session_name"));
    // Prompt used the standard envelope.
    const prompt = fake.sent.find((c) => c.type === "prompt");
    assert.match(prompt.message, /Scheduled Execution/);
    assert.equal(progress.getFinish().status, "success");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
