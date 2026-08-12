// Guards for the process trace: the timings it shows and the one line that
// summarises it.
//
// The behaviour under test replaced a set of numbers that were measuring the
// wrong interval. Across 2,484 real tool call/result pairs the duration on a tool
// row overstated execution in every single case (median 12s shown, median 0s
// actual) because it was anchored on the start of generation rather than the end,
// charging the model's thinking time to the tool. These lock the corrected
// anchoring in place.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

// These live in lib, not in the components that render them: they are pure data
// reduction, and a component module drags a CSS import in with it that no test
// runner can load.
const { formatDuration, modelDisplayLabel, summarizeProcess } = await jiti.import("../lib/message-display.ts");

const assistant = (over = {}) => ({
  role: "assistant",
  content: [],
  model: "m1",
  provider: "p1",
  ...over,
});

test("formatDuration calls sub-second work fast, not missing", () => {
  // "0s" reads as absent data. 65% of measured tool calls land here, so the label
  // they get has to say something true and useful.
  assert.equal(formatDuration(0), "<1s");
  assert.equal(formatDuration(7), "<1s");
  assert.equal(formatDuration(999), "<1s");
});

test("formatDuration renders seconds and splits minutes", () => {
  assert.equal(formatDuration(1000), "1s");
  assert.equal(formatDuration(4200), "4s");
  assert.equal(formatDuration(59_400), "59s");
  assert.equal(formatDuration(60_000), "1m");
  assert.equal(formatDuration(112_000), "1m 52s");
  // A whole number of minutes drops the trailing "0s".
  assert.equal(formatDuration(120_000), "2m");
});

test("modelDisplayLabel prefers the provider-qualified name", () => {
  const names = { "p1:m1": "Qualified", m1: "Bare" };
  assert.equal(modelDisplayLabel({ provider: "p1", model: "m1" }, names), "Qualified");
  assert.equal(modelDisplayLabel({ provider: "other", model: "m1" }, names), "Bare");
  // No mapping at all falls back to the raw id rather than rendering nothing.
  assert.equal(modelDisplayLabel({ provider: "p1", model: "m1" }, undefined), "m1");
});

test("summarizeProcess names one model, and counts them when they differ", () => {
  const names = { "p1:m1": "Model One", "p1:m2": "Model Two" };
  const same = summarizeProcess(
    [
      { message: assistant(), countCost: true },
      { message: assistant(), countCost: true },
    ],
    new Map(),
    names,
  );
  assert.equal(same.modelLabel, "Model One");
  assert.equal(same.modelCount, 1);

  const mixed = summarizeProcess(
    [
      { message: assistant(), countCost: true },
      { message: assistant({ model: "m2" }), countCost: true },
    ],
    new Map(),
    names,
  );
  // Naming just one of two would put a false claim in the header.
  assert.equal(mixed.modelLabel, null);
  assert.equal(mixed.modelCount, 2);
});

test("summarizeProcess spans from the first step starting to the last result landing", () => {
  const toolResults = new Map([
    ["call-a", { role: "toolResult", toolCallId: "call-a", content: [], timestamp: 10_000 }],
    // Lands after the final generation ended, so it has to extend the span.
    ["call-b", { role: "toolResult", toolCallId: "call-b", content: [], timestamp: 30_000 }],
  ]);
  const summary = summarizeProcess(
    [
      {
        message: assistant({
          timestamp: 1_000,
          endedAt: 5_000,
          content: [{ type: "toolCall", toolCallId: "call-a", toolName: "bash", input: {} }],
        }),
        countCost: true,
      },
      {
        message: assistant({
          timestamp: 10_000,
          endedAt: 20_000,
          content: [{ type: "toolCall", toolCallId: "call-b", toolName: "bash", input: {} }],
        }),
        countCost: true,
      },
    ],
    toolResults,
    {},
  );
  assert.equal(summary.elapsedMs, 29_000);
  assert.equal(summary.toolCallCount, 2);
});

test("summarizeProcess reports no elapsed time when the session predates endedAt", () => {
  // Older sessions on disk have no entry timestamp carried through. A header that
  // invented a span from a single timestamp would be worse than one that omits it.
  const summary = summarizeProcess(
    [{ message: assistant({ timestamp: 1_000 }), countCost: true }],
    new Map(),
    {},
  );
  assert.equal(summary.elapsedMs, null);
});

test("summarizeProcess omits the cost it cannot attribute", () => {
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.002 } };
  const summary = summarizeProcess(
    [
      { message: assistant({ usage }), countCost: true },
      // The trailing step split off the final assistant message: its usage covers
      // the answer too, so counting it here would double-charge the turn.
      { message: assistant({ usage }), countCost: false },
    ],
    new Map(),
    {},
  );
  assert.equal(summary.costTotal, 0.002);
});

test("the reader carries the entry timestamp as endedAt", () => {
  // The message's own timestamp is when generation started; only the entry knows
  // when it ended. Without this the corrected durations have nothing to anchor on.
  const source = readFileSync(new URL("../lib/session-reader.ts", import.meta.url), "utf8");
  assert.match(source, /endedAt: parseEntryTimestamp\(entry\.timestamp\)/);
});

test("tool duration is anchored on the end of generation", () => {
  const source = readFileSync(new URL("./MessageView.tsx", import.meta.url), "utf8");
  assert.match(source, /const generationEnd = message\.endedAt \?\? message\.timestamp;/);
  // Sub-second results are kept. The previous `> 0` guard discarded them, which is
  // what silently emptied the column.
  assert.match(source, /if \(ms >= 0\) map\.set\(callId, ms\);/);
});

test("the time bar scales by multiplication so an ungrouped row shows none", () => {
  // Dividing by a defaulted total is the trap: with --trace-total-ms unset,
  // calc(100% * var(--row-ms) / var(--trace-total-ms, 1)) divides by 1 and renders
  // a full-width bar on every standalone tool row. Only a multiplier defaults to
  // zero, which is the width an unscaled bar should have.
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /width: calc\(var\(--trace-scale, 0\) \* var\(--row-ms, 0\) \* 1%\)/);
  assert.doesNotMatch(css, /var\(--trace-total-ms/);

  const chat = readFileSync(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
  assert.match(chat, /"--trace-scale": 100 \/ summary\.elapsedMs/);
  // And only when there is a total to scale against.
  assert.match(chat, /summary\.elapsedMs \? \(\{ "--trace-scale"/);
});

test("hover-only actions are not rendered while hidden", () => {
  // An opacity-0 button still donates its label to a text selection: copying a
  // transcript picked up a stray "Copy" and "Read aloud" after every message.
  const source = readFileSync(new URL("./MessageView.tsx", import.meta.url), "utf8");
  assert.match(source, /\{hovered && textContent && !isStreaming && \(/);
  assert.doesNotMatch(source, /opacity: hovered \? 1 : 0/);
});
