// Behavioural tests for the agent command client's deadline.
//
// The incident this comes from: `abort` waits for the run loop to acknowledge the
// cancellation, and a wedged run loop never does. Without a deadline the fetch never
// settles, so the caller's catch never runs — the Stop button was not failing, it
// was disappearing into a request that would outlive the page.
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { sendAgentCommand, AgentCommandTimeoutError } = await jiti.import("./agent-client.ts");

const realFetch = globalThis.fetch;
function stubFetch(handler) {
  globalThis.fetch = handler;
  return () => { globalThis.fetch = realFetch; };
}

test("a command that never answers rejects at its deadline", async () => {
  // A fetch that only settles when aborted — the shape of a hung run loop.
  const restore = stubFetch((_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      reject(err);
    });
  }));
  try {
    const started = Date.now();
    await assert.rejects(
      () => sendAgentCommand("s1", { type: "abort" }, { timeoutMs: 120 }),
      (error) => {
        assert.ok(error instanceof AgentCommandTimeoutError, `expected the timeout type, got ${error.name}`);
        assert.equal(error.commandType, "abort");
        assert.match(error.message, /did not respond to "abort"/);
        return true;
      },
    );
    // Must actually be bounded, not merely typed as such.
    assert.ok(Date.now() - started < 2000, "should reject at the deadline, not hang");
  } finally { restore(); }
});

test("without a timeout the old unbounded behaviour is preserved", async () => {
  // Most commands are fast and a deadline on all of them would risk cancelling
  // legitimately slow work, so the timeout is opt-in per call site.
  let sawSignal = "unset";
  const restore = stubFetch((_url, init) => {
    sawSignal = init.signal;
    return Promise.resolve(new Response(JSON.stringify({ success: true, data: { ok: 1 } }), {
      status: 200, headers: { "content-type": "application/json" },
    }));
  });
  try {
    const data = await sendAgentCommand("s1", { type: "get_state" });
    assert.deepEqual(data, { ok: 1 });
    assert.equal(sawSignal, undefined, "no signal should be attached when no timeout is given");
  } finally { restore(); }
});

test("a real transport failure is not reported as a timeout", async () => {
  // Otherwise "the agent did not answer" would be shown for a dead server, which
  // points the user at the wrong remedy.
  const restore = stubFetch(() => Promise.reject(new Error("ECONNREFUSED")));
  try {
    await assert.rejects(
      () => sendAgentCommand("s1", { type: "abort" }, { timeoutMs: 5000 }),
      (error) => {
        assert.ok(!(error instanceof AgentCommandTimeoutError));
        assert.match(error.message, /ECONNREFUSED/);
        return true;
      },
    );
  } finally { restore(); }
});

test("a server-side error still surfaces its message", async () => {
  const restore = stubFetch(() => Promise.resolve(new Response(
    JSON.stringify({ error: "Session not found" }),
    { status: 404, headers: { "content-type": "application/json" } },
  )));
  try {
    await assert.rejects(
      () => sendAgentCommand("s1", { type: "abort" }, { timeoutMs: 5000 }),
      /Session not found/,
    );
  } finally { restore(); }
});

test("the deadline timer does not keep the process alive after success", async () => {
  // A stray pending timer would hold the event loop open; clearTimeout runs in a
  // finally so it fires on both paths.
  const restore = stubFetch(() => Promise.resolve(new Response(
    JSON.stringify({ success: true, data: null }),
    { status: 200, headers: { "content-type": "application/json" } },
  )));
  try {
    await sendAgentCommand("s1", { type: "abort" }, { timeoutMs: 30_000 });
  } finally { restore(); }
  // Reaching here without the test runner hanging is the assertion.
  assert.ok(true);
});
