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
