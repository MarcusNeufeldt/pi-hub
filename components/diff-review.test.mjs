// Guards for the review panel's diff: the changed-lines-only filter, and the
// colours it is drawn with.
//
// Every diff colour used to be a hardcoded literal — there were no --diff tokens
// at all — so one set of values served both schemes. Measured against the dark
// surface an added row read 1.20:1 and a removed row 1.17:1, and in light the "+"
// marker read 1.94:1 against its own row, well under the 4.5:1 floor.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { buildDisplayRows } = await jiti.import("../lib/patch.ts");

const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

const cell = (type, text, lineNo = 1) => ({ type, text, lineNo });
const line = (left, right) => ({ type: "line", left, right });

test("without the filter every line row survives and no gap appears", () => {
  const rows = [
    line(cell("context", "a"), cell("context", "a")),
    line(cell("removed", "b"), cell("empty", "")),
    line(cell("context", "c"), cell("context", "c")),
  ];
  const out = buildDisplayRows(rows, false);
  assert.equal(out.length, 3);
  assert.ok(out.every((r) => r.kind === "line"));
});

test("the filter drops context and counts what it dropped", () => {
  const rows = [
    line(cell("context", "a"), cell("context", "a")),
    line(cell("context", "b"), cell("context", "b")),
    line(cell("removed", "c"), cell("added", "C")),
    line(cell("context", "d"), cell("context", "d")),
  ];
  const out = buildDisplayRows(rows, true);
  // gap(2), the changed line, gap(1)
  assert.deepEqual(out.map((r) => r.kind), ["gap", "line", "gap"]);
  assert.equal(out[0].count, 2);
  assert.equal(out[2].count, 1);
});

test("an added line opposite an empty cell counts as changed", () => {
  // Split view pairs an insertion with an "empty" placeholder, not "context".
  // Testing only for "added" on the left would drop every pure insertion.
  const rows = [line(cell("empty", ""), cell("added", "new"))];
  const out = buildDisplayRows(rows, true);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "line");
});

test("a trailing run of context still produces a gap", () => {
  const rows = [
    line(cell("added", "x"), cell("added", "x")),
    line(cell("context", "y"), cell("context", "y")),
    line(cell("context", "z"), cell("context", "z")),
  ];
  const out = buildDisplayRows(rows, true);
  assert.deepEqual(out.map((r) => r.kind), ["line", "gap"]);
  assert.equal(out[1].count, 2);
});

test("hunk rows never render, filtered or not", () => {
  const rows = [
    { type: "hunk", text: "@@ -1,2 +1,2 @@" },
    line(cell("added", "x"), cell("added", "x")),
  ];
  for (const changedOnly of [true, false]) {
    const out = buildDisplayRows(rows, changedOnly);
    assert.equal(out.length, 1, `changedOnly=${changedOnly}`);
    assert.equal(out[0].kind, "line");
  }
});

test("keys are unique so React does not reuse rows across a filter change", () => {
  const rows = [
    line(cell("context", "a"), cell("context", "a")),
    line(cell("added", "b"), cell("added", "b")),
    line(cell("context", "c"), cell("context", "c")),
    line(cell("added", "d"), cell("added", "d")),
  ];
  for (const changedOnly of [true, false]) {
    const keys = buildDisplayRows(rows, changedOnly).map((r) => r.key);
    assert.equal(new Set(keys).size, keys.length, `changedOnly=${changedOnly}`);
  }
});

test("diff colours are tokens, defined once per theme", () => {
  for (const token of ["--diff-add-bg", "--diff-del-bg", "--diff-hunk-bg", "--diff-add-fg", "--diff-del-fg"]) {
    const count = css.split(`${token}:`).length - 1;
    assert.equal(count, 2, `${token} should be defined in both the light and dark blocks`);
  }
});

/**
 * Comments are stripped before scanning for old colour values.
 *
 * The comments deliberately quote the literals they replaced, along with what those
 * measured — that is the evidence for the change and worth keeping in the file. A
 * guard that reads prose as code would force the documentation out to stay green.
 */
function codeOnly(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

test("no diff colour literal survives in either renderer", () => {
  // The exact values that were baked in before, plus the blue hunk wash that
  // matched no token in either palette.
  const literals = ["22,197,94", "248,113,113", "96,165,250", "#22c55e", "#f87171", "#16a34a", "#ef4444"];
  const perTurn = codeOnly(readFileSync(new URL("./PerTurnDiffView.tsx", import.meta.url), "utf8"));
  for (const lit of literals) {
    assert.ok(!perTurn.includes(lit), `PerTurnDiffView still contains ${lit}`);
  }
  // MessageView still holds some of these for error states, which are not diff
  // colours — so this checks the diff renderers specifically.
  const messageView = readFileSync(new URL("./MessageView.tsx", import.meta.url), "utf8");
  const splitCell = messageView.slice(messageView.indexOf("function SplitDiffCellView"));
  const diffRenderers = codeOnly(splitCell.slice(0, splitCell.indexOf("function getResultDiff")));
  for (const lit of literals) {
    assert.ok(!diffRenderers.includes(lit), `the diff renderers still contain ${lit}`);
  }
});

test("the marker colour is not the same token as the wash it sits on", () => {
  // --danger over the strengthened removed wash measured 3.90:1. A marker drawn in
  // the same hue as its own background is inherently low contrast, which is why
  // --diff-*-fg exists separately from --success/--danger.
  const messageView = readFileSync(new URL("./MessageView.tsx", import.meta.url), "utf8");
  assert.match(messageView, /cell\.type === "added" \? "var\(--diff-add-fg\)"/);
  assert.match(messageView, /cell\.type === "removed" \? "var\(--diff-del-fg\)"/);
});
