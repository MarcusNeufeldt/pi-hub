import type { SessionInfo } from "./types";

/**
 * Worker transcripts remain addressable by session id (for Transcript links)
 * but should not appear as user conversations in the left sidebar.
 */
export function isSubagentSession(
  session: Pick<SessionInfo, "name" | "path" | "firstMessage">,
): boolean {
  const name = session.name?.trim() ?? "";
  const firstMessage = session.firstMessage?.trimStart() ?? "";
  return /^subagent[-_]/i.test(name)
    || /[\\/]subagents[\\/]/i.test(session.path)
    || /^Parent agent:\s/i.test(firstMessage);
}

/** Scheduled task runs belong under Tasks rather than user conversations. */
export function isTaskRunSession(
  session: Pick<SessionInfo, "name" | "firstMessage">,
): boolean {
  const name = session.name?.trimStart() ?? "";
  const firstMessage = session.firstMessage?.trimStart() ?? "";
  return /^\[Task\]\s/.test(name)
    || /^\[Pi Hub Scheduled Execution\]/.test(firstMessage);
}

export function isSidebarConversationSession(
  session: Pick<SessionInfo, "name" | "path" | "firstMessage">,
): boolean {
  return !isSubagentSession(session) && !isTaskRunSession(session);
}
