import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sidebarTasks = readFileSync(new URL("./SidebarTasks.tsx", import.meta.url), "utf8");
const sessionSidebar = readFileSync(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const tasksConfig = readFileSync(new URL("./TasksConfig.tsx", import.meta.url), "utf8");
const appShell = readFileSync(new URL("./AppShell.tsx", import.meta.url), "utf8");

test("replaces the sidebar file explorer with global tasks", () => {
  assert.match(sessionSidebar, /<SidebarTasks[\s\S]*onOpenTasks=\{onOpenTasks\}[\s\S]*onOpenSession=\{onOpenTaskRunSession\}/);
  assert.doesNotMatch(sessionSidebar, /FileExplorer/);
  assert.doesNotMatch(sessionSidebar, /files\.explorer/);
});

test("loads global tasks and recent runs while visible", () => {
  assert.match(sidebarTasks, /listTasks\(\)/);
  assert.match(sidebarTasks, /listRecentRuns\(5\)/);
  assert.match(sidebarTasks, /runResult\.items\.filter\(\(run\) => Boolean\(run\.sessionId\)\)/);
  assert.match(sidebarTasks, /const TASKS_POLL_MS = 15_000/);
  assert.match(sidebarTasks, /document\.visibilityState === "visible"/);
  assert.match(sidebarTasks, /document\.addEventListener\("visibilitychange"/);
});

test("opens the selected task in the existing global Tasks manager", () => {
  assert.match(sidebarTasks, /onOpen=\{\(\) => onOpenTasks\(task\.id\)\}/);
  assert.match(appShell, /initialTaskId=\{tasksConfigTargetId\}/);
  assert.match(tasksConfig, /tasks\.find\(\(task\) => task\.id === initialTaskId\)/);
});

test("recent task runs open their linked Pi session transcript", () => {
  assert.match(sidebarTasks, /task\.runs\.recent/);
  assert.match(sidebarTasks, /onOpenSession\(run\.sessionId\)/);
  assert.match(appShell, /onOpenTaskRunSession=\{handleOpenTranscript\}/);
  assert.match(appShell, /suppressCwdBumpRef\.current = true;\s*handleSelectSession\(info\)/);
});

test("task mutations immediately refresh the sidebar list", () => {
  assert.match(tasksConfig, /onTasksChanged\?\.\(\)/);
  assert.match(appShell, /onTasksChanged=\{\(\) => setTasksRefreshKey/);
});
