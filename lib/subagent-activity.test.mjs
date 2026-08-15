import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_STALE_RUN_MS,
  findLiveSubagentWork,
  hasLiveSubagentWork,
  resolveSubagentTempScopeId,
  sessionIdFromSessionPath,
  subagentAsyncRunsDir,
} from "./subagent-activity.ts";

const NOW = 1_800_000_000_000;

async function runsDir(runs) {
  const dir = await mkdtemp(join(tmpdir(), "pi-hub-subagent-activity-"));
  for (const [name, status] of Object.entries(runs)) {
    await mkdir(join(dir, name), { recursive: true });
    if (status !== null) {
      await writeFile(join(dir, name, "status.json"), typeof status === "string" ? status : JSON.stringify(status));
    }
  }
  return dir;
}

test("a running detached run keeps its own session alive and no other", async () => {
  const dir = await runsDir({
    "run-a": { runId: "run-a", sessionId: "S1", state: "running", lastUpdate: NOW - 1000 },
    "run-b": { runId: "run-b", sessionId: "S2", state: "running", lastUpdate: NOW - 1000 },
  });
  try {
    assert.equal(hasLiveSubagentWork("S1", { dir, now: NOW }), true);
    assert.equal(hasLiveSubagentWork("S2", { dir, now: NOW }), true);
    assert.equal(hasLiveSubagentWork("S3", { dir, now: NOW }), false);
    assert.deepEqual(findLiveSubagentWork("S1", { dir, now: NOW }).map((r) => r.runId), ["run-a"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("queued and paused count as live; terminal states do not", async () => {
  const states = {
    queued: true,
    running: true,
    paused: true,
    complete: false,
    failed: false,
    stopped: false,
    rejected: false,
  };
  for (const [state, expected] of Object.entries(states)) {
    const dir = await runsDir({ r: { runId: "r", sessionId: "S", state, lastUpdate: NOW } });
    try {
      assert.equal(hasLiveSubagentWork("S", { dir, now: NOW }), expected, `state ${state}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("a run that stopped updating ages out so it cannot pin a session forever", async () => {
  const dir = await runsDir({
    wedged: { runId: "wedged", sessionId: "S", state: "running", lastUpdate: NOW - DEFAULT_STALE_RUN_MS - 1 },
  });
  try {
    assert.equal(hasLiveSubagentWork("S", { dir, now: NOW }), false, "stale run must not keep the session");
    assert.equal(
      hasLiveSubagentWork("S", { dir, now: NOW, staleAfterMs: DEFAULT_STALE_RUN_MS * 4 }),
      true,
      "a wider window still sees it",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a status file with no lastUpdate is treated as stale, not as live forever", async () => {
  const dir = await runsDir({ r: { runId: "r", sessionId: "S", state: "running" } });
  try {
    assert.equal(hasLiveSubagentWork("S", { dir, now: NOW }), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("clock skew does not make a fresh run look stale", async () => {
  const dir = await runsDir({ r: { runId: "r", sessionId: "S", state: "running", lastUpdate: NOW + 60_000 } });
  try {
    assert.equal(hasLiveSubagentWork("S", { dir, now: NOW }), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("never throws on a missing dir, junk json, or a dir with no status file", async () => {
  assert.equal(hasLiveSubagentWork("S", { dir: join(tmpdir(), "pi-hub-does-not-exist-9f2a"), now: NOW }), false);
  const dir = await runsDir({
    ".active-runs": null,
    empty: null,
    junk: "{not json",
    good: { runId: "good", sessionId: "S", state: "running", lastUpdate: NOW },
  });
  try {
    assert.deepEqual(findLiveSubagentWork("S", { dir, now: NOW }).map((r) => r.runId), ["good"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an empty session id never matches", async () => {
  const dir = await runsDir({ r: { runId: "r", sessionId: "", state: "running", lastUpdate: NOW } });
  try {
    assert.equal(hasLiveSubagentWork("", { dir, now: NOW }), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("matches the session FILE PATH that status.json actually records", async () => {
  // Real shape observed on disk — pi-subagents writes the parent's session file
  // path here, not the bare id. Matching on the id alone silently found nothing.
  const path = "C:\\Users\\marcu\\.pi\\agent\\sessions\\--F--explore-upwork-gepa-prototype--\\2026-08-15T08-23-24-564Z_01a00484-c294-7d77-9932-b79a7a8bf780.jsonl";
  const dir = await runsDir({
    real: { runId: "fcf98f75", sessionId: path, state: "running", lastUpdate: NOW },
  });
  try {
    assert.equal(hasLiveSubagentWork("01a00484-c294-7d77-9932-b79a7a8bf780", { dir, now: NOW }), true);
    assert.equal(hasLiveSubagentWork("01a00484", { dir, now: NOW }), false, "a prefix must not match");
    assert.equal(hasLiveSubagentWork(path, { dir, now: NOW }), true, "the raw path still matches");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("session id extraction handles posix paths, child transcripts and junk", () => {
  assert.equal(
    sessionIdFromSessionPath("/home/x/.pi/agent/sessions/--proj--/2026-08-15T08-23-24-564Z_01a00484-c294-7d77-9932-b79a7a8bf780.jsonl"),
    "01a00484-c294-7d77-9932-b79a7a8bf780",
  );
  assert.equal(sessionIdFromSessionPath("session.jsonl"), undefined, "child transcripts carry no id");
  assert.equal(sessionIdFromSessionPath(""), undefined);
  assert.equal(sessionIdFromSessionPath(undefined), undefined);
  assert.equal(sessionIdFromSessionPath(42), undefined);
});

test("temp scope mirrors pi-subagents' resolution order", () => {
  // POSIX: uid wins over everything.
  assert.equal(resolveSubagentTempScopeId({ getuid: () => 501, env: { USERNAME: "x" } }), "uid-501");
  // Windows: no getuid, so the username env vars decide, in this order.
  assert.equal(resolveSubagentTempScopeId({ getuid: undefined, env: { USERNAME: "marcu" } }), "user-marcu");
  assert.equal(resolveSubagentTempScopeId({ getuid: undefined, env: { USER: "bob" } }), "user-bob");
  assert.equal(resolveSubagentTempScopeId({ getuid: undefined, env: { LOGNAME: "carol" } }), "user-carol");
  // Sanitised, and falls back to the home directory then to "shared".
  assert.equal(resolveSubagentTempScopeId({ getuid: undefined, env: { USERNAME: "a b/c" } }), "user-a-b-c");
  // os.userInfo() is consulted before the home directory, so it has to be
  // stubbed out to reach the home-based branch at all.
  assert.equal(
    resolveSubagentTempScopeId({
      getuid: undefined,
      env: { USERPROFILE: "C:\\Users\\x" },
      userInfo: () => ({ username: null }),
    }),
    "home-C-Users-x",
  );
  assert.equal(
    resolveSubagentTempScopeId({ getuid: undefined, env: {}, userInfo: () => ({ username: null }), homedir: () => "" }),
    "shared",
  );
});

test("the computed runs directory is the one pi-subagents actually uses", (t) => {
  // Pins the duplicated path logic against reality on this machine. Skips
  // rather than fails where pi-subagents has never run, so CI stays green.
  const dir = subagentAsyncRunsDir();
  if (!existsSync(dir)) {
    t.skip(`pi-subagents has not created ${dir} on this machine`);
    return;
  }
  assert.ok(existsSync(dir), `${dir} should exist`);
});
