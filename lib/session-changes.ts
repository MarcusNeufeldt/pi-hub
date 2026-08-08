import type { AgentMessage, AssistantMessage, ToolCallContent, ToolResultMessage } from "@/lib/types";

/**
 * Session-scoped change extraction: files edited by the agent in THIS session
 * (from edit/write tool results), independent of git — works in any folder.
 */

export interface SessionChange {
  file: string;
  tool: string;
  diff: string;
}

export function isEditToolName(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return (
    name === "edit" ||
    name.startsWith("edit_") ||
    name.endsWith(".edit") ||
    name.endsWith("_edit") ||
    name.includes("str_replace") ||
    name.includes("replace_editor")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getResultDiff(result: ToolResultMessage): { text: string } | null {
  const details = (result as ToolResultMessage & { details?: unknown }).details;
  if (!isRecord(details)) return null;

  const patch = typeof details.patch === "string" ? details.patch : null;
  if (patch) return { text: patch };

  const diff = typeof details.diff === "string" ? details.diff : null;
  if (diff) return { text: diff };

  return null;
}

/** Files changed by edit/write tools in the current message list, deduped by
 *  file (last change wins). */
export function extractSessionChanges(messages: AgentMessage[]): SessionChange[] {
  const results = new Map<string, ToolResultMessage>();
  for (const m of messages) {
    if (m.role === "toolResult") {
      results.set((m as ToolResultMessage).toolCallId, m as ToolResultMessage);
    }
  }

  const byFile = new Map<string, SessionChange>();
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const block of (m as AssistantMessage).content ?? []) {
      if (block.type !== "toolCall") continue;
      const tc = block as ToolCallContent;
      if (!isEditToolName(tc.toolName)) continue;
      const result = results.get(tc.toolCallId);
      if (!result || result.isError) continue;
      const diff = getResultDiff(result);
      if (!diff) continue;
      const input = isRecord(tc.input) ? tc.input : {};
      const file =
        (typeof input.file_path === "string" && input.file_path) ||
        (typeof input.path === "string" && input.path) ||
        tc.toolName;
      byFile.set(file, { file, tool: tc.toolName, diff: diff.text });
    }
  }
  return [...byFile.values()];
}
