export type SplitDiffCellType = "context" | "removed" | "added" | "empty";

export interface SplitDiffCell {
  lineNo: number | null;
  text: string;
  type: SplitDiffCellType;
}

export type SplitDiffRow =
  | { type: "hunk"; text: string }
  | { type: "line"; left: SplitDiffCell; right: SplitDiffCell };

export interface SplitDiffFile {
  oldPath?: string;
  newPath?: string;
  rows: SplitDiffRow[];
}

interface PendingChangeLine {
  lineNo: number;
  text: string;
}

/** Count added/removed lines in a unified diff (excluding file headers). */
export function diffStats(text: string): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) add++;
    else if (line.startsWith("-")) del++;
  }
  return { add, del };
}

export function parseUnifiedPatch(text: string): SplitDiffFile[] | null {
  const files: SplitDiffFile[] = [];
  let current: SplitDiffFile | null = null;
  let pendingOldPath: string | undefined;
  let oldLineNo = 0;
  let newLineNo = 0;
  let removed: PendingChangeLine[] = [];
  let added: PendingChangeLine[] = [];

  const emptyCell = (): SplitDiffCell => ({ lineNo: null, text: "", type: "empty" });
  const flushChanges = () => {
    if (!current) {
      removed = [];
      added = [];
      return;
    }
    const count = Math.max(removed.length, added.length);
    for (let i = 0; i < count; i++) {
      const left = removed[i]
        ? { lineNo: removed[i].lineNo, text: removed[i].text, type: "removed" as const }
        : emptyCell();
      const right = added[i]
        ? { lineNo: added[i].lineNo, text: added[i].text, type: "added" as const }
        : emptyCell();
      current.rows.push({ type: "line", left, right });
    }
    removed = [];
    added = [];
  };

  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("--- ")) {
      flushChanges();
      pendingOldPath = cleanPatchPath(line.slice(4));
      continue;
    }

    if (line.startsWith("+++ ")) {
      flushChanges();
      current = { oldPath: pendingOldPath, newPath: cleanPatchPath(line.slice(4)), rows: [] };
      files.push(current);
      continue;
    }

    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      if (!current) {
        current = { rows: [] };
        files.push(current);
      }
      flushChanges();
      oldLineNo = Number(hunk[1]);
      newLineNo = Number(hunk[2]);
      current.rows.push({ type: "hunk", text: line });
      continue;
    }

    if (!current) continue;

    if (line.startsWith("\\ ")) {
      flushChanges();
      current.rows.push({ type: "hunk", text: line });
      continue;
    }

    const prefix = line[0];
    const content = line.slice(1);

    if (prefix === " ") {
      flushChanges();
      current.rows.push({
        type: "line",
        left: { lineNo: oldLineNo++, text: content, type: "context" },
        right: { lineNo: newLineNo++, text: content, type: "context" },
      });
    } else if (prefix === "-") {
      removed.push({ lineNo: oldLineNo++, text: content });
    } else if (prefix === "+") {
      added.push({ lineNo: newLineNo++, text: content });
    } else if (line !== "") {
      flushChanges();
      current.rows.push({ type: "hunk", text: line });
    }
  }

  flushChanges();

  const parsed = files.filter((file) => file.rows.some((row) => row.type === "line"));
  return parsed.length > 0 ? parsed : null;
}

function cleanPatchPath(path: string): string {
  return path.split("\t")[0].trim();
}

/**
 * A row to draw, after optionally dropping the unchanged context.
 *
 * Runs of context collapse into a single marker rather than vanishing: a diff that
 * silently splices distant hunks together reads as one contiguous edit, which is a
 * worse lie than showing the context was there.
 */
export type DiffDisplayRow =
  | { kind: "line"; row: Extract<SplitDiffRow, { type: "line" }>; key: string }
  | { kind: "gap"; count: number; key: string };

export function buildDisplayRows(rows: SplitDiffRow[], changedOnly: boolean): DiffDisplayRow[] {
  const out: DiffDisplayRow[] = [];
  let contextRun = 0;
  rows.forEach((row, index) => {
    if (row.type === "hunk") return;
    // "empty" is the placeholder opposite an added or removed line, so anything
    // that is not context on both sides is part of the change.
    const changed = row.left.type !== "context" || row.right.type !== "context";
    if (!changedOnly || changed) {
      if (contextRun > 0) {
        out.push({ kind: "gap", count: contextRun, key: `gap-${index}` });
        contextRun = 0;
      }
      out.push({ kind: "line", row, key: `line-${index}` });
      return;
    }
    contextRun++;
  });
  if (contextRun > 0) out.push({ kind: "gap", count: contextRun, key: "gap-end" });
  return out;
}
