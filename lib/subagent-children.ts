import type { SubagentTimelineEvent } from "./subagent-run-view.ts";

/**
 * Child identity for the subagent panel.
 *
 * Kept out of hooks/useAgentSession.ts on purpose: that module imports React and
 * `@/` aliases, so it cannot be loaded by the plain-node test runner, and this
 * logic previously had no reachable test at all.
 */
export interface SubagentChild {
  /**
   * Stable identity within its delegation — the child's position, assigned at
   * construction and carried through every merge.
   *
   * The agent name is NOT an identity: a fanout of the common shape
   * `{ agent: "scout", tasks: [a, b, c] }` names all three children "scout".
   * Matching on the name collapsed them onto one card, so children 2..N never
   * received status or output and React saw duplicate keys.
   */
  id: string;
  agent: string;
  task?: string;
  status: string; // "running" | "completed" | "failed" | "timed_out" | ...
  currentTool?: string;
  currentToolArgs?: string;
  recentOutput?: string;
  recentOutputLines?: string[];
  recentTools?: Array<{ tool: string; args?: string }>;
  thinking?: string;
  toolCount?: number;
  turnCount?: number;
  tokens?: number;
  model?: string;
  durationMs?: number;
  exitCode?: number;
  activityState?: string;
  events?: SubagentTimelineEvent[];
  finalOutput?: string;
  outputPath?: string;
  /** Authoritative child artifact transcript used after foreground runs/reload. */
  transcriptPath?: string;
  sessionFile?: string;
  timelineSource?: string;
  timelineCursor?: number;
  timelineComplete?: boolean;
  timelineCompletePolls?: number;
}

/**
 * pi-subagents labels a fanout child with the workflow script when no task text
 * is given. Strip the script and, when the label IS the script, pull out the
 * quoted task.
 */
export function cleanTaskLabel(task: string | undefined): string | undefined {
  if (!task) return undefined;
  const trimmed = task.trim();
  // Test the script-only case FIRST. The strip below removes `return runs.run…`
  // through end-of-string, so running it first reduced a script-only label to
  // "" and the extraction below could never match — workflow children showed no
  // task at all, contrary to this function's own contract.
  if (/^return\s+runs\.run\b/.test(trimmed)) {
    const quoted = trimmed.match(/task:\s*["']([^"']+)["']/);
    return quoted ? quoted[1].trim() : undefined;
  }
  return trimmed.replace(/\n?return\s+runs\.run\b[\s\S]*$/, "").trim() || undefined;
}

/**
 * Maps pi-subagents `subagent` tool args to panel children, mirroring the
 * extension's execution modes:
 * - single:    { agent, task }
 * - fanout:    { tasks: [{ agent?, task?, label? }] } or { agents: [...] }
 * - workflow:  { workflowScript, agent? } (children arrive via progress snapshots)
 * Management calls ({ action: ... }) are NOT delegations — callers skip them.
 */
export function buildSubagentChildren(args: Record<string, unknown> | undefined): SubagentChild[] {
  if (!args) return [];
  const children: SubagentChild[] = [];
  if (Array.isArray(args.tasks)) {
    args.tasks.forEach((t, i) => {
      const item = (t ?? {}) as Record<string, unknown>;
      const agent =
        typeof item.agent === "string"
          ? item.agent
          : typeof args.agent === "string"
            ? args.agent
            : `task ${i + 1}`;
      const task =
        typeof item.task === "string"
          ? cleanTaskLabel(item.task)
          : typeof item.label === "string"
            ? item.label
            : undefined;
      children.push({ id: String(children.length), agent, task, status: "running" });
    });
    return children;
  }
  if (Array.isArray(args.agents)) {
    args.agents.forEach((a, i) => {
      const item = (a ?? {}) as Record<string, unknown>;
      const agent =
        typeof item === "string" ? item : typeof item.agent === "string" ? item.agent : `agent ${i + 1}`;
      children.push({
        id: String(children.length),
        agent,
        task: cleanTaskLabel(typeof item.task === "string" ? item.task : undefined),
        status: "running",
      });
    });
    return children;
  }
  const agent = typeof args.agent === "string" ? args.agent : undefined;
  const task = cleanTaskLabel(
    typeof args.task === "string"
      ? args.task
      : typeof args.workflowScript === "string"
        ? args.workflowScript
        : undefined,
  );
  if (agent || task || typeof args.workflowScript === "string") {
    children.push({
      id: String(children.length),
      agent: agent ?? (typeof args.workflowScript === "string" ? "workflow" : "subagent"),
      task,
      status: "running",
    });
  }
  return children;
}

/**
 * Matches server result/progress rows to the local children they belong to.
 *
 * The rows arrive as an ordered array, so position is the reliable link, but
 * the previous `find(c => c.agent === agent)` mapped every row of a repeated
 * agent onto the first child of that name. Claiming each child at most once
 * keeps the old name-first behaviour when names are unique and distributes
 * correctly when they repeat.
 */
export function createChildClaimer(
  children: SubagentChild[],
): (agent: string | undefined, index: number) => SubagentChild | undefined {
  const claimed = new Set<number>();
  return (agent, index) => {
    if (agent !== undefined) {
      const byName = children.findIndex((child, i) => !claimed.has(i) && child.agent === agent);
      if (byName >= 0) {
        claimed.add(byName);
        return children[byName];
      }
    }
    if (index >= 0 && index < children.length && !claimed.has(index)) {
      claimed.add(index);
      return children[index];
    }
    return undefined;
  };
}
