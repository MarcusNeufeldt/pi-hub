import { open, readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

const MAX_TRANSCRIPT_DELTA_BYTES = 256 * 1024;
const MAX_FINAL_OUTPUT_BYTES = 1024 * 1024;
const MAX_EVENT_TEXT = 4_000;

export type SubagentEventKind = "assistant" | "tool" | "notice";
export type SubagentEventPhase = "running" | "completed" | "failed";

export interface SubagentTimelineEvent {
  id: string;
  agent: string;
  timestamp: string;
  kind: SubagentEventKind;
  phase?: SubagentEventPhase;
  title: string;
  detail?: string;
  result?: string;
  durationMs?: number;
}

export interface SubagentRunChildView {
  index: number;
  agent: string;
  task?: string;
  status: string;
  model?: string;
  thinking?: string;
  toolCount?: number;
  turnCount?: number;
  tokens?: number;
  durationMs?: number;
  currentTool?: string;
  currentToolArgs?: string;
  finalOutput?: string;
  outputPath?: string;
  transcriptPath?: string;
  sessionFile?: string;
  sessionId?: string;
  timelineSource?: string;
  timelineCursor: number;
  timelineComplete: boolean;
  events: SubagentTimelineEvent[];
}

export interface SubagentRunView {
  children: SubagentRunChildView[];
}

export type SubagentTimelineCursors = Record<string, { cursor?: number; source?: string }>;

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((block) => {
      const item = record(block);
      return item?.type === "text" && typeof item.text === "string" ? item.text : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function truncate(value: string | undefined, max = MAX_EVENT_TEXT): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  return normalized.length <= max ? normalized : `${normalized.slice(0, max)}…`;
}

function isoTimestamp(value: unknown, fallbackMs = Date.now()): string {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  return new Date(fallbackMs).toISOString();
}

function hashText(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function isPathWithin(candidate: string, roots: string[]): boolean {
  const resolvedCandidate = resolve(candidate);
  return roots.some((root) => {
    const rel = relative(resolve(root), resolvedCandidate);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}

interface TranscriptDelta {
  source: string;
  cursor: number;
  complete: boolean;
  records: Array<{ value: UnknownRecord; offset: number }>;
}

async function readJsonlDelta(path: string, cursor: number): Promise<TranscriptDelta> {
  const info = await stat(path);
  let start = Math.max(0, Math.min(cursor, info.size));
  if (cursor > info.size) start = 0;
  const length = Math.min(MAX_TRANSCRIPT_DELTA_BYTES, Math.max(0, info.size - start));
  if (length === 0) {
    return { source: path, cursor: start, complete: start >= info.size, records: [] };
  }

  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    const available = buffer.subarray(0, bytesRead);
    let consumed = bytesRead;
    if (start + bytesRead < info.size) {
      const lastNewline = available.lastIndexOf(0x0a);
      if (lastNewline < 0) {
        // One JSONL record can exceed the bounded read window (large tool
        // result/arguments). Advance instead of rereading the same bytes
        // forever; subsequent chunks skip the oversized record until its
        // newline, then normal records resume.
        const nextCursor = start + bytesRead;
        return { source: path, cursor: nextCursor, complete: nextCursor >= info.size, records: [] };
      }
      consumed = lastNewline + 1;
    }
    const body = available.subarray(0, consumed).toString("utf8");
    const records: Array<{ value: UnknownRecord; offset: number }> = [];
    let localOffset = 0;
    for (const line of body.split("\n")) {
      const lineBytes = Buffer.byteLength(line, "utf8") + 1;
      const trimmed = line.trim();
      if (trimmed) {
        try {
          const parsed = JSON.parse(trimmed);
          const item = record(parsed);
          if (item) records.push({ value: item, offset: start + localOffset });
        } catch {
          // A concurrently appended final line is retried from the same cursor.
        }
      }
      localOffset += lineBytes;
    }
    const nextCursor = start + consumed;
    return { source: path, cursor: nextCursor, complete: nextCursor >= info.size, records };
  } finally {
    await handle.close();
  }
}

function normalizeArtifactRecord(
  raw: UnknownRecord,
  offset: number,
  fallbackAgent: string,
): SubagentTimelineEvent[] {
  const sourceEventType = string(raw.sourceEventType);
  const agent = string(raw.agent) ?? fallbackAgent;
  const timestamp = isoTimestamp(raw.timestamp ?? raw.ts);
  const toolCallId = string(raw.toolCallId);
  const toolName = string(raw.toolName) ?? "tool";
  const toolId = `tool:${agent}:${toolCallId ?? offset}`;

  if (sourceEventType === "tool_execution_start" || raw.recordType === "tool_start") {
    return [{
      id: toolId,
      agent,
      timestamp,
      kind: "tool",
      phase: "running",
      title: toolName,
      detail: truncate(string(raw.argsPreview), 1_000),
    }];
  }

  if (sourceEventType === "tool_execution_end" || raw.recordType === "tool_end") {
    return [{
      id: toolId,
      agent,
      timestamp,
      kind: "tool",
      phase: raw.isError === true ? "failed" : "completed",
      title: toolName,
      durationMs: number(raw.durationMs),
    }];
  }

  if (sourceEventType !== "message_end" && raw.recordType !== "message") return [];
  const role = string(raw.role);
  const text = truncate(string(raw.text));
  if (!text) return [];

  if (role === "assistant") {
    return [{ id: `message:${agent}:${offset}`, agent, timestamp, kind: "assistant", title: "Agent", detail: text }];
  }
  if (role === "toolResult") {
    return [{
      id: toolId,
      agent,
      timestamp,
      kind: "tool",
      phase: raw.isError === true ? "failed" : "completed",
      title: toolName,
      result: text,
    }];
  }
  if (role === "user" && raw.sourceEventType !== "initial_prompt") {
    return [{ id: `notice:${agent}:${offset}`, agent, timestamp, kind: "notice", title: "Notice", detail: text }];
  }
  return [];
}

function normalizeSessionEntry(
  raw: UnknownRecord,
  offset: number,
  fallbackAgent: string,
): SubagentTimelineEvent[] {
  if (raw.type !== "message") return [];
  const message = record(raw.message);
  if (!message) return [];
  const role = string(message.role);
  const timestamp = isoTimestamp(raw.timestamp ?? message.timestamp);
  const events: SubagentTimelineEvent[] = [];

  if (role === "assistant" && Array.isArray(message.content)) {
    const prose = textContent(message.content);
    if (prose) {
      events.push({
        id: `message:${fallbackAgent}:${offset}`,
        agent: fallbackAgent,
        timestamp,
        kind: "assistant",
        title: "Agent",
        detail: truncate(prose),
      });
    }
    for (const block of message.content) {
      const item = record(block);
      if (item?.type !== "toolCall") continue;
      const toolCallId = string(item.id ?? item.toolCallId) ?? String(offset);
      const toolName = string(item.name ?? item.toolName) ?? "tool";
      const args = record(item.arguments ?? item.input);
      events.push({
        id: `tool:${fallbackAgent}:${toolCallId}`,
        agent: fallbackAgent,
        timestamp,
        kind: "tool",
        phase: "running",
        title: toolName,
        detail: truncate(args ? JSON.stringify(args) : undefined, 1_000),
      });
    }
  }

  if (role === "toolResult") {
    const toolCallId = string(message.toolCallId) ?? String(offset);
    const toolName = string(message.toolName) ?? "tool";
    events.push({
      id: `tool:${fallbackAgent}:${toolCallId}`,
      agent: fallbackAgent,
      timestamp,
      kind: "tool",
      phase: message.isError === true ? "failed" : "completed",
      title: toolName,
      result: truncate(textContent(message.content)),
    });
  }

  return events;
}

function snapshotEvents(step: UnknownRecord | undefined, agent: string): SubagentTimelineEvent[] {
  if (!step) return [];
  const events: SubagentTimelineEvent[] = [];
  const recentTools = Array.isArray(step.recentTools) ? step.recentTools : [];
  for (const value of recentTools) {
    const tool = record(value);
    if (!tool) continue;
    const endMs = number(tool.endMs) ?? number(step.lastActivityAt) ?? Date.now();
    const name = string(tool.tool) ?? "tool";
    events.push({
      id: `snapshot-tool:${agent}:${name}:${endMs}`,
      agent,
      timestamp: isoTimestamp(endMs),
      kind: "tool",
      phase: "completed",
      title: name,
      detail: truncate(string(tool.args), 1_000),
    });
  }

  const currentTool = string(step.currentTool);
  if (currentTool) {
    const startedAt = number(step.currentToolStartedAt) ?? number(step.lastActivityAt) ?? Date.now();
    events.push({
      id: `snapshot-current:${agent}:${currentTool}:${startedAt}`,
      agent,
      timestamp: isoTimestamp(startedAt),
      kind: "tool",
      phase: "running",
      title: currentTool,
      detail: truncate(string(step.currentToolArgs), 1_000),
    });
  }

  const recentOutput = Array.isArray(step.recentOutput) ? step.recentOutput : [];
  for (const value of recentOutput.slice(-12)) {
    const text = truncate(string(value));
    if (!text) continue;
    const at = number(step.lastActivityAt) ?? Date.now();
    events.push({
      id: `snapshot-message:${agent}:${hashText(text)}`,
      agent,
      timestamp: isoTimestamp(at),
      kind: "assistant",
      title: "Agent",
      detail: text,
    });
  }
  return events;
}

function usageTokens(value: UnknownRecord | undefined): number | undefined {
  if (!value) return undefined;
  const direct = number(value.tokens);
  if (direct !== undefined) return direct;
  const input = number(value.input) ?? 0;
  const output = number(value.output) ?? 0;
  const cacheRead = number(value.cacheRead) ?? 0;
  const cacheWrite = number(value.cacheWrite) ?? 0;
  const total = input + output + cacheRead + cacheWrite;
  return total || undefined;
}

async function readSessionId(path: string | undefined, allowedRoots: string[]): Promise<string | undefined> {
  if (!path || !isPathWithin(path, allowedRoots)) return undefined;
  try {
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(4_096);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/, 1)[0];
      const header = firstLine ? record(JSON.parse(firstLine)) : undefined;
      return string(header?.id);
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

async function readFinalOutput(path: string | undefined, allowedRoots: string[]): Promise<string | undefined> {
  if (!path || !isPathWithin(path, allowedRoots)) return undefined;
  try {
    const value = await readFile(path, "utf8");
    return value.length <= MAX_FINAL_OUTPUT_BYTES
      ? value
      : `${value.slice(0, MAX_FINAL_OUTPUT_BYTES)}\n\n[Output truncated at 1 MiB]`;
  } catch {
    return undefined;
  }
}

export async function buildSubagentRunView(
  status: UnknownRecord,
  allowedRoots: string[],
  cursors: SubagentTimelineCursors = {},
): Promise<SubagentRunView> {
  const workflow = record(status.workflow);
  const value = record(workflow?.value);
  const results = Array.isArray(value?.results) ? value.results.map(record).filter(Boolean) as UnknownRecord[] : [];
  const steps = Array.isArray(status.steps) ? status.steps.map(record).filter(Boolean) as UnknownRecord[] : [];
  const count = Math.max(results.length, steps.length);
  const children: SubagentRunChildView[] = [];

  for (let index = 0; index < count; index += 1) {
    const result = results[index];
    const resultAgent = string(result?.agent);
    const step = steps.find((candidate) => string(candidate.agent) === resultAgent) ?? steps[index];
    const agent = resultAgent ?? string(step?.agent) ?? string(step?.label) ?? `agent ${index + 1}`;
    const artifacts = record(result?.artifactPaths);
    const outputReference = record(result?.outputReference);
    const progress = record(result?.progressSummary);
    const usage = record(result?.usage);
    const transcriptPath =
      string(result?.transcriptPath)
      ?? string(artifacts?.transcriptPath)
      ?? string(step?.transcriptPath);
    const sessionFile = string(result?.sessionFile) ?? string(step?.sessionFile);
    const timelinePath = [transcriptPath, sessionFile]
      .find((candidate): candidate is string => Boolean(candidate && isPathWithin(candidate, allowedRoots)));
    const cursorState = cursors[String(index)] ?? {};
    const requestedCursor = cursorState.source === timelinePath ? cursorState.cursor ?? 0 : 0;
    let events = snapshotEvents(step, agent);
    let timelineCursor = 0;
    let timelineComplete = !timelinePath;

    if (timelinePath) {
      try {
        const delta = await readJsonlDelta(timelinePath, requestedCursor);
        timelineCursor = delta.cursor;
        timelineComplete = delta.complete;
        events = delta.records.flatMap(({ value: raw, offset }) =>
          raw.recordType
            ? normalizeArtifactRecord(raw, offset, agent)
            : normalizeSessionEntry(raw, offset, agent),
        );
      } catch {
        events = snapshotEvents(step, agent);
        timelineCursor = requestedCursor;
        timelineComplete = false;
      }
    }

    const outputPath =
      string(result?.savedOutputPath)
      ?? string(outputReference?.path)
      ?? string(artifacts?.outputPath);
    const finalOutput =
      string(result?.finalOutput)
      ?? (count === 1 ? string(value?.output) : undefined)
      ?? await readFinalOutput(outputPath, allowedRoots);
    const exitCode = number(result?.exitCode);
    const statusText =
      string(step?.status)
      ?? (exitCode !== undefined ? (exitCode === 0 ? "completed" : "failed") : undefined)
      ?? (status.state === "complete" ? "completed" : string(status.state) ?? "running");

    children.push({
      index,
      agent,
      task: string(result?.task) ?? string(step?.task),
      status: statusText,
      model: string(result?.model) ?? string(step?.model),
      thinking: string(result?.thinking) ?? string(step?.thinking),
      toolCount: number(progress?.toolCount) ?? number(step?.toolCount),
      turnCount: number(usage?.turns) ?? number(step?.turnCount),
      tokens: number(progress?.tokens) ?? usageTokens(usage) ?? number(step?.tokens),
      durationMs: number(progress?.durationMs) ?? number(step?.durationMs),
      currentTool: string(step?.currentTool),
      currentToolArgs: string(step?.currentToolArgs),
      finalOutput,
      outputPath,
      transcriptPath,
      sessionFile,
      sessionId: string(result?.sessionId) ?? await readSessionId(sessionFile, allowedRoots),
      timelineSource: timelinePath,
      timelineCursor,
      timelineComplete,
      events,
    });
  }

  return { children };
}
