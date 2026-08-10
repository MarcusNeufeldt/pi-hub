/**
 * Layout tree for the split chat area.
 *
 * A leaf is one pane. A split arranges children along an axis. The shape is a
 * tree rather than a flat list so a column can itself be split into rows, which
 * is what "3 each" needs: a row of up to 3 columns, each divisible into up to 3
 * rows, for at most 9 panes.
 *
 * Two caps keep the layout legible and keep the tree from growing shapes the UI
 * cannot render sensibly:
 *   - at most `MAX_CHILDREN_PER_SPLIT` children in any one split, and
 *   - at most `MAX_SPLIT_DEPTH` levels of nesting.
 *
 * Without the depth cap, splitting a column repeatedly along the same axis would
 * nest row-inside-row, which looks identical to a 4-way split and quietly defeats
 * the per-split cap.
 *
 * Every function here is pure and returns a new tree, so layout changes are plain
 * state updates and are straightforward to test.
 */

export type SplitAxis = "row" | "column";

export type PaneNode =
  | { kind: "leaf"; paneId: string }
  | { kind: "split"; axis: SplitAxis; children: PaneNode[] };

/** A row of 3 columns, or a column of 3 rows. */
export const MAX_CHILDREN_PER_SPLIT = 3;
/** Levels of splits: one to divide the area, one to divide a division. */
export const MAX_SPLIT_DEPTH = 2;
/** Ceiling implied by the two caps above. */
export const MAX_PANES = MAX_CHILDREN_PER_SPLIT ** MAX_SPLIT_DEPTH;

export function leaf(paneId: string): PaneNode {
  return { kind: "leaf", paneId };
}

/** Pane ids in visual order, left-to-right then top-to-bottom. */
export function collectPaneIds(node: PaneNode): string[] {
  if (node.kind === "leaf") return [node.paneId];
  return node.children.flatMap(collectPaneIds);
}

export function countPanes(node: PaneNode): number {
  return collectPaneIds(node).length;
}

/**
 * Split the pane `targetPaneId` along `axis`, placing `newPaneId` after it.
 *
 * When the target already sits in a split of the same axis it becomes a sibling
 * there, so splitting a row twice yields three columns rather than a nested pair.
 * Otherwise the target is wrapped in a new split.
 *
 * Returns null when the split is not allowed — a full parent, the depth cap, or
 * an unknown pane id — so callers can disable the affordance rather than guess.
 */
export function splitPane(
  root: PaneNode,
  targetPaneId: string,
  axis: SplitAxis,
  newPaneId: string,
): PaneNode | null {
  let changed = false;

  const visit = (node: PaneNode, depth: number): PaneNode => {
    if (node.kind === "leaf") {
      if (node.paneId !== targetPaneId) return node;
      // Wrapping this leaf adds a split level at `depth`, so the tree would end
      // up `depth + 1` deep.
      if (depth + 1 > MAX_SPLIT_DEPTH) return node;
      changed = true;
      return { kind: "split", axis, children: [leaf(targetPaneId), leaf(newPaneId)] };
    }

    if (node.axis === axis) {
      const index = node.children.findIndex(
        (child) => child.kind === "leaf" && child.paneId === targetPaneId,
      );
      if (index !== -1) {
        if (node.children.length >= MAX_CHILDREN_PER_SPLIT) return node;
        changed = true;
        const children = [...node.children];
        children.splice(index + 1, 0, leaf(newPaneId));
        return { ...node, children };
      }
    }

    return { ...node, children: node.children.map((child) => visit(child, depth + 1)) };
  };

  const next = visit(root, 0);
  return changed ? next : null;
}

/** Whether `splitPane` would succeed, for enabling or disabling the control. */
export function canSplitPane(root: PaneNode, targetPaneId: string, axis: SplitAxis): boolean {
  return splitPane(root, targetPaneId, axis, "__probe__") !== null;
}

/**
 * Remove a pane. A split left holding a single child is replaced by that child,
 * so closing panes unwinds the tree instead of leaving one-child splits behind.
 *
 * Returns null when the id is absent or is the last remaining pane — the chat
 * area always has at least one.
 */
export function removePane(root: PaneNode, paneId: string): PaneNode | null {
  if (root.kind === "leaf") return null;

  let changed = false;

  const visit = (node: PaneNode): PaneNode | null => {
    if (node.kind === "leaf") {
      if (node.paneId !== paneId) return node;
      changed = true;
      return null;
    }
    const children: PaneNode[] = [];
    for (const child of node.children) {
      const next = visit(child);
      if (next !== null) children.push(next);
    }
    if (children.length === 0) return null;
    if (children.length === 1) return children[0];
    return { ...node, children };
  };

  const next = visit(root);
  if (!changed || next === null) return null;
  return next;
}

/**
 * The pane to focus after `paneId` closes: its next visual sibling, or the
 * previous one when it was last.
 */
export function paneAfterRemoval(root: PaneNode, paneId: string): string | null {
  const ids = collectPaneIds(root);
  const index = ids.indexOf(paneId);
  if (index === -1 || ids.length < 2) return null;
  return ids[index + 1] ?? ids[index - 1] ?? null;
}
