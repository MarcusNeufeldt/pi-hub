import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const sessionItemSource = source.slice(source.indexOf("function SessionItem("));

test("session deletion always goes through confirmation", () => {
  // Previously the only bypass was Shift+click on the hover delete button. The
  // context menu replaced that button, so there is now no bypass at all — a
  // strictly stronger version of the same guarantee: deletion is never one
  // careless click.
  assert.doesNotMatch(sessionItemSource, /shiftKey/);
  assert.match(sessionItemSource, /setConfirmDelete\(true\)/);
  // performDelete must be reachable only from the explicit confirm button.
  const callSites = sessionItemSource.match(/void performDelete\(\)/g) ?? [];
  assert.equal(callSites.length, 1, "performDelete should have exactly one call site");
  assert.match(sessionItemSource, /const handleDeleteConfirm[\s\S]{0,140}void performDelete\(\)/);
});

test("does not register row-level session deletion shortcuts", () => {
  assert.doesNotMatch(sessionItemSource, /const handleKeyDown/);
  assert.doesNotMatch(sessionItemSource, /onKeyDown=\{handleKeyDown\}/);
  assert.doesNotMatch(sessionItemSource, /tabIndex=\{0\}/);
});

test("filters worker and task-run sessions without breaking direct transcript restore", () => {
  assert.match(source, /allSessions\.filter\(isSidebarConversationSession\)/);
  assert.match(source, /const recentProjects = getRecentProjects\(sidebarSessions\)/);
  assert.match(source, /const recentSessions = \[\.\.\.sidebarSessions\]/);
  assert.match(source, /const target = allSessions\.find\(\(s\) => s\.id === initialSessionId\)/);
});

test("polls running sessions only while the tab is visible", () => {
  assert.doesNotMatch(source, /new EventSource\("\/api\/agent\/running\/events"\)/);
  assert.match(source, /fetch\("\/api\/agent\/running"/);
  assert.match(source, /document\.visibilityState !== "visible"/);
  assert.match(source, /document\.addEventListener\("visibilitychange", onVisibilityChange\)/);
});
