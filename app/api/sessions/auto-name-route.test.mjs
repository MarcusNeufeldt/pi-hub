import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./[id]/auto-name/route.ts", import.meta.url), "utf8");

test("scheduled naming can atomically skip sessions named after discovery", () => {
  assert.match(source, /searchParams\.get\("onlyUnnamed"\) === "1"/);
  assert.match(source, /inner\.sessionManager\.getSessionName\(\)/);
  assert.match(source, /onlyUnnamed && existingName/);
  assert.match(source, /skipped: "already_named"/);
});
