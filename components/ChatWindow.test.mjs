import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./ChatWindow.tsx", import.meta.url), "utf8");

test("forwards subagent timeline and result revisions to the right panel", () => {
  const start = source.indexOf("const subagentsSigRef");
  const end = source.indexOf("// Clear fleet", start);
  const block = source.slice(start, end);

  assert.match(block, /c\.timelineCursor \?\? 0/);
  assert.match(block, /c\.events\?\.length \?\? 0/);
  assert.match(block, /c\.finalOutput\?\.length \?\? 0/);
  assert.match(block, /c\.currentTool \?\? ""/);
  assert.match(block, /onSubagentsChange\?\.\(subagents\)/);
});
