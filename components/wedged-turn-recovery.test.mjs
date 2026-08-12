// Guards the recovery path for a wedged turn.
//
// See docs/pi-hub/incident-2026-08-12-wedged-turn.md. A turn stopped progressing on
// an unanswered MCP call; Stop hung forever because abort waits for the run loop to
// acknowledge cancellation, and the only remedy left was restarting the whole
// server, which drops every other session with it.
//
// Source assertions, because AppShell/ChatWindow cannot be imported by the runner
// (they reach ChatMinimap's CSS module). The timeout itself has real behavioural
// coverage in lib/agent-client.test.mjs.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

function codeOnly(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}
const read = (rel) => codeOnly(readFileSync(new URL(rel, import.meta.url), "utf8"));

const rpcManager = read("../lib/rpc-manager.ts");
const resetRoute = read("../app/api/sessions/[id]/reset/route.ts");
const session = read("../hooks/useAgentSession.ts");
const chatInput = read("./ChatInput.tsx");
const messageView = read("./MessageView.tsx");

test("force reset destroys the session without asking it to cooperate", () => {
  // shutdown() awaits waitForExtensionsBound() and emits a session_shutdown
  // extension event first. Both can block on the very turn being reset, which is
  // exactly when this is needed — so it must be destroy(), which is synchronous.
  assert.match(rpcManager, /export function destroyRpcSession\(sessionId: string\): boolean/);
  const fn = rpcManager.slice(rpcManager.indexOf("export function destroyRpcSession"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.match(body, /session\.destroy\(\)/);
  assert.doesNotMatch(body, /shutdown\(\)/, "force reset must not wait on a graceful shutdown");
});

test("the reset route exists and reports whether anything was live", () => {
  assert.match(resetRoute, /export async function POST/);
  assert.match(resetRoute, /destroyRpcSession\(id\)/);
  // A session with nothing live is not an error: the caller's goal already holds.
  assert.match(resetRoute, /no_live_session/);
});

test("abort carries a deadline and reports failure to the user", () => {
  assert.match(session, /const ABORT_TIMEOUT_MS = /);
  assert.match(session, /\{ type: "abort" \}, \{ timeoutMs: ABORT_TIMEOUT_MS \}/);
  assert.match(session, /\{ type: "abort_bash" \}, \{ timeoutMs: ABORT_TIMEOUT_MS \}/);
  // console.error alone was the original defect: the failure existed but was invisible.
  const fn = session.slice(session.indexOf("const handleAbort = useCallback"));
  const body = fn.slice(0, fn.indexOf("}, [addNotice]);"));
  assert.match(body, /addNotice\(/);
  assert.match(body, /AgentCommandTimeoutError/);
});

test("a timed-out abort points at the remedy", () => {
  // Otherwise the user is left to discover that restarting the server is the only
  // way out, which is what made the incident 90 minutes long.
  assert.match(session, /Force reset/);
});

test("Stop has a pending state and cannot be double-fired", () => {
  assert.match(session, /const \[aborting, setAborting\] = useState\(false\)/);
  assert.match(chatInput, /disabled=\{aborting\}/);
  assert.match(chatInput, /aborting \? t\("chat\.stopping"\) : t\("chat\.stop"\)/);
});

test("a running tool row shows live elapsed time", () => {
  // The duration column only rendered once a result arrived, so a call hanging for
  // ninety minutes looked identical to one that had just started.
  assert.match(messageView, /function LiveDuration\(\{ startedAt \}/);
  assert.match(messageView, /isRunning && startedAt !== undefined/);
  // Anchored on generation end, which is when tools actually began.
  assert.match(messageView, /toolsStartedAt=\{message\.endedAt \?\? message\.timestamp\}/);
  assert.match(messageView, /const TOOL_SLOW_AFTER_MS = /);
});

test("the new strings exist in both locales", () => {
  for (const file of ["en.ts", "zh-CN.ts"]) {
    const messages = readFileSync(new URL(`../lib/i18n/messages/${file}`, import.meta.url), "utf8");
    for (const key of ["chat.stopping", "chat.forceReset", "chat.forceResetHint"]) {
      assert.equal(messages.split(`"${key}"`).length - 1, 1, `${file} needs exactly one ${key}`);
    }
  }
});
