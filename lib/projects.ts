/**
 * Shared workspace/project helpers for Pi Hub.
 *
 * The home sidebar derives its "loaded workspaces" list client-side from
 * `/api/sessions` by deduping on `projectRoot` (so all worktrees of a repo
 * collapse into one entry) and sorting by most recent session activity.
 * Extracted here so TasksConfig can render the same workspace picker
 * without duplicating the logic or modifying SessionSidebar.
 */

import type { SessionInfo } from "./types";

/**
 * Return all projects (deduped by projectRoot so worktrees collapse into their
 * main repo) sorted by most recent session activity.
 */
export function getRecentProjects(sessions: SessionInfo[]): string[] {
  const latestByRoot = new Map<string, string>(); // projectRoot -> most recent modified
  for (const s of sessions) {
    const root = s.projectRoot ?? s.cwd;
    if (!root) continue;
    const prev = latestByRoot.get(root);
    if (!prev || s.modified > prev) {
      latestByRoot.set(root, s.modified);
    }
  }
  return [...latestByRoot.entries()]
    .sort((a, b) => b[1].localeCompare(a[1]))
    .map(([root]) => root);
}

/** Substitute the home dir prefix with ~ (no path truncation). */
export function displayCwd(cwd: string, homeDir?: string): string {
  return homeDir && cwd.startsWith(homeDir)
    ? "~" + cwd.slice(homeDir.length)
    : cwd;
}
