import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  canSplitPane,
  collectPaneIds,
  countPanes,
  leaf,
  MAX_PANES,
  paneAfterRemoval,
  removePane,
  splitPane,
} from "./pane-layout.ts";

/** Split repeatedly, naming panes p2, p3, ... so shapes are readable in failures. */
function splitAll(root, targets, axis, startAt) {
  let next = root;
  let n = startAt;
  for (const target of targets) {
    const result = splitPane(next, target, axis, `p${n}`);
    assert.ok(result, `expected split of ${target} on ${axis} to succeed`);
    next = result;
    n += 1;
  }
  return next;
}

describe("splitPane", () => {
  it("turns a single pane into a two-column split", () => {
    const root = splitPane(leaf("p1"), "p1", "row", "p2");
    assert.deepEqual(root, {
      kind: "split",
      axis: "row",
      children: [leaf("p1"), leaf("p2")],
    });
  });

  it("adds a sibling instead of nesting when the axis already matches", () => {
    // Splitting a row twice must give three columns, not a column containing a pair.
    const root = splitAll(leaf("p1"), ["p1", "p1"], "row", 2);
    assert.equal(root.kind, "split");
    assert.equal(root.children.length, 3);
    assert.ok(root.children.every((child) => child.kind === "leaf"));
    assert.deepEqual(collectPaneIds(root), ["p1", "p3", "p2"]);
  });

  it("inserts the new pane immediately after its source", () => {
    const row = splitPane(leaf("a"), "a", "row", "b");
    // Splitting the left pane puts the newcomer between a and b, not at the end.
    const grown = splitPane(row, "a", "row", "c");
    assert.deepEqual(collectPaneIds(grown), ["a", "c", "b"]);
  });

  it("nests when the requested axis differs from the parent", () => {
    const row = splitPane(leaf("p1"), "p1", "row", "p2");
    const nested = splitPane(row, "p2", "column", "p3");
    assert.ok(nested);
    assert.equal(nested.children[1].kind, "split");
    assert.equal(nested.children[1].axis, "column");
    assert.deepEqual(collectPaneIds(nested), ["p1", "p2", "p3"]);
  });

  it("refuses a fourth child in one split", () => {
    const three = splitAll(leaf("p1"), ["p1", "p1"], "row", 2);
    assert.equal(countPanes(three), 3);
    assert.equal(splitPane(three, "p1", "row", "p4"), null);
    assert.equal(canSplitPane(three, "p1", "row"), false);
    // The other axis is still available on the same pane.
    assert.equal(canSplitPane(three, "p1", "column"), true);
  });

  it("refuses to nest past the depth cap", () => {
    const row = splitPane(leaf("p1"), "p1", "row", "p2");
    const nested = splitPane(row, "p1", "column", "p3");
    // p1 now sits two levels deep; splitting it on the third axis level is out.
    assert.equal(splitPane(nested, "p1", "row", "p4"), null);
    assert.equal(canSplitPane(nested, "p1", "row"), false);
    // ...but growing the existing column to three rows is fine.
    assert.ok(splitPane(nested, "p1", "column", "p4"));
  });

  it("reaches exactly the advertised ceiling and no further", () => {
    let root = splitAll(leaf("c1"), ["c1", "c1"], "row", 2); // 3 columns
    const columns = collectPaneIds(root);
    let n = 10;
    for (const column of columns) {
      root = splitAll(root, [column, column], "column", n); // 3 rows each
      n += 2;
    }
    assert.equal(countPanes(root), MAX_PANES);
    assert.equal(countPanes(root), 9);
    for (const id of collectPaneIds(root)) {
      assert.equal(canSplitPane(root, id, "row"), false, `${id} should be capped`);
      assert.equal(canSplitPane(root, id, "column"), false, `${id} should be capped`);
    }
  });

  it("returns null for an unknown pane rather than mutating the tree", () => {
    const row = splitPane(leaf("p1"), "p1", "row", "p2");
    assert.equal(splitPane(row, "nope", "row", "p3"), null);
  });
});

describe("removePane", () => {
  it("collapses a split back to a single pane", () => {
    const row = splitPane(leaf("p1"), "p1", "row", "p2");
    assert.deepEqual(removePane(row, "p2"), leaf("p1"));
  });

  it("keeps the remaining siblings when a split had three", () => {
    const three = splitAll(leaf("p1"), ["p1", "p1"], "row", 2);
    const left = removePane(three, "p1");
    assert.equal(left.kind, "split");
    assert.equal(left.children.length, 2);
    assert.equal(left.children.some((c) => c.kind === "leaf" && c.paneId === "p1"), false);
  });

  it("unwinds a nested split rather than leaving a one-child split", () => {
    const row = splitPane(leaf("p1"), "p1", "row", "p2");
    const nested = splitPane(row, "p2", "column", "p3");
    const back = removePane(nested, "p3");
    assert.deepEqual(back, { kind: "split", axis: "row", children: [leaf("p1"), leaf("p2")] });
  });

  it("refuses to remove the last pane", () => {
    assert.equal(removePane(leaf("only"), "only"), null);
  });

  it("returns null for an unknown pane", () => {
    const row = splitPane(leaf("p1"), "p1", "row", "p2");
    assert.equal(removePane(row, "ghost"), null);
  });
});

describe("paneAfterRemoval", () => {
  it("prefers the next pane, and falls back to the previous for the last one", () => {
    const three = splitAll(leaf("a"), ["a", "a"], "row", 2);
    const order = collectPaneIds(three);
    assert.equal(paneAfterRemoval(three, order[0]), order[1]);
    assert.equal(paneAfterRemoval(three, order[2]), order[1]);
  });

  it("has no answer when only one pane exists", () => {
    assert.equal(paneAfterRemoval(leaf("only"), "only"), null);
  });
});
