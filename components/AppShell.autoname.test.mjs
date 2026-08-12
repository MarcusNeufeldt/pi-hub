// Guards the auto-name (generate title) concurrency invariant.
//
// This asserts on source text, which is a weaker test than rendering. AppShell
// cannot be imported by the runner: it reaches ChatWindow → ChatMinimap →
// ChatMinimap.module.css, and the runner cannot load a CSS module. Once that
// import chain is broken these become real behavioural tests.
//
// The bug being guarded: autoNameStatus is display state for the *focused*
// session and is reset to idle whenever the selection changes, while the request
// keeps running server-side. Guarding the click on that status meant switching
// away and back re-enabled the button for a session already being titled, so a
// second generation could start — two model calls, last write winning.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

function codeOnly(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

const appShell = codeOnly(readFileSync(new URL("./AppShell.tsx", import.meta.url), "utf8"));

test("a second title request cannot start while one is in flight", () => {
  // Tracked by session id in a ref, so it survives the status reset.
  assert.match(appShell, /autoNamingIdsRef = useRef<Set<string>>\(new Set\(\)\)/);
  assert.match(appShell, /if \(!sessionId \|\| autoNamingIdsRef\.current\.has\(sessionId\)\) return;/);
  assert.match(appShell, /autoNamingIdsRef\.current\.add\(sessionId\)/);
  // The visible status must not be what gates the click.
  assert.doesNotMatch(appShell, /autoNameStatus\.kind === "naming"\) return/);
});

test("the in-flight slot is released even when the user navigated away", () => {
  // Both success and error paths return early when the session is no longer
  // focused, so the release has to be in a finally or the session is wedged for
  // the rest of the page's life.
  const handler = appShell.slice(appShell.indexOf("const handleAutoName"));
  const body = handler.slice(0, handler.indexOf("}, ["));
  assert.match(body, /finally \{[\s\S]*autoNamingIdsRef\.current\.delete\(sessionId\)/);
});

test("returning to a session that is still generating shows it as busy", () => {
  // Otherwise the button looks idle and clickable while work is running.
  assert.match(appShell, /setAutoNameStatus\(sessionId && autoNamingIdsRef\.current\.has\(sessionId\)\s*\?\s*\{ kind: "naming" \}\s*:\s*\{ kind: "idle" \}\)/);
});

test("the result is still applied to the session that asked for it", () => {
  // Pre-existing behaviour worth pinning: the id is captured before the fetch and
  // checked three times after it, so a slow title cannot land on whichever
  // session happens to be focused when it arrives.
  assert.match(appShell, /if \(activeSessionIdRef\.current !== sessionId\) return;/);
  assert.match(appShell, /current\?\.id === sessionId \? \{ \.\.\.current, name: title \} : current/);
  assert.match(appShell, /runtime\.sessionStats\?\.sessionId === sessionId/);
});

test("the sidebar refresh is not gated on still being focused", () => {
  // setRefreshKey must run before the focus guard, so a title generated after you
  // navigated away still appears in the session list.
  const handler = appShell.slice(appShell.indexOf("const handleAutoName"));
  const refreshAt = handler.indexOf("setRefreshKey((key) => key + 1)");
  const guardAt = handler.indexOf("if (activeSessionIdRef.current !== sessionId) return;");
  assert.ok(refreshAt > 0 && guardAt > 0, "expected both the refresh and the focus guard");
  assert.ok(refreshAt < guardAt, "the sidebar refresh must precede the focus guard");
});
