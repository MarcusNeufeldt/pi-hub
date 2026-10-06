import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("./ChatWindow.tsx", import.meta.url), "utf8");

test("removes the minimap while preserving the last-user scroll anchor", () => {
  assert.doesNotMatch(source, /ChatMinimap|useMessageRefs|revealHistoryForMinimap|CHAT_MINIMAP_WIDTH/);
  assert.match(source, /ref=\{idx === lastUserIdx \? lastUserMsgRef : undefined\}/);
  assert.match(source, /ref=\{scrollContainerRef\}/);
});

test("prompt anchor converges when Chrome rounds scrollHeight at fractional zoom", () => {
  const start = source.indexOf("const updatePromptAnchorSpacer = () => {");
  const end = source.indexOf("\n    updatePromptAnchorSpacer();", start);
  assert.ok(start >= 0 && end > start);
  const height = { current: 0 };
  const pending = { current: false };
  const updates = [];
  let scrolls = 0;
  // Captured in Chrome at 90% zoom: a 1px spacer change rounds to 2px
  // in scrollHeight, causing the old effect to alternate 284 -> 285 -> 284.
  const container = {
    clientHeight: 500,
    scrollTop: 0,
    getBoundingClientRect: () => ({ top: 0 }),
    get scrollHeight() {
      return height.current === 0 ? 1718 : height.current === 284 ? 2001 : 2003;
    },
  };
  const update = runInNewContext(`${source.slice(start, end)}; updatePromptAnchorSpacer`, {
    container,
    userMessage: { getBoundingClientRect: () => ({ top: 1517.3090543746948 }) },
    promptAnchorSpacerHeightRef: height,
    promptAnchorScrollPendingRef: pending,
    setPromptAnchorSpacerHeight: (value) => updates.push(value),
    scrollUserMsgToTop: () => { scrolls += 1; },
  });
  for (let i = 0; i < 60; i++) update();
  assert.deepEqual(updates, [284]);
  assert.equal(scrolls, 1);
  assert.equal(pending.current, false);
});

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

test("chat observes tool execution progress separately from transcript rendering", () => {
  assert.match(source, /<ToolExecutionProgressView progress=\{toolProgress\} \/>/);
  assert.doesNotMatch(source, /role: "assistant"[^\n]*toolProgress/);
});
