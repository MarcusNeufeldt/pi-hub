import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const launcher = await readFile(new URL("./pi-hub-hidden.vbs", import.meta.url), "utf8");
const server = await readFile(new URL("./pi-hub-server.ps1", import.meta.url), "utf8");

test("scheduled Pi Hub processes launch without a visible terminal", () => {
  assert.match(launcher, /shell\.Run\(command, 0, True\)/);
  assert.match(launcher, /Case "watchdog"/);
  assert.match(launcher, /Case "server"/);
});

test("the hidden server launcher keeps the filesystem retry cap", () => {
  assert.match(server, /PI_SUBAGENT_FS_RETRY_MAX_TOTAL_MS = "0"/);
  assert.match(server, /next\\dist\\bin\\next/);
  assert.match(server, /-p 30141/);
});
