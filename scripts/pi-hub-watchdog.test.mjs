import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Pi Hub watchdog requires two failures and validates the port owner", async () => {
  const source = await readFile(new URL("./pi-hub-watchdog.ps1", import.meta.url), "utf8");

  const firstProbe = source.indexOf("if (Test-PiHubHealth)");
  const retryDelay = source.indexOf("Start-Sleep -Seconds 10", firstProbe);
  const secondProbe = source.indexOf("if (Test-PiHubHealth)", retryDelay);
  const restart = source.indexOf("Stop-ScheduledTask", secondProbe);
  assert.ok(firstProbe >= 0 && firstProbe < retryDelay);
  assert.ok(retryDelay < secondProbe && secondProbe < restart);
  assert.match(source, /CommandLine -notmatch "pi-hub"/);
  assert.match(source, /CommandLine -notmatch "next"/);
  assert.match(source, /taskkill\.exe \/PID \$listener\.OwningProcess \/T \/F/);
});

test("Pi Hub watchdog serializes overlapping scheduled invocations", async () => {
  const source = await readFile(new URL("./pi-hub-watchdog.ps1", import.meta.url), "utf8");

  assert.match(source, /Local\\PiHubWatchdog/);
  assert.match(source, /\.WaitOne\(0\)/);
  assert.match(source, /\.ReleaseMutex\(\)/);
});
