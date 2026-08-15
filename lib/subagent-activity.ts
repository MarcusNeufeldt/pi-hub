import { readdirSync, readFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";

/**
 * Detects whether a session still has detached pi-subagents work running.
 *
 * Why pi-hub needs this: the idle reaper in lib/rpc-manager.ts shuts a session
 * down after 10 minutes of quiet, and `isRunning()` only covers the parent's own
 * activity (prompt, stream, compaction, bash). A detached subagent is none of
 * those, so a parent that launches a background run and hands control back gets
 * reaped while its children keep going — they are children of the hub server
 * process, not of the session. Disposing the session also disposes the
 * pi-subagents extension, taking down the reconcile loop that would have
 * delivered the completion wake. The run then finishes into a void: no ping,
 * ever.
 *
 * Keyed off the run files rather than event traffic on purpose — a long, quiet
 * workflow emits almost nothing to the parent, so "have we heard anything
 * lately" is exactly the wrong signal.
 */

/** Non-terminal states from pi-subagents' AsyncStatus union. */
const LIVE_RUN_STATES = new Set(["queued", "running", "paused"]);

/**
 * A run whose status file has not been touched in this long no longer keeps a
 * session alive. Without it, one wedged run would pin a session in memory for
 * as long as the server lives. Live runs rewrite status.json continuously
 * (activity state, tool, turn counts), so a healthy long run stays well inside
 * this window while a dead one ages out.
 */
export const DEFAULT_STALE_RUN_MS = 30 * 60 * 1000;

function sanitizeTempScopeSegment(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "unknown";
}

/**
 * Mirrors pi-subagents' `resolveTempScopeId` (src/shared/types.ts). pi-subagents
 * lives in ~/.pi/agent/npm/node_modules and is not importable from this app, so
 * the resolution order is duplicated here and pinned by a test that asserts the
 * computed directory matches the one pi-subagents actually writes to.
 */
export function resolveSubagentTempScopeId(
  options: {
    env?: NodeJS.ProcessEnv;
    getuid?: (() => number) | undefined;
    userInfo?: () => { username?: string | null };
    homedir?: () => string;
  } = {},
): string {
  const env = options.env ?? process.env;
  const getuid = Object.hasOwn(options, "getuid") ? options.getuid : process.getuid?.bind(process);
  if (typeof getuid === "function") return `uid-${getuid()}`;

  for (const key of ["USERNAME", "USER", "LOGNAME"] as const) {
    const value = env[key];
    if (value) return `user-${sanitizeTempScopeSegment(value)}`;
  }

  try {
    const username = (options.userInfo ?? userInfo)().username;
    if (username) return `user-${sanitizeTempScopeSegment(username)}`;
  } catch {
    // Fall through to home-directory-based scoping.
  }

  const home = env.USERPROFILE ?? env.HOME;
  if (home) return `home-${sanitizeTempScopeSegment(home)}`;

  try {
    const fallbackHome = (options.homedir ?? homedir)();
    if (fallbackHome) return `home-${sanitizeTempScopeSegment(fallbackHome)}`;
  } catch {
    // Fall through to the last-resort shared scope.
  }

  return "shared";
}

export function subagentAsyncRunsDir(env?: NodeJS.ProcessEnv): string {
  return join(tmpdir(), `pi-subagents-${resolveSubagentTempScopeId({ env })}`, "async-subagent-runs");
}

/**
 * status.json records `sessionId` as the parent's session FILE PATH, e.g.
 * `…\sessions\--F--explore--\2026-08-15T08-23-24-564Z_01a00484-….jsonl`, not as
 * the bare session id pi-hub uses. Pull the id back out of the filename so the
 * two can be compared. Child transcripts are plain `session.jsonl` with no id
 * segment and correctly yield undefined.
 */
export function sessionIdFromSessionPath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const file = value.split(/[\\/]/).pop() ?? "";
  return file.match(/_([0-9a-fA-F][0-9a-fA-F-]{7,})\.jsonl$/)?.[1];
}

export type LiveSubagentWork = {
  runId: string;
  state: string;
  lastUpdate: number;
};

export type LiveSubagentWorkOptions = {
  dir?: string;
  now?: number;
  staleAfterMs?: number;
};

/**
 * Returns the live detached runs belonging to `sessionId`. Never throws: a
 * missing directory, a half-written status.json, or a permission error must not
 * take down the idle path that calls this.
 */
export function findLiveSubagentWork(
  sessionId: string,
  options: LiveSubagentWorkOptions = {},
): LiveSubagentWork[] {
  if (!sessionId) return [];
  const dir = options.dir ?? subagentAsyncRunsDir();
  const now = options.now ?? Date.now();
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_RUN_MS;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const live: LiveSubagentWork[] = [];
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    let status: Record<string, unknown>;
    try {
      status = JSON.parse(readFileSync(join(dir, entry, "status.json"), "utf-8")) as Record<string, unknown>;
    } catch {
      continue;
    }
    // Accept either form: the recorded session file path, or a bare id in case
    // a future pi-subagents writes one.
    const owner = status.sessionId;
    if (owner !== sessionId && sessionIdFromSessionPath(owner) !== sessionId) continue;
    const state = typeof status.state === "string" ? status.state : "";
    if (!LIVE_RUN_STATES.has(state)) continue;
    const lastUpdate = typeof status.lastUpdate === "number" ? status.lastUpdate : 0;
    // A status file from the future (clock skew) counts as fresh, not stale.
    if (now - lastUpdate > staleAfterMs) continue;
    live.push({
      runId: typeof status.runId === "string" ? status.runId : entry,
      state,
      lastUpdate,
    });
  }
  return live;
}

export function hasLiveSubagentWork(sessionId: string, options: LiveSubagentWorkOptions = {}): boolean {
  return findLiveSubagentWork(sessionId, options).length > 0;
}
