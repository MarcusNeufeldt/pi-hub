import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./SubagentPanel.tsx", import.meta.url), "utf8");

test("renders assistant narration as full wrapping text", () => {
  const start = source.indexOf("function ActivityEventRow");
  const end = source.indexOf("function ChildCard", start);
  const row = source.slice(start, end);

  assert.match(row, /event\.kind === "assistant"/);
  assert.match(row, /whiteSpace: "pre-wrap"/);
  assert.match(row, /overflowWrap: "anywhere"/);
  assert.doesNotMatch(row, /event\.kind === "assistant" \? event\.detail : event\.title/);
});
