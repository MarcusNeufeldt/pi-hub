export interface AgentEventLike {
  type: string;
  [key: string]: unknown;
}

export const CODEMODE_SNAPSHOT_CALL_LIMIT = 200;
const PROGRESS_TEXT_LIMIT = 4_000;
const OMITTED_EVENT_TYPES = new Set(["turn_start", "turn_end", "entry_appended"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNestedToolExecutionEvent(event: AgentEventLike): boolean {
  return event.type.startsWith("tool_execution_")
    && typeof event.parentToolCallId === "string" && event.parentToolCallId !== "";
}

export function isSystemMessageEvent(event: AgentEventLike): boolean {
  return (event.type === "message_start" || event.type === "message_update" || event.type === "message_end")
    && isObject(event.message) && event.message.role === "system";
}

export interface ProgressCall {
  id: string;
  name: string;
  status: string;
  parentToolCallId?: string;
  error?: string;
}

function progressCall(value: unknown): ProgressCall | null {
  if (!isObject(value) || typeof value.id !== "string" || typeof value.name !== "string") return null;
  return {
    id: value.id.slice(0, 256),
    name: value.name.slice(0, 256),
    status: typeof value.status === "string" ? value.status.slice(0, 32) : "running",
    ...(typeof value.error === "string" ? { error: value.error.slice(0, 500) } : {}),
  };
}

function progressText(result: unknown): string {
  if (typeof result === "string") return result.slice(-PROGRESS_TEXT_LIMIT);
  if (!isObject(result) || !Array.isArray(result.content)) return "";
  return result.content.filter(isObject).filter((block) => block.type === "text")
    .slice(-10).map((block) => typeof block.text === "string" ? block.text.slice(-PROGRESS_TEXT_LIMIT) : "")
    .join("\n").slice(-PROGRESS_TEXT_LIMIT);
}

/** Only bounded text and call status travel in progress, never args, images or structured output. */
function projectProgress(result: unknown, codemode: boolean): unknown {
  const text = progressText(result);
  const details = isObject(result) && isObject(result.details) ? result.details : null;
  const calls = codemode && Array.isArray(details?.calls) ? details.calls : [];
  return {
    content: text ? [{ type: "text", text }] : [],
    ...(codemode ? { details: {
      calls: calls.slice(-CODEMODE_SNAPSHOT_CALL_LIMIT).map(progressCall).filter(Boolean),
      omittedCalls: Math.max(0, calls.length - CODEMODE_SNAPSHOT_CALL_LIMIT),
    } } : {}),
  };
}

/** Pi Hub consumes cumulative event.message, not upstream pi-web's delta projection. */
export function toClientAgentEvent(event: AgentEventLike): AgentEventLike | null {
  if (OMITTED_EVENT_TYPES.has(event.type) || isSystemMessageEvent(event)) return null;
  if (event.type === "message_update") return { type: event.type, message: event.message };
  if (event.type === "agent_end") return { type: "agent_end" };
  const nested = isNestedToolExecutionEvent(event);
  if (event.type === "tool_execution_update") {
    if (nested) return null;
    // Existing fleet updates keep their original payload and event name.
    if (event.toolName === "subagent") return {
      type: "subagent_update", toolCallId: event.toolCallId, partialResult: event.partialResult,
    };
    return {
      type: event.type, toolCallId: event.toolCallId, toolName: event.toolName,
      partialResult: projectProgress(event.partialResult, event.toolName === "codemode"),
    };
  }
  if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
    if (!nested && event.toolName === "subagent") return event;
    return {
      type: event.type, toolCallId: event.toolCallId, toolName: event.toolName,
      ...(nested ? { parentToolCallId: event.parentToolCallId } : {}),
      ...(event.type === "tool_execution_end" ? {
        isError: event.isError,
        ...(event.toolName === "codemode" && isObject(event.result)
          ? { partialResult: projectProgress(event.result, true) } : {}),
        ...(event.isError ? { errorText: progressText(event.result).slice(0, 500) } : {}),
      } : {}),
    };
  }
  return event;
}

export interface ToolExecutionProgress extends ProgressCall {
  text?: string;
  calls?: ProgressCall[];
  omittedCalls?: number;
}

/** Execution observations never become assistant/toolCall transcript messages. */
export function updateToolProgress(
  previous: ToolExecutionProgress[], event: AgentEventLike,
): ToolExecutionProgress[] {
  if (!event.type.startsWith("tool_execution_") || typeof event.toolCallId !== "string") return previous;
  const existing = previous.find((item) => item.id === event.toolCallId);
  const partial = isObject(event.partialResult) ? event.partialResult : null;
  const details = isObject(partial?.details) ? partial.details : null;
  const next: ToolExecutionProgress = {
    ...existing,
    id: event.toolCallId,
    name: typeof event.toolName === "string" ? event.toolName : existing?.name ?? "tool",
    status: event.type === "tool_execution_end" ? (event.isError ? "error" : "ok") : "running",
    ...(typeof event.parentToolCallId === "string" ? { parentToolCallId: event.parentToolCallId } : {}),
    ...(partial ? { text: progressText(partial) } : {}),
    ...(Array.isArray(details?.calls) ? {
      calls: details.calls.slice(-CODEMODE_SNAPSHOT_CALL_LIMIT).map(progressCall).filter((call): call is ProgressCall => call !== null),
      omittedCalls: typeof details.omittedCalls === "number" ? details.omittedCalls : 0,
    } : {}),
    ...(typeof event.errorText === "string" ? { error: event.errorText } : {}),
  };
  const finalCalls = event.type === "tool_execution_end"
    ? new Map(next.calls?.map((call) => [call.id, call])) : undefined;
  const retained = previous.filter((item) => item.id !== next.id).map((item) => {
    const final = item.parentToolCallId === next.id ? finalCalls?.get(item.id) : undefined;
    return final ? { ...item, status: final.status, error: final.error } : item;
  });
  return [...retained, next].slice(-CODEMODE_SNAPSHOT_CALL_LIMIT);
}
