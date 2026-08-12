import type { AgentMessage, AssistantContentBlock, AssistantMessage, ThinkingContent, ToolCallContent, ToolResultMessage } from "./types";

interface DisplayOptions {
  isStreaming?: boolean;
}

export function isEmptyThinkingBlock(block: AssistantContentBlock, options: DisplayOptions = {}): block is ThinkingContent {
  return block.type === "thinking" && !block.deferred && !options.isStreaming && block.thinking.trim() === "";
}

export function getDisplayableAssistantBlocks(
  message: AssistantMessage,
  options: DisplayOptions = {},
): AssistantContentBlock[] {
  return (message.content ?? []).filter((block) => !isEmptyThinkingBlock(block, options));
}

export function getAssistantErrorMessage(
  message: AssistantMessage,
  options: DisplayOptions = {},
): string | null {
  if (options.isStreaming || message.stopReason !== "error") return null;
  return message.errorMessage?.trim() || "Unknown provider error";
}

function isFinalAnswerBlock(block: AssistantContentBlock): boolean {
  return block.type === "text" || block.type === "image";
}

export function splitFinalAssistantBlocks(
  message: AssistantMessage,
  options: DisplayOptions = {},
): { answerBlocks: AssistantContentBlock[]; processBlocks: AssistantContentBlock[] } {
  const blocks = getDisplayableAssistantBlocks(message, options);
  const lastProcessIndex = blocks.findLastIndex((block) => !isFinalAnswerBlock(block));
  if (lastProcessIndex === -1) {
    return { answerBlocks: blocks, processBlocks: [] };
  }
  return {
    answerBlocks: blocks.slice(lastProcessIndex + 1),
    processBlocks: blocks.slice(0, lastProcessIndex + 1),
  };
}

export function countToolCallBlocks(blocks: AssistantContentBlock[]): number {
  return blocks.filter((block): block is ToolCallContent => block.type === "toolCall").length;
}

/**
 * A duration in milliseconds, rendered for a trace row.
 *
 * Sub-second reads "<1s" rather than "0s": most tool calls really do finish
 * inside a second (65% of 2,484 measured), and "0s" reads as missing data while
 * "<1s" reads as fast. Minutes get an m/s split because "134s" makes the reader
 * do the division.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return "<1s";
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rest = secs % 60;
  return rest === 0 ? `${mins}m` : `${mins}m ${rest}s`;
}

/**
 * The name to show for the model that produced a turn.
 *
 * Shared so the process-group header and the per-turn caption cannot drift apart:
 * the header claims "this whole group ran on X", which is only true if it resolves
 * the name exactly as the turns inside it do.
 */
export function modelDisplayLabel(
  message: Pick<AssistantMessage, "model" | "provider">,
  modelNames?: Record<string, string>,
): string {
  return modelNames?.[`${message.provider}:${message.model}`] ?? modelNames?.[message.model] ?? message.model;
}

export interface ProcessSummary {
  /** The single model that ran the group, or null when more than one did. */
  modelLabel: string | null;
  modelCount: number;
  toolCallCount: number;
  /** Wall time from the first step starting to the last result landing. */
  elapsedMs: number | null;
  costTotal: number;
}

/**
 * Roll a turn's process steps up into the one line its header shows.
 *
 * Every step used to print its own model, token count and cost, so a ten-message
 * group repeated the same model name ten times and stacked twenty numbers nobody
 * reads individually. These are the aggregates worth one line instead.
 *
 * `countCost` is false for the trailing step split off the final assistant
 * message: its usage covers the whole message including the answer, and pi gives
 * no way to split the two, so it is credited to the answer's own caption instead.
 * The header total therefore reads as the cost of the steps it lists, not of the
 * entire turn.
 */
export function summarizeProcess(
  entries: Array<{ message: AgentMessage; countCost: boolean }>,
  toolResults: Map<string, ToolResultMessage>,
  modelNames: Record<string, string> | undefined,
): ProcessSummary {
  const labels = new Set<string>();
  let toolCallCount = 0;
  let costTotal = 0;
  let startedAt: number | null = null;
  let finishedAt: number | null = null;

  const noteStart = (ts?: number) => {
    if (ts && (startedAt === null || ts < startedAt)) startedAt = ts;
  };
  const noteEnd = (ts?: number) => {
    if (ts && (finishedAt === null || ts > finishedAt)) finishedAt = ts;
  };

  for (const { message, countCost } of entries) {
    if (message.role !== "assistant") continue;
    const assistant = message as AssistantMessage;
    if (assistant.provider) labels.add(modelDisplayLabel(assistant, modelNames));
    noteStart(assistant.timestamp);
    noteEnd(assistant.endedAt ?? assistant.timestamp);
    if (countCost && assistant.usage?.cost?.total) costTotal += assistant.usage.cost.total;

    for (const block of getDisplayableAssistantBlocks(assistant)) {
      if (block.type !== "toolCall") continue;
      toolCallCount++;
      // A tool that finished after the last generation extends the span.
      noteEnd(toolResults.get((block as ToolCallContent).toolCallId)?.timestamp);
    }
  }

  const elapsedMs = startedAt !== null && finishedAt !== null && finishedAt > startedAt
    ? finishedAt - startedAt
    : null;

  return {
    modelLabel: labels.size === 1 ? [...labels][0] : null,
    modelCount: labels.size,
    toolCallCount,
    elapsedMs,
    costTotal,
  };
}
