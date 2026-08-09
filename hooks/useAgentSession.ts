"use client";

import { useState, useCallback, useRef, useEffect, useLayoutEffect, useMemo, useReducer } from "react";
import type {
  AgentMessage,
  AssistantMessage,
  ExtensionStatusItem,
  ExtensionUiRequest,
  ExtensionWidgetItem,
  SessionInfo,
  SessionTreeNode,
  ToolCallContent,
  ToolResultMessage,
} from "@/lib/types";
import { normalizeToolCalls } from "@/lib/normalize";
import { sendAgentCommand } from "@/lib/agent-client";
import { getToolNamesForPreset, type ToolEntry } from "@/lib/tool-presets";
import type { SessionStatsInfo } from "@/lib/pi-types";
import type { SubagentRunView, SubagentTimelineEvent } from "@/lib/subagent-run-view";

export interface SessionData {
  sessionId: string;
  filePath: string;
  tree: SessionTreeNode[];
  leafId: string | null;
  context: {
    messages: AgentMessage[];
    entryIds: string[];
    thinkingLevel: string;
    model: { provider: string; modelId: string } | null;
  };
}

interface StreamingState {
  isStreaming: boolean;
  streamingMessage: Partial<AgentMessage> | null;
}

type StreamAction =
  | { type: "start" }
  | { type: "update"; message: Partial<AgentMessage> }
  | { type: "end" }
  | { type: "reset" };

function streamReducer(state: StreamingState, action: StreamAction): StreamingState {
  switch (action.type) {
    case "start":
      return { isStreaming: true, streamingMessage: null };
    case "update":
      return { isStreaming: true, streamingMessage: action.message };
    case "end":
    case "reset":
      return { isStreaming: false, streamingMessage: null };
    default:
      return state;
  }
}

interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

interface CompactCommandResult {
  tokensBefore?: number;
  estimatedTokensAfter?: number;
}

interface LastAssistantTextResponse {
  text?: string;
}

type AgentStateResponse = {
  contextUsage?: { percent: number | null; contextWindow: number; tokens: number | null } | null;
  systemPrompt?: string;
  thinkingLevel?: string;
  isStreaming?: boolean;
  isPromptRunning?: boolean;
  isBashRunning?: boolean;
  isCompacting?: boolean;
  extensionStatuses?: ExtensionStatusItem[];
  extensionWidgets?: ExtensionWidgetItem[];
  queuedMessages?: { steering?: string[]; followUp?: string[] } | null;
};

export interface QueuedMessages {
  steering: string[];
  followUp: string[];
}

function normalizeQueuedMessages(q?: { steering?: string[]; followUp?: string[] } | null): QueuedMessages {
  return { steering: q?.steering ?? [], followUp: q?.followUp ?? [] };
}

type ExtensionUiDialogRequest = Extract<ExtensionUiRequest, { method: "select" | "confirm" | "input" | "editor" }>;
type ExtensionUiCustomRequest = Extract<ExtensionUiRequest, { method: "custom" }>;
export type NoticeType = "info" | "success" | "warning" | "error";

export type NoticeItem = {
  id: string;
  message: string;
  type: NoticeType;
  exiting?: boolean;
};

type NoticeState = {
  visible: NoticeItem[];
  pending: NoticeItem[];
};

type NoticeAction =
  | { type: "add"; notice: NoticeItem }
  | { type: "mark_oldest_exiting" }
  | { type: "remove"; id: string };

export type AgentPhase =
  | { kind: "waiting_model" }
  | { kind: "running_command" }
  | { kind: "running_tools"; tools: { id: string; name: string }[] }
  | null;

export interface CompactResultInfo {
  reason: "manual" | "threshold" | "overflow" | "auto" | string;
  tokensBefore: number;
  estimatedTokensAfter: number;
}

export interface SlashCommandInfo {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
  sourceInfo?: {
    path: string;
    source: string;
    scope: "user" | "project" | "temporary";
    origin: "package" | "top-level";
    baseDir?: string;
  };
}

export type BuiltinSlashCommandResult =
  | { handled: false }
  | { handled: true; message?: string; error?: string; action?: "openSessionStats" };

export interface UseAgentSessionOptions {
  session: SessionInfo | null;
  newSessionCwd: string | null;
  onAgentEnd?: () => void;
  onSessionCreated?: (session: SessionInfo) => void;
  onSessionForked?: (newSessionId: string) => void;
  modelsRefreshKey?: number;
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
  onBranchDataChange?: (tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void) => void;
  onSystemPromptChange?: (prompt: string | null) => void;
  onSessionStatsPanelOpen?: () => void;
  setToolPreset?: (preset: "none" | "default" | "full") => void;
  /**
   * Fires once per prompt run when it reaches a terminal state (success via
   * `prompt_done`, or failure via `prompt_error`). Used by the chat layer to
   * dispatch external notifications (e.g. Telegram). The first terminal event
   * for a given run wins, so retries that eventually succeed do not
   * double-fire.
   */
  onPromptFinished?: (info: {
    runId: number;
    status: "success" | "failed";
    sessionId: string | null;
    userPrompt: string | null;
    startedAt: number | null;
    finishedAt: number;
    errorMessage?: string | null;
  }) => void;
}

export type ThinkingLevelOption = "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const PROGRAMMATIC_SCROLL_IGNORE_MS = 700;
const USER_SCROLL_INTENT_MS = 1200;
// Distance from the bottom of the scroll container within which live-follow
// scrolling is active. Larger values make follow more lenient; smaller values
// require the user to stay closer to the bottom.
const SCROLL_BOTTOM_THRESHOLD = 150;
const PROMPT_SETTLE_INITIAL_DELAY_MS = 800;
const PROMPT_SETTLE_POLL_MS = 600;
const PROMPT_SETTLE_MAX_MS = 20_000;
const EVENT_STREAM_IDLE_GRACE_MS = 30_000;
const AGENT_STATE_RECONCILE_MS = 15_000;
const BASH_STATE_RECONCILE_MS = 1_000;
const EVENT_STREAM_CONNECT_TIMEOUT_MS = 5_000;
const MAX_NOTICES = 5;
const NOTICE_VISIBLE_MS = 5000;
const NOTICE_EXIT_ANIMATION_MS = 180;
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " ", "Space", "Spacebar"]);

type EventStreamConnectionStatus = "connected" | "timeout" | "closed";

type EventStreamConnectionResult = {
  status: EventStreamConnectionStatus;
  source: EventSource;
};

type EventStreamConnectionAttempt = {
  source: EventSource;
  promise: Promise<EventStreamConnectionResult>;
  pending: boolean;
};

class EventStreamConnectionError extends Error {
  constructor(public readonly status: Exclude<EventStreamConnectionStatus, "connected">) {
    super(status === "timeout"
      ? "Timed out connecting to the agent event stream. Please try again."
      : "Failed to connect to the agent event stream. Please try again.");
    this.name = "EventStreamConnectionError";
  }
}

function createNoticeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function markOldestNoticeExiting(notices: NoticeItem[]): NoticeItem[] {
  const index = notices.findIndex((notice) => !notice.exiting);
  if (index === -1) return notices;
  return notices.map((notice, i) => (
    i === index ? { ...notice, exiting: true } : notice
  ));
}

function fillPendingNotices(visible: NoticeItem[], pending: NoticeItem[]): NoticeState {
  let nextVisible = visible;
  let nextPending = pending;
  while (nextPending.length > 0 && nextVisible.length < MAX_NOTICES) {
    const [next, ...rest] = nextPending;
    nextVisible = [...nextVisible, next];
    nextPending = rest;
  }
  if (nextPending.length > 0 && !nextVisible.some((notice) => notice.exiting)) {
    nextVisible = markOldestNoticeExiting(nextVisible);
  }
  return { visible: nextVisible, pending: nextPending };
}

function noticeReducer(state: NoticeState, action: NoticeAction): NoticeState {
  switch (action.type) {
    case "add": {
      if (state.visible.some((notice) => notice.exiting) || state.visible.length >= MAX_NOTICES) {
        return {
          visible: state.visible.some((notice) => notice.exiting)
            ? state.visible
            : markOldestNoticeExiting(state.visible),
          pending: [...state.pending, action.notice],
        };
      }
      return { ...state, visible: [...state.visible, action.notice] };
    }
    case "mark_oldest_exiting":
      return { ...state, visible: markOldestNoticeExiting(state.visible) };
    case "remove": {
      const visible = state.visible.filter((notice) => notice.id !== action.id);
      return fillPendingNotices(visible, state.pending);
    }
    default:
      return state;
  }
}

function extractMessageText(message: Partial<AgentMessage>): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block && typeof block === "object"
        && (block as { type?: string }).type === "text"
        && typeof (block as { text?: unknown }).text === "string"
        ? (block as { text: string }).text
        : "")
    .filter(Boolean)
    .join("\n");
}

function imageSignature(block: unknown): string {
  if (!block || typeof block !== "object" || (block as { type?: unknown }).type !== "image") return "";
  const source = (block as { source?: unknown }).source;
  if (source && typeof source === "object") {
    const src = source as { type?: unknown; media_type?: unknown; data?: unknown; url?: unknown };
    return [
      src.type === "url" ? "url" : "base64",
      typeof src.media_type === "string" ? src.media_type : "",
      typeof src.data === "string" ? src.data : "",
      typeof src.url === "string" ? src.url : "",
    ].join(":");
  }
  const flat = block as { data?: unknown; mimeType?: unknown };
  return [
    "base64",
    typeof flat.mimeType === "string" ? flat.mimeType : "",
    typeof flat.data === "string" ? flat.data : "",
    "",
  ].join(":");
}

function userMessageKey(message: Partial<AgentMessage>): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return JSON.stringify({ text: content, images: [] });
  if (!Array.isArray(content)) return JSON.stringify({ text: "", images: [] });
  return JSON.stringify({
    text: extractMessageText(message),
    images: content.map(imageSignature).filter(Boolean),
  });
}

function readCompactResult(result: unknown, reason: string): CompactResultInfo | null {
  if (!result || typeof result !== "object") return null;
  const r = result as CompactCommandResult;
  if (typeof r.tokensBefore !== "number" || typeof r.estimatedTokensAfter !== "number") return null;
  return { reason, tokensBefore: r.tokensBefore, estimatedTokensAfter: r.estimatedTokensAfter };
}

export interface ChatInputHandle {
  insertText: (text: string) => void;
  insertIfEmpty: (content: string) => void;
  prependText: (text: string) => void;
  addImages: (files: File[]) => void;
}

export interface AttachedImage {
  data: string;
  mimeType: string;
  previewUrl: string;
}

type SelectedModel = { provider: string; modelId: string };
type ModelEntry = { id: string; name: string; provider: string };
type ModelsResponse = {
  models: Record<string, string>;
  modelList?: ModelEntry[];
  defaultModel?: SelectedModel | null;
  thinkingLevels?: Record<string, string[]>;
  thinkingLevelMaps?: Record<string, Record<string, string | null>>;
  thinkingLevelPins?: Record<string, string>;
  modelError?: string;
  modelScopeWarnings?: string[];
};

type SlashCommandsResponse = {
  commands?: SlashCommandInfo[];
};

export interface SubagentChild {
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

/** One `subagent` tool call = one delegation, possibly with several children. */
export interface SubagentDelegation {
  toolCallId: string;
  task?: string;
  running: boolean;
  children: SubagentChild[];
  /** Async-run directory (pi-subagents) — polled for live status.json. */
  asyncDir?: string;
  runId?: string;
  /** Worker session id (from status.json artifactPaths) — opens transcript. */
  transcriptSessionId?: string;
}

function mergeSubagentEvents(
  existing: SubagentTimelineEvent[] | undefined,
  incoming: SubagentTimelineEvent[] | undefined,
): SubagentTimelineEvent[] | undefined {
  if (!incoming?.length) return existing;
  const events = new Map((existing ?? []).map((event) => [event.id, event]));
  for (const next of incoming) {
    const previous = events.get(next.id);
    let durationMs = next.durationMs ?? previous?.durationMs;
    if (
      durationMs === undefined
      && previous?.phase === "running"
      && next.phase !== "running"
    ) {
      const started = Date.parse(previous.timestamp);
      const ended = Date.parse(next.timestamp);
      if (Number.isFinite(started) && Number.isFinite(ended) && ended >= started) {
        durationMs = ended - started;
      }
    }
    events.set(next.id, {
      ...previous,
      ...next,
      // Completed tool patches keep the start timestamp so the activity row
      // remains in chronological launch order.
      timestamp: previous?.kind === "tool" ? previous.timestamp : next.timestamp,
      durationMs,
    });
  }
  return [...events.values()]
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp))
    .slice(-300);
}

function omitDuplicatedFinalNarration(
  events: SubagentTimelineEvent[] | undefined,
  finalOutput: string | undefined,
): SubagentTimelineEvent[] | undefined {
  if (!events?.length || !finalOutput) return events;
  const result = finalOutput.replace(/\r\n/g, "\n").trim();
  if (!result) return events;
  let index = -1;
  for (let eventIndex = events.length - 1; eventIndex >= 0; eventIndex -= 1) {
    if (events[eventIndex].kind === "assistant") {
      index = eventIndex;
      break;
    }
  }
  if (index < 0) return events;
  const narration = events[index].detail?.replace(/\r\n/g, "\n").trim();
  if (!narration) return events;
  const duplicatesResult = narration === result || narration.startsWith(`${result}\n`);
  return duplicatesResult ? events.filter((_, eventIndex) => eventIndex !== index) : events;
}

function sessionIdFromArtifactPath(filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;
  const name = filePath.split(/[\\/]/).pop() ?? "";
  // A nested `run-N/session.jsonl` parent is the workflow run id, not the
  // child session id. The artifact endpoint reads the real header id.
  if (/^session\.jsonl$/i.test(name)) return undefined;
  return name.match(/^.*?_([0-9a-f-]+)\.jsonl$/i)?.[1];
}

/**
 * Maps pi-subagents `subagent` tool args to panel children, mirroring the
 * extension's execution modes:
 * - single:    { agent, task }
 * - fanout:    { tasks: [{ agent?, task?, label? }] } or { agents: [...] }
 * - workflow:  { workflowScript, agent? } (children arrive via progress snapshots)
 * Management calls ({ action: ... }) are NOT delegations — callers skip them.
 */
function buildSubagentChildren(args: Record<string, unknown> | undefined): SubagentChild[] {
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
      children.push({ agent, task, status: "running" });
    });
    return children;
  }
  if (Array.isArray(args.agents)) {
    args.agents.forEach((a, i) => {
      const item = (a ?? {}) as Record<string, unknown>;
      const agent =
        typeof item === "string" ? item : typeof item.agent === "string" ? item.agent : `agent ${i + 1}`;
      children.push({
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
      agent: agent ?? (typeof args.workflowScript === "string" ? "workflow" : "subagent"),
      task,
      status: "running",
    });
  }
  return children;
}

/**
 * pi-subagents async runs return immediately with detach boilerplate instead
 * of real output — strip it so cards show substance or nothing.
 */
const DETACH_BOILERPLATE =
  /Async workflow \[[0-9a-f-]+\]|Direct execution was removed|The async run is detached and running in the background|do not run sleep\/polling loops|You are in an interactive session/;

function cleanSubagentOutput(text: string | undefined): string | undefined {
  if (!text) return undefined;
  if (text.length < 700 && DETACH_BOILERPLATE.test(text)) return undefined;
  return text;
}

/**
 * Task labels get polluted with the workflowScript body ("return runs.run(...)").
 * Strip the script and, when the label IS the script, pull out the quoted task.
 */
function cleanTaskLabel(task: string | undefined): string | undefined {
  if (!task) return undefined;
  const cleaned = task.replace(/\n?return\s+runs\.run\b[\s\S]*$/, "").trim();
  if (/^return\s+runs\.run\b/.test(cleaned)) {
    const m = cleaned.match(/task:\s*["']([^"']+)["']/);
    if (m) return m[1].trim();
    return undefined;
  }
  return cleaned || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Rebuilds delegations from loaded session messages — so a page refresh
 * restores the fleet (completed runs from their results, in-flight runs
 * from their tool args; live updates then merge in).
 */
function subagentsFromMessages(messages: AgentMessage[]): SubagentDelegation[] {
  const results = new Map<string, ToolResultMessage>();
  for (const m of messages) {
    if (m.role === "toolResult") {
      results.set((m as ToolResultMessage).toolCallId, m as ToolResultMessage);
    }
  }
  const delegations: SubagentDelegation[] = [];
  const seen = new Set<string>();
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const block of (m as AssistantMessage).content ?? []) {
      if (block.type !== "toolCall") continue;
      const tc = block as ToolCallContent;
      if (tc.toolName !== "subagent") continue;
      if (seen.has(tc.toolCallId)) continue;
      seen.add(tc.toolCallId);
      const args = isRecord(tc.input) ? tc.input : {};
      if (typeof args.action === "string") continue; // management call
      const children = buildSubagentChildren(args);
      if (children.length === 0) continue;
      const task =
        typeof args.task === "string"
          ? cleanTaskLabel(args.task)
          : typeof args.workflowScript === "string"
            ? cleanTaskLabel(args.workflowScript)
            : undefined;
      const result = results.get(tc.toolCallId);
      if (!result || result.isError) {
        delegations.push({ toolCallId: tc.toolCallId, task, running: true, children });
        continue;
      }
      const resultText = cleanSubagentOutput(
        result.content
          .filter((b): b is { type: "text"; text: string } => b.type === "text" && b.text)
          .map((b) => b.text)
          .join("\n")
          .trim(),
      ) ?? "";
      const resultOutput = resultText ? resultText.slice(0, 500) : undefined;
      const resultOutputLines = resultText ? resultText.split("\n").slice(-10) : undefined;
      const details = isRecord((result as { details?: unknown }).details)
        ? (result as { details: Record<string, unknown> }).details
        : undefined;
      const asyncDir = typeof details?.asyncDir === "string" ? details.asyncDir : undefined;
      const runId = typeof details?.runId === "string" ? details.runId : undefined;
      const rrows = Array.isArray(details?.results) ? (details.results as Array<Record<string, unknown>>) : [];
      const prog = Array.isArray(details?.progress) ? (details.progress as Array<Record<string, unknown>>) : [];
      let finalChildren: SubagentChild[];
      if (rrows.length > 0) {
        finalChildren = rrows
          .map((r) => {
            const agent = typeof r.agent === "string" ? r.agent : undefined;
            if (!agent) return null;
            const existing = children.find((c) => c.agent === agent);
            const status =
              r.exitCode === 0
                ? "completed"
                : r.timedOut
                  ? "timed_out"
                  : r.interrupted
                    ? "interrupted"
                    : "failed";
            const artifactPaths = isRecord(r.artifactPaths) ? r.artifactPaths : undefined;
            const outputReference = isRecord(r.outputReference) ? r.outputReference : undefined;
            const progressSummary = isRecord(r.progressSummary) ? r.progressSummary : undefined;
            const usage = isRecord(r.usage) ? r.usage : undefined;
            const finalOutput = typeof r.finalOutput === "string" ? r.finalOutput : undefined;
            const transcriptPath =
              (typeof r.transcriptPath === "string" ? r.transcriptPath : undefined)
              ?? (typeof artifactPaths?.transcriptPath === "string" ? artifactPaths.transcriptPath : undefined);
            const sessionFile =
              (typeof r.sessionFile === "string" ? r.sessionFile : undefined)
              ?? (typeof artifactPaths?.sessionFile === "string" ? artifactPaths.sessionFile : undefined);
            const outputPath =
              (typeof r.savedOutputPath === "string" ? r.savedOutputPath : undefined)
              ?? (typeof outputReference?.path === "string" ? outputReference.path : undefined)
              ?? (typeof artifactPaths?.outputPath === "string" ? artifactPaths.outputPath : undefined);
            return {
              ...existing,
              agent,
              task: cleanTaskLabel(
                typeof r.task === "string" ? r.task : existing?.task ?? task,
              ),
              status,
              exitCode: typeof r.exitCode === "number" ? r.exitCode : undefined,
              recentOutput:
                existing?.recentOutput
                ?? finalOutput?.split("\n").find((line) => line.trim())?.slice(0, 500)
                ?? resultOutput,
              recentOutputLines: existing?.recentOutputLines ?? resultOutputLines,
              finalOutput: finalOutput ?? existing?.finalOutput,
              transcriptPath: transcriptPath ?? existing?.transcriptPath,
              sessionFile: sessionFile ?? existing?.sessionFile,
              outputPath: outputPath ?? existing?.outputPath,
              toolCount:
                typeof progressSummary?.toolCount === "number"
                  ? progressSummary.toolCount
                  : existing?.toolCount,
              turnCount: typeof usage?.turns === "number" ? usage.turns : existing?.turnCount,
              tokens:
                typeof progressSummary?.tokens === "number"
                  ? progressSummary.tokens
                  : existing?.tokens,
              model: typeof r.model === "string" ? r.model : existing?.model,
              thinking: typeof r.thinking === "string" ? r.thinking : existing?.thinking,
              durationMs:
                typeof progressSummary?.durationMs === "number"
                  ? progressSummary.durationMs
                  : existing?.durationMs,
            } as SubagentChild;
          })
          .filter((c): c is SubagentChild => c !== null);
      } else if (prog.length > 0) {
        finalChildren = prog.map((p) => {
          const agent = typeof p.agent === "string" ? p.agent : "agent";
          const existing = children.find((c) => c.agent === agent);
          return {
            ...existing,
            agent,
            task: cleanTaskLabel(existing?.task ?? task),
            status: typeof p.status === "string" ? p.status : "completed",
            recentOutput: existing?.recentOutput ?? resultOutput,
            recentOutputLines: existing?.recentOutputLines ?? resultOutputLines,
            toolCount: typeof p.toolCount === "number" ? p.toolCount : undefined,
            tokens: typeof p.tokens === "number" ? p.tokens : undefined,
            durationMs: typeof p.durationMs === "number" ? p.durationMs : undefined,
          } as SubagentChild;
        });
      } else {
        finalChildren = children.map((c) => ({
          ...c,
          status: "completed",
          recentOutput: c.recentOutput ?? resultOutput,
          recentOutputLines: c.recentOutputLines ?? resultOutputLines,
        }));
      }
      // Detached async runs: the tool result is just the detach notice — keep
      // them running so the status.json poller resumes after a refresh. Stale
      // progress rows are not real completion evidence when a run dir exists.
      const detached = Boolean(asyncDir) && !resultOutput && rrows.length === 0;
      const transcriptSessionId = finalChildren
        .map((child) => sessionIdFromArtifactPath(child.sessionFile))
        .find(Boolean);
      delegations.push({
        toolCallId: tc.toolCallId,
        task,
        running: detached ? true : false,
        children: detached
          ? children.map((c) => ({ ...c, status: "running" }))
          : finalChildren,
        asyncDir,
        runId,
        transcriptSessionId,
      });
    }
  }
  return delegations;
}

/** Session/context refreshes can race artifact polling. Preserve the enriched
 * timeline/cursor state while applying newly persisted result metadata. */
function mergeRehydratedSubagents(
  previous: SubagentDelegation[],
  restored: SubagentDelegation[],
): SubagentDelegation[] {
  return restored.map((next) => {
    const current = previous.find((item) => item.toolCallId === next.toolCallId);
    if (!current) return next;
    const children = next.children.map((child, index) => {
      const existing = current.children.find((item) => item.agent === child.agent)
        ?? current.children[index];
      if (!existing) return child;
      return {
        ...child,
        ...existing,
        task: child.task ?? existing.task,
        status: child.status,
        finalOutput: child.finalOutput ?? existing.finalOutput,
        outputPath: child.outputPath ?? existing.outputPath,
        transcriptPath: child.transcriptPath ?? existing.transcriptPath,
        sessionFile: child.sessionFile ?? existing.sessionFile,
      };
    });
    return {
      ...current,
      ...next,
      children,
      asyncDir: next.asyncDir ?? current.asyncDir,
      runId: next.runId ?? current.runId,
      transcriptSessionId: current.transcriptSessionId ?? next.transcriptSessionId,
    };
  });
}

export function useAgentSession(opts: UseAgentSessionOptions) {
  const {
    session, newSessionCwd, onAgentEnd, onSessionCreated, onSessionForked,
    modelsRefreshKey, onBranchDataChange, onSystemPromptChange, onSessionStatsPanelOpen,
    onPromptFinished,
  } = opts;

  const isNew = session === null && newSessionCwd !== null;

  const [data, setData] = useState<SessionData | null>(null);
  const [loading, setLoading] = useState(!isNew);
  const [error, setError] = useState<string | null>(null);
  const [activeLeafId, setActiveLeafId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [entryIds, setEntryIds] = useState<string[]>([]);
  const [streamState, dispatch] = useReducer(streamReducer, { isStreaming: false, streamingMessage: null });
  const [agentRunning, setAgentRunning] = useState(false);
  const [bashRunning, setBashRunning] = useState(false);
  const [pendingBash, setPendingBash] = useState<{ command: string; excludeFromContext: boolean } | null>(null);
  const [modelNames, setModelNames] = useState<Record<string, string>>({});
  const [modelList, setModelList] = useState<ModelEntry[]>([]);
  const [modelError, setModelError] = useState<string | null>(null);
  const [modelScopeWarnings, setModelScopeWarnings] = useState<string[]>([]);
  const [modelThinkingLevels, setModelThinkingLevels] = useState<Record<string, string[]>>({});
  const [modelThinkingLevelMaps, setModelThinkingLevelMaps] = useState<Record<string, Record<string, string | null>>>({});
  const [newSessionModel, setNewSessionModel] = useState<SelectedModel | null>(null);
  const [newSessionDefaultModel, setNewSessionDefaultModel] = useState<SelectedModel | null>(null);
  const [toolPreset, setToolPreset] = useState<"none" | "default" | "full">("default");
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevelOption>("auto");
  const [retryInfo, setRetryInfo] = useState<{ attempt: number; maxAttempts: number; errorMessage?: string } | null>(null);
  const [contextUsage, setContextUsage] = useState<{ percent: number | null; contextWindow: number; tokens: number | null } | null>(null);
  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const [forkingEntryId, setForkingEntryId] = useState<string | null>(null);
  const [currentModelOverride, setCurrentModelOverride] = useState<{ provider: string; modelId: string } | null>(null);
  const [pendingModel, setPendingModel] = useState<{ provider: string; modelId: string } | null>(null);
  const [isCompacting, setIsCompacting] = useState(false);
  const [compactError, setCompactError] = useState<string | null>(null);
  const [compactResult, setCompactResult] = useState<CompactResultInfo | null>(null);
  const [agentPhase, setAgentPhase] = useState<AgentPhase>(null);
  const [promptAnchorActive, setPromptAnchorActive] = useState(false);
  const [slashCommands, setSlashCommands] = useState<SlashCommandInfo[]>([]);
  const [slashCommandsLoading, setSlashCommandsLoading] = useState(false);
  const [noticeState, dispatchNotice] = useReducer(noticeReducer, { visible: [], pending: [] });
  const [sessionStatsOverride, setSessionStatsOverride] = useState<SessionStatsInfo | null>(null);
  const [extensionDialog, setExtensionDialog] = useState<ExtensionUiDialogRequest | null>(null);
  const [extensionCustomUi, setExtensionCustomUi] = useState<ExtensionUiCustomRequest | null>(null);
  const [extensionStatuses, setExtensionStatuses] = useState<ExtensionStatusItem[]>([]);
  const [extensionWidgets, setExtensionWidgets] = useState<ExtensionWidgetItem[]>([]);
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessages>({ steering: [], followUp: [] });
  const [subagents, setSubagents] = useState<SubagentDelegation[]>([]);
  const subagentsPollRef = useRef<SubagentDelegation[]>([]);
  const clearSubagents = useCallback(() => setSubagents([]), []);

  useEffect(() => {
    subagentsPollRef.current = subagents;
  }, [subagents]);

  // Detached runs publish bounded live snapshots plus append-only child
  // transcripts. Poll the normalized server view and merge transcript deltas
  // into a durable per-child activity timeline.
  useEffect(() => {
    let cancelled = false;
    let polling = false;

    const poll = async () => {
      if (polling || cancelled) return;
      const targets = subagentsPollRef.current.filter((delegation) => {
        const needsAsyncRun = Boolean(delegation.asyncDir) && (
          delegation.running
          || !delegation.transcriptSessionId
          || delegation.children.some((child) => child.timelineComplete === false)
        );
        const needsArtifactTimeline = delegation.children.some(
          (child) => child.transcriptPath && child.timelineComplete !== true,
        );
        return needsAsyncRun || needsArtifactTimeline;
      });
      if (targets.length === 0) return;
      polling = true;
      try {
        await Promise.all(targets.map(async (delegation) => {
          const cursors = Object.fromEntries(
            delegation.children.map((child, index) => [String(index), {
              cursor: child.timelineCursor ?? 0,
              source: child.timelineSource,
            }]),
          );
          const query = new URLSearchParams({ cursors: JSON.stringify(cursors) });
          if (delegation.asyncDir) {
            query.set("dir", delegation.asyncDir);
          } else {
            query.set("artifacts", JSON.stringify(delegation.children.map((child) => ({
              agent: child.agent,
              task: child.task,
              transcriptPath: child.transcriptPath,
              sessionFile: child.sessionFile,
              outputReference: child.outputPath,
            }))));
          }
          try {
            const response = await fetch(`/api/subagent-run?${query.toString()}`);
            if (!response.ok || cancelled) return;
            const status = await response.json() as {
              state?: string;
              startedAt?: number;
              lastUpdate?: number;
              piHub?: SubagentRunView;
            };
            const views = status.piHub?.children ?? [];
            const done = status.state === "complete";
            const fallbackDuration =
              typeof status.lastUpdate === "number" && typeof status.startedAt === "number"
                ? status.lastUpdate - status.startedAt
                : undefined;

            setSubagents((previous) => previous.map((current) => {
              if (current.toolCallId !== delegation.toolCallId) return current;
              if (views.length === 0) {
                return {
                  ...current,
                  running: !done,
                  children: current.children.map((child) => ({
                    ...child,
                    status: done ? "completed" : child.status,
                    durationMs: child.durationMs ?? fallbackDuration,
                  })),
                };
              }

              const children = views.map((view, index) => {
                const existing =
                  current.children.find((child) => child.agent === view.agent)
                  ?? current.children[view.index]
                  ?? current.children[index];
                const finalOutput = view.finalOutput ?? existing?.finalOutput;
                const firstOutputLine = finalOutput
                  ?.split("\n")
                  .find((line) => line.trim())
                  ?.trim();
                const mergedEvents = mergeSubagentEvents(
                  view.timelineSource
                    ? existing?.events?.filter((event) => !event.id.startsWith("snapshot-"))
                    : existing?.events,
                  view.events,
                );
                return {
                  ...existing,
                  agent: view.agent,
                  task: cleanTaskLabel(view.task ?? existing?.task ?? current.task),
                  status: view.status,
                  currentTool: view.currentTool,
                  currentToolArgs: view.currentToolArgs,
                  recentOutput: firstOutputLine?.slice(0, 500) ?? existing?.recentOutput,
                  recentOutputLines: existing?.recentOutputLines,
                  events: omitDuplicatedFinalNarration(mergedEvents, finalOutput),
                  finalOutput,
                  outputPath: view.outputPath ?? existing?.outputPath,
                  transcriptPath: view.transcriptPath ?? existing?.transcriptPath,
                  sessionFile: view.sessionFile ?? existing?.sessionFile,
                  timelineSource: view.timelineSource ?? existing?.timelineSource,
                  timelineCursor: view.timelineCursor,
                  timelineCompletePolls: view.timelineComplete
                    ? (
                        existing?.timelineSource === view.timelineSource
                        && view.events.length === 0
                          ? (existing.timelineCompletePolls ?? 0) + 1
                          : 1
                      )
                    : 0,
                  timelineComplete: view.timelineComplete
                    && existing?.timelineSource === view.timelineSource
                    && view.events.length === 0
                    && (existing.timelineCompletePolls ?? 0) >= 1,
                  toolCount: view.toolCount ?? existing?.toolCount,
                  turnCount: view.turnCount ?? existing?.turnCount,
                  tokens: view.tokens ?? existing?.tokens,
                  model: view.model ?? existing?.model,
                  thinking: view.thinking ?? existing?.thinking,
                  durationMs: view.durationMs ?? existing?.durationMs ?? fallbackDuration,
                } satisfies SubagentChild;
              });
              const transcriptSessionId =
                views.map((view) => view.sessionId).find(Boolean)
                ?? views.map((view) => sessionIdFromArtifactPath(view.sessionFile)).find(Boolean)
                ?? current.transcriptSessionId;
              return {
                ...current,
                task: children[0]?.task ?? current.task,
                children,
                running: status.state === "queued" || status.state === "running",
                transcriptSessionId,
              };
            }));
          } catch {
            // A partial status write or temporary disconnect is retried.
          }
        }));
      } finally {
        polling = false;
      }
    };

    void poll();
    const id = setInterval(() => void poll(), 1_500);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const eventSourceRef = useRef<EventSource | null>(null);
  const eventSourceSessionIdRef = useRef<string | null>(null);
  const eventConnectionAttemptRef = useRef<EventStreamConnectionAttempt | null>(null);
  const eventStreamGraceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const eventStreamGraceGenerationRef = useRef(0);
  const eventStreamGraceActiveRef = useRef(false);
  const subagentsRunningRef = useRef(false);
  const subagentWakeGraceUntilRef = useRef(0);
  const sessionIdRef = useRef<string | null>(session?.id ?? null);
  const agentRunningRef = useRef(false);
  const sdkAgentActiveRef = useRef(false);
  const rpcPromptPendingRef = useRef(false);
  const notifiedPromptRunIdRef = useRef(-1);
  const bashRunningRef = useRef(false);
  const bashRecoveryIdRef = useRef(0);
  const handleAgentEventRef = useRef<((event: AgentEvent) => void) | null>(null);
  const initialScrollDoneRef = useRef(false);
  const lastUserMsgRef = useRef<HTMLDivElement | null>(null);
  const pendingScrollToUserRef = useRef(false);
  const completionScrollAllowedRef = useRef(true);
  const isNearBottomRef = useRef(true);
  const liveFollowFrameRef = useRef<number | null>(null);
  const executeBashRef = useRef<(command: string, excludeFromContext: boolean) => Promise<void> | undefined>(undefined);
  const userScrollIntentUntilRef = useRef(0);
  const ignoreProgrammaticScrollUntilRef = useRef(0);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const ensuringNewSessionRef = useRef<Promise<string | null> | null>(null);
  const newSessionPromotedRef = useRef(false);
  const newSessionModelOverrideRef = useRef<SelectedModel | null>(null);
  const thinkingLevelOverrideRef = useRef<Exclude<ThinkingLevelOption, "auto"> | null>(null);
  const promptRunIdRef = useRef(0);
  const optimisticUserMessageKeyRef = useRef<string | null>(null);
  /** Prompt text of the in-flight run (for completion notifications). */
  const currentRunPromptRef = useRef<string | null>(null);
  /** Epoch ms when the in-flight run started. */
  const currentRunStartedAtRef = useRef<number | null>(null);
  /** Run id already surfaced via onPromptFinished (once-per-run guard). */
  const notifiedRunFinishedRef = useRef(-1);

  // Completion notifications use pi.sendMessage({ triggerTurn: true }). Keep
  // the selected session's SSE alive until that extension-triggered turn has
  // had a chance to start; otherwise long-running workers finish after the
  // normal 30-second idle grace and their automatic assistant turn is orphaned
  // in the session file until the browser reloads.
  useEffect(() => {
    const hasRunningSubagents = subagents.some((delegation) => delegation.running);
    if (hasRunningSubagents || subagentsRunningRef.current) {
      subagentWakeGraceUntilRef.current = Date.now() + EVENT_STREAM_IDLE_GRACE_MS;
    }
    subagentsRunningRef.current = hasRunningSubagents;
  }, [subagents]);

  const setToolPresetState = opts.setToolPreset ?? setToolPreset;

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    ignoreProgrammaticScrollUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_IGNORE_MS;
    messagesEndRef.current?.scrollIntoView({ behavior });
  }, []);

  const currentModel = currentModelOverride ?? data?.context.model ?? pendingModel ?? null;
  const displayModel = isNew ? (newSessionModel ?? newSessionDefaultModel) : currentModel;

  const sessionStats = useMemo(() => {
    if (sessionStatsOverride) return sessionStatsOverride;
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    let cost = 0;
    let userMessages = 0;
    let assistantMessages = 0;
    let toolResults = 0;
    let toolCalls = 0;
    for (const msg of messages) {
      if (msg.role === "user") userMessages += 1;
      if (msg.role === "toolResult") toolResults += 1;
      if (msg.role !== "assistant") continue;
      assistantMessages += 1;
      const u = (msg as import("@/lib/types").AssistantMessage).usage;
      toolCalls += (msg as import("@/lib/types").AssistantMessage).content.filter((c) => c.type === "toolCall").length;
      if (!u) continue;
      tokens.input += u.input ?? 0;
      tokens.output += u.output ?? 0;
      tokens.cacheRead += u.cacheRead ?? 0;
      tokens.cacheWrite += u.cacheWrite ?? 0;
      cost += u.cost?.total ?? 0;
    }
    tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
    if (tokens.total === 0 && messages.length === 0) return null;
    return {
      sessionFile: data?.filePath || undefined,
      sessionId: sessionIdRef.current ?? session?.id ?? "",
      sessionName: session?.name,
      userMessages,
      assistantMessages,
      toolCalls,
      toolResults,
      totalMessages: messages.length,
      tokens,
      cost,
      ...(contextUsage ? { contextUsage } : {}),
    } satisfies SessionStatsInfo;
  }, [messages, sessionStatsOverride, contextUsage, data?.filePath, session?.id, session?.name]);

  const loadSession = useCallback(async (sid: string, showLoading = false, includeState = false) => {
    let messagesLoaded = false;
    try {
      if (showLoading) setLoading(true);
      const params = new URLSearchParams({ deferThinking: "1", deferMedia: "1" });
      const res = await fetch(`/api/sessions/${encodeURIComponent(sid)}?${params}`);
      if (res.status === 404) {
        if (showLoading) {
          setData(null);
          setActiveLeafId(null);
          setMessages([]);
          setError(null);
        }
        return null;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json() as SessionData;
      if (sessionIdRef.current !== sid) return null;
      setData(d);
      setActiveLeafId(d.leafId);
      setMessages(d.context.messages);
      setSubagents((previous) => mergeRehydratedSubagents(
        previous,
        subagentsFromMessages(d.context.messages),
      ));
      setEntryIds(d.context.entryIds ?? []);
      setCurrentModelOverride(null);
      setError(null);
      if (d.context.thinkingLevel && d.context.thinkingLevel !== "off") {
        setThinkingLevel(d.context.thinkingLevel as ThinkingLevelOption);
      }

      messagesLoaded = true;
      if (showLoading) setLoading(false);
      if (!includeState) return null;

      try {
        const stateRes = await fetch(`/api/sessions/${encodeURIComponent(sid)}/state`);
        if (!stateRes.ok) throw new Error(`HTTP ${stateRes.status}`);
        const agentState = await stateRes.json() as { running: boolean; state?: AgentStateResponse };
        if (sessionIdRef.current !== sid) return null;

        const liveState = agentState.state;
        if (liveState) {
          if (liveState.contextUsage !== undefined) setContextUsage(liveState.contextUsage ?? null);
          if (liveState.systemPrompt !== undefined) setSystemPrompt(liveState.systemPrompt ?? null);
          if (liveState.thinkingLevel !== undefined) setThinkingLevel((liveState.thinkingLevel as ThinkingLevelOption) ?? "auto");
          if (liveState.extensionStatuses !== undefined) setExtensionStatuses(liveState.extensionStatuses ?? []);
          if (liveState.extensionWidgets !== undefined) setExtensionWidgets(liveState.extensionWidgets ?? []);
          if (liveState.queuedMessages !== undefined) setQueuedMessages(normalizeQueuedMessages(liveState.queuedMessages));
        } else if (!agentState.running) {
          setQueuedMessages({ steering: [], followUp: [] });
        }
        return agentState;
      } catch (e) {
        console.error("Failed to load agent state:", e);
        return null;
      }
    } catch (e) {
      setError(String(e));
      return null;
    } finally {
      if (showLoading && !messagesLoaded) setLoading(false);
    }
  }, []);

  const loadContext = useCallback(async (sid: string, leafId: string | null) => {
    try {
      const params = new URLSearchParams({ deferThinking: "1", deferMedia: "1" });
      if (leafId) params.set("leafId", leafId);
      const url = `/api/sessions/${encodeURIComponent(sid)}/context?${params}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json() as { context: { messages: AgentMessage[]; entryIds: string[] } };
      setMessages(d.context.messages);
      setSubagents((previous) => mergeRehydratedSubagents(
        previous,
        subagentsFromMessages(d.context.messages),
      ));
      setEntryIds(d.context.entryIds ?? []);
    } catch (e) {
      console.error("Failed to load context:", e);
    }
  }, []);

  const loadTools = useCallback(async (sid: string) => {
    try {
      const tools = await sendAgentCommand<ToolEntry[]>(sid, { type: "get_tools" });
      if (tools) {
        const { getPresetFromTools } = await import("@/lib/tool-presets");
        setToolPresetState(getPresetFromTools(tools));
      }
    } catch (e) {
      console.error("Failed to load tools:", e);
    }
  }, [setToolPresetState]);

  const promoteNewSession = useCallback((messageCount = 0, firstMessage = "(no messages)") => {
    const sid = sessionIdRef.current;
    if (!isNew || !newSessionCwd || !sid || newSessionPromotedRef.current) return;
    newSessionPromotedRef.current = true;
    onSessionCreated?.({
      id: sid,
      path: "",
      cwd: newSessionCwd,
      name: undefined,
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
      messageCount,
      firstMessage,
    });
  }, [isNew, newSessionCwd, onSessionCreated]);

  const ensureNewSession = useCallback(async () => {
    if (sessionIdRef.current) return sessionIdRef.current;
    if (!isNew || !newSessionCwd) return sessionIdRef.current;
    if (ensuringNewSessionRef.current) return ensuringNewSessionRef.current;

    const promise = (async () => {
      // Only send explicit user overrides. The server resolves the current
      // enabledModels scope atomically with AgentSession construction.
      const selectedModel = newSessionModelOverrideRef.current;
      const selectedThinkingLevel = thinkingLevelOverrideRef.current;
      if (selectedModel) setPendingModel(selectedModel);
      const toolNames = getToolNamesForPreset(toolPreset);
      const res = await fetch("/api/agent/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd: newSessionCwd,
          type: "ensure_session",
          toolNames,
          ...(selectedModel ? { provider: selectedModel.provider, modelId: selectedModel.modelId } : {}),
          ...(selectedThinkingLevel
            ? { thinkingLevel: selectedThinkingLevel }
            : {}),
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result = await res.json() as {
        sessionId: string;
        model?: SelectedModel | null;
        thinkingLevel?: ThinkingLevelOption;
      };
      const realId = result.sessionId;
      sessionIdRef.current = realId;
      if (result.model && newSessionModelOverrideRef.current === selectedModel) {
        setPendingModel(result.model);
        if (!selectedModel) setNewSessionDefaultModel(result.model);
      }
      if (
        result.thinkingLevel
        && thinkingLevelOverrideRef.current === selectedThinkingLevel
      ) {
        setThinkingLevel(result.thinkingLevel);
      }
      return realId;
    })();

    ensuringNewSessionRef.current = promise;
    try {
      return await promise;
    } finally {
      ensuringNewSessionRef.current = null;
    }
  }, [isNew, newSessionCwd, toolPreset]);

  const loadSlashCommands = useCallback(async () => {
    const sid = sessionIdRef.current ?? await ensureNewSession();
    if (!sid) {
      setSlashCommands([]);
      return [] as SlashCommandInfo[];
    }
    setSlashCommandsLoading(true);
    try {
      const data = await sendAgentCommand<SlashCommandsResponse>(sid, { type: "get_commands" });
      const commands = data?.commands ?? [];
      setSlashCommands(commands);
      return commands;
    } catch (e) {
      console.error("Failed to load slash commands:", e);
      setSlashCommands([]);
      return [] as SlashCommandInfo[];
    } finally {
      setSlashCommandsLoading(false);
    }
  }, [ensureNewSession]);

  const cancelEventStreamGrace = useCallback(() => {
    eventStreamGraceGenerationRef.current += 1;
    eventStreamGraceActiveRef.current = false;
    if (eventStreamGraceTimerRef.current) {
      clearTimeout(eventStreamGraceTimerRef.current);
      eventStreamGraceTimerRef.current = null;
    }
  }, []);

  const closeEvents = useCallback(() => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    eventSourceSessionIdRef.current = null;
    eventConnectionAttemptRef.current = null;
  }, []);

  const connectEvents = useCallback((sid: string): Promise<EventStreamConnectionResult> => {
    closeEvents();
    const es = new EventSource(`/api/agent/${encodeURIComponent(sid)}/events`);
    eventSourceRef.current = es;
    eventSourceSessionIdRef.current = sid;

    const promise = new Promise<EventStreamConnectionResult>((resolve) => {
      let settled = false;
      const settle = (status: EventStreamConnectionStatus) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (eventConnectionAttemptRef.current?.source === es) {
          eventConnectionAttemptRef.current.pending = false;
        }
        resolve({ status, source: es });
      };
      const timeout = setTimeout(() => settle("timeout"), EVENT_STREAM_CONNECT_TIMEOUT_MS);

      es.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data) as AgentEvent;
          if (event.type === "connected") settle("connected");
          handleAgentEventRef.current?.(event);
        } catch {
          // ignore
        }
      };
      es.onerror = () => {
        if (es.readyState === EventSource.CLOSED) {
          // Fatal error (404/500/content-type mismatch): browser won't
          // auto-reconnect. Settle the Promise and manually reconnect for
          // already-running sessions or an active idle grace window.
          settle("closed");
          if (eventSourceRef.current === es && (agentRunningRef.current || eventStreamGraceActiveRef.current)) {
            eventSourceRef.current = null;
            eventSourceSessionIdRef.current = null;
            eventConnectionAttemptRef.current = null;
            const reconnectGeneration = eventStreamGraceGenerationRef.current;
            setTimeout(() => {
              if (
                reconnectGeneration === eventStreamGraceGenerationRef.current
                && !eventSourceRef.current
                && (agentRunningRef.current || eventStreamGraceActiveRef.current)
              ) {
                void connectEvents(sid);
              }
            }, 1000);
          }
        }
        // Recoverable errors (CONNECTING): let EventSource auto-reconnect.
        // The timeout above resolves only to let callers decide whether this
        // connection must be ready before they continue.
      };
    });
    eventConnectionAttemptRef.current = { source: es, promise, pending: true };
    return promise;
  }, [closeEvents]);

  const ensureEventsConnected = useCallback(async (sid: string) => {
    const current = eventSourceRef.current;
    if (current && eventSourceSessionIdRef.current === sid) {
      if (current.readyState === EventSource.OPEN) return;
      const attempt = eventConnectionAttemptRef.current;
      if (attempt?.source === current && attempt.pending) {
        await attempt.promise;
        if (eventSourceRef.current === current && current.readyState === EventSource.OPEN) return;
      }
    }

    const result = await connectEvents(sid);
    if (result.status === "connected" || result.source.readyState === EventSource.OPEN) return;
    if (eventSourceRef.current === result.source) eventSourceRef.current = null;
    if (eventSourceSessionIdRef.current === sid) eventSourceSessionIdRef.current = null;
    if (eventConnectionAttemptRef.current?.source === result.source) eventConnectionAttemptRef.current = null;
    result.source.close();
    throw new EventStreamConnectionError(result.status);
  }, [connectEvents]);

  const respondToExtensionUi = useCallback(async (
    request: ExtensionUiDialogRequest,
    response: { value: string } | { confirmed: boolean } | { cancelled: true },
  ) => {
    const sid = sessionIdRef.current;
    setExtensionDialog((current) => current?.id === request.id ? null : current);
    if (!sid) return;
    try {
      await sendAgentCommand(sid, {
        type: "extension_ui_response",
        id: request.id,
        ...response,
      });
    } catch (e) {
      console.error("Failed to send extension UI response:", e);
    }
  }, []);

  const sendExtensionCustomInput = useCallback(async (request: ExtensionUiCustomRequest, data: string) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, {
        type: "extension_ui_input",
        id: request.id,
        data,
      });
    } catch (e) {
      console.error("Failed to send extension custom UI input:", e);
    }
  }, []);

  const addNotice = useCallback((notice: { id?: string; message: string; type?: NoticeType }) => {
    const message = notice.message.trim();
    if (!message) return;
    dispatchNotice({
      type: "add",
      notice: {
        id: notice.id ?? createNoticeId(),
        message,
        type: notice.type ?? "info",
      },
    });
  }, []);

  const handleExtensionUiRequest = useCallback((request: ExtensionUiRequest) => {
    switch (request.method) {
      case "select":
      case "confirm":
      case "input":
      case "editor":
        setExtensionDialog(request);
        break;
      case "notify": {
        addNotice({
          id: request.id,
          message: request.message,
          type: request.notifyType ?? "info",
        });
        break;
      }
      case "setStatus":
        setExtensionStatuses((prev) => {
          const rest = prev.filter((item) => item.key !== request.statusKey);
          return request.statusText !== undefined
            ? [...rest, { key: request.statusKey, text: request.statusText }]
            : rest;
        });
        break;
      case "setWidget":
        setExtensionWidgets((prev) => {
          const rest = prev.filter((item) => item.key !== request.widgetKey);
          return request.widgetLines
            ? [...rest, {
                key: request.widgetKey,
                lines: request.widgetLines,
                placement: request.widgetPlacement ?? "aboveEditor",
              }]
            : rest;
        });
        break;
      case "setTitle":
        if (request.title) document.title = request.title;
        break;
      case "set_editor_text":
        opts.chatInputRef?.current?.insertText(request.text);
        break;
      case "custom":
        setExtensionCustomUi((current) => {
          if (request.closed) return current?.id === request.id ? null : current;
          return request;
        });
        break;
    }
  }, [addNotice, opts.chatInputRef]);

  const settleUiStage = useCallback(() => {
    const wasRunning = agentRunningRef.current;
    agentRunningRef.current = false;
    setAgentRunning(false);
    setAgentPhase(null);
    setRetryInfo(null);
    dispatch({ type: "end" });
    return wasRunning;
  }, []);

  const notifyPromptStage = useCallback((runId: number) => {
    if (notifiedPromptRunIdRef.current === runId) return false;
    notifiedPromptRunIdRef.current = runId;
    onAgentEnd?.();
    return true;
  }, [onAgentEnd]);

  /**
   * Surfaces a run's terminal outcome once (for external notifications). The
   * first terminal event for a run id wins, so an error followed by an
   * auto-retry success does not fire twice. The prompt text/start-time come
   * from refs captured at send time.
   */
  const firePromptFinished = useCallback(
    (runId: number, status: "success" | "failed", errorMessage?: string | null) => {
      if (notifiedRunFinishedRef.current === runId) return;
      notifiedRunFinishedRef.current = runId;
      onPromptFinished?.({
        runId,
        status,
        sessionId: sessionIdRef.current,
        userPrompt: currentRunPromptRef.current,
        startedAt: currentRunStartedAtRef.current,
        finishedAt: Date.now(),
        errorMessage,
      });
    },
    [onPromptFinished],
  );

  const scheduleEventStreamClose = useCallback((sid: string) => {
    cancelEventStreamGrace();
    eventStreamGraceActiveRef.current = true;
    const generation = eventStreamGraceGenerationRef.current;

    const checkServerIdle = async () => {
      if (
        generation !== eventStreamGraceGenerationRef.current
        || sessionIdRef.current !== sid
        || !eventStreamGraceActiveRef.current
      ) return;

      // Detached subagents can outlive the ordinary idle grace. Their
      // completion notifier starts a new agent turn from the extension, so the
      // browser must remain subscribed to observe agent_start and the response.
      if (
        subagentsRunningRef.current
        || Date.now() < subagentWakeGraceUntilRef.current
      ) {
        eventStreamGraceTimerRef.current = setTimeout(
          () => void checkServerIdle(),
          PROMPT_SETTLE_POLL_MS,
        );
        return;
      }

      try {
        const res = await fetch(`/api/agent/${encodeURIComponent(sid)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as { running?: boolean; state?: AgentStateResponse };
        if (
          generation !== eventStreamGraceGenerationRef.current
          || sessionIdRef.current !== sid
          || !eventStreamGraceActiveRef.current
        ) return;

        const state = data.state;
        const promptActive = Boolean(data.running && state && (state.isStreaming || state.isPromptRunning));
        if (promptActive) {
          eventStreamGraceActiveRef.current = false;
          eventStreamGraceTimerRef.current = null;
          sdkAgentActiveRef.current = Boolean(state?.isStreaming);
          rpcPromptPendingRef.current = Boolean(state?.isPromptRunning);
          agentRunningRef.current = true;
          setAgentRunning(true);
          setAgentPhase(state?.isStreaming ? { kind: "waiting_model" } : { kind: "running_command" });
          return;
        }

        if (data.running && state?.isCompacting) {
          setIsCompacting(true);
          eventStreamGraceTimerRef.current = setTimeout(() => void checkServerIdle(), PROMPT_SETTLE_POLL_MS);
          return;
        }

        eventStreamGraceActiveRef.current = false;
        eventStreamGraceTimerRef.current = null;
        closeEvents();
      } catch {
        // Keep the stream alive while state cannot be verified.
        if (
          generation !== eventStreamGraceGenerationRef.current
          || sessionIdRef.current !== sid
          || !eventStreamGraceActiveRef.current
        ) return;
        eventStreamGraceTimerRef.current = setTimeout(() => void checkServerIdle(), PROMPT_SETTLE_POLL_MS);
      }
    };

    eventStreamGraceTimerRef.current = setTimeout(() => void checkServerIdle(), EVENT_STREAM_IDLE_GRACE_MS);
  }, [cancelEventStreamGrace, closeEvents]);

  const finishPromptWithoutStream = useCallback(async (sid: string | null = sessionIdRef.current, runId = promptRunIdRef.current) => {
    // Bail out before loadSession too: a stale finish for a previous run
    // must not overwrite the messages of the run currently streaming.
    if (promptRunIdRef.current !== runId) return;
    try {
      if (sid) await loadSession(sid);
    } finally {
      if (promptRunIdRef.current !== runId) return;
      const promptWasPending = rpcPromptPendingRef.current;
      const agentWasActive = sdkAgentActiveRef.current;
      rpcPromptPendingRef.current = false;
      sdkAgentActiveRef.current = false;
      optimisticUserMessageKeyRef.current = null;
      const wasRunning = settleUiStage();
      if (promptWasPending) {
        notifyPromptStage(runId);
      } else if (agentWasActive && wasRunning) {
        onAgentEnd?.();
      }
      if (sid) scheduleEventStreamClose(sid);
    }
  }, [loadSession, notifyPromptStage, onAgentEnd, scheduleEventStreamClose, settleUiStage]);

  const waitForPromptSettlement = useCallback(async (sid: string, runId?: number) => {
    await delay(PROMPT_SETTLE_INITIAL_DELAY_MS);
    const startedAt = Date.now();

    while (agentRunningRef.current && Date.now() - startedAt < PROMPT_SETTLE_MAX_MS) {
      if (runId !== undefined && promptRunIdRef.current !== runId) return;
      try {
        const res = await fetch(`/api/agent/${encodeURIComponent(sid)}`);
        if (res.ok) {
          const data = await res.json() as { running?: boolean; state?: AgentStateResponse };
          const state = data.state;
          if (!data.running || !state || (!state.isStreaming && !state.isPromptRunning)) {
            await finishPromptWithoutStream(sid, runId);
            return;
          }
        }
      } catch {
        // SSE remains the primary completion path.
      }
      await delay(PROMPT_SETTLE_POLL_MS);
    }
  }, [finishPromptWithoutStream]);

  const waitForBashSettlement = useCallback(async (sid: string) => {
    const recoveryId = bashRecoveryIdRef.current + 1;
    bashRecoveryIdRef.current = recoveryId;

    while (
      bashRunningRef.current
      && bashRecoveryIdRef.current === recoveryId
      && sessionIdRef.current === sid
    ) {
      await delay(BASH_STATE_RECONCILE_MS);
      try {
        const res = await fetch(`/api/agent/${encodeURIComponent(sid)}`);
        if (!res.ok) continue;
        const data = await res.json() as { state?: AgentStateResponse };
        if (data.state?.isBashRunning) continue;

        await loadSession(sid);
        if (bashRecoveryIdRef.current !== recoveryId || sessionIdRef.current !== sid) return;
        bashRunningRef.current = false;
        setBashRunning(false);
        setPendingBash(null);
        return;
      } catch {
        // Keep polling while the page is mounted; network recovery is transparent.
      }
    }
  }, [loadSession]);

  // Reconcile client streaming state with the server. When SSE events are
  // missed (network drop, mobile tab backgrounded, half-open connection),
  // agent_end never arrives and the UI stays in streaming state forever.
  // If the server reports idle while we still think it's running, finish
  // through the same settlement path used by non-streaming prompts.
  const reconcileAgentState = useCallback(async (sid: string) => {
    if (!agentRunningRef.current) return;
    const runId = promptRunIdRef.current;
    try {
      const res = await fetch(`/api/agent/${encodeURIComponent(sid)}`);
      if (!res.ok) return;
      const data = await res.json() as { running?: boolean; state?: AgentStateResponse };
      // A slow response can straddle a run boundary (previous run finished
      // and the user already started the next one while this request was in
      // flight) — everything in it is stale, drop it.
      if (promptRunIdRef.current !== runId) return;
      const state = data.state;
      // Mirror compaction state unconditionally: a missed compaction_end
      // would otherwise leave the "Stop compaction" UI stuck. No state
      // (wrapper destroyed) means nothing is compacting.
      setIsCompacting(state?.isCompacting ?? false);
      setQueuedMessages(normalizeQueuedMessages(state?.queuedMessages));
      const busy = data.running && state
        && (state.isStreaming || state.isPromptRunning || state.isCompacting);
      if (busy || !agentRunningRef.current) return;
      if (state) {
        if (state.contextUsage !== undefined) setContextUsage(state.contextUsage ?? null);
        if (state.systemPrompt !== undefined) setSystemPrompt(state.systemPrompt ?? null);
        if (state.extensionStatuses !== undefined) setExtensionStatuses(state.extensionStatuses ?? []);
        if (state.extensionWidgets !== undefined) setExtensionWidgets(state.extensionWidgets ?? []);
      }
      await finishPromptWithoutStream(sid, runId);
    } catch {
      // Network still down — the next poll / visibility / online tick retries.
    }
  }, [finishPromptWithoutStream]);

  // Recovery net for missed SSE events: while the agent is running, verify
  // against the server periodically and whenever the tab returns to the
  // foreground or the network comes back.
  useEffect(() => {
    if (!agentRunning) return;
    const reconcile = () => {
      // Read the ref on every tick: for brand-new sessions the id is
      // assigned only after ensure_session returns.
      const sid = sessionIdRef.current;
      if (sid) void reconcileAgentState(sid);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") reconcile();
    };
    const interval = setInterval(reconcile, AGENT_STATE_RECONCILE_MS);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", reconcile);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", reconcile);
    };
  }, [agentRunning, reconcileAgentState]);

  useEffect(() => {
    agentRunningRef.current = agentRunning;
  }, [agentRunning]);

  const handleAgentEvent = useCallback((event: AgentEvent) => {
    switch (event.type) {
      case "agent_start":
        cancelEventStreamGrace();
        sdkAgentActiveRef.current = true;
        agentRunningRef.current = true;
        setAgentRunning(true);
        setAgentPhase({ kind: "waiting_model" });
        dispatch({ type: "start" });
        break;
      case "agent_end":
        // One logical prompt can emit multiple agent_end events before retrying,
        // compacting, or continuing messages queued by extension handlers.
        // Keep the stream open until prompt_done/agent_settled and the idle grace.
        if (!agentRunningRef.current) break;
        setAgentPhase(null);
        setRetryInfo(null);
        dispatch({ type: "end" });
        if (sessionIdRef.current) {
          loadSession(sessionIdRef.current);
          fetch(`/api/agent/${encodeURIComponent(sessionIdRef.current)}`)
            .then((r) => r.json())
            .then((d: { state?: AgentStateResponse }) => {
              if (d.state?.contextUsage !== undefined) setContextUsage(d.state.contextUsage ?? null);
              if (d.state?.systemPrompt !== undefined) setSystemPrompt(d.state.systemPrompt ?? null);
              if (d.state?.extensionStatuses !== undefined) setExtensionStatuses(d.state.extensionStatuses ?? []);
              if (d.state?.extensionWidgets !== undefined) setExtensionWidgets(d.state.extensionWidgets ?? []);
              // Aborted turns can leave messages queued in pi (delivered with the
              // next turn); dead wrapper (no state) means the queue is gone.
              setQueuedMessages(normalizeQueuedMessages(d.state?.queuedMessages));
            })
            .catch(() => {});
        }
        break;
      case "agent_settled": {
        const agentWasActive = sdkAgentActiveRef.current;
        sdkAgentActiveRef.current = false;
        if (!agentWasActive || rpcPromptPendingRef.current) break;

        const sid = sessionIdRef.current;
        const wasRunning = settleUiStage();
        setIsCompacting(false);
        if (sid) {
          void loadSession(sid);
          scheduleEventStreamClose(sid);
        }
        if (wasRunning) onAgentEnd?.();
        break;
      }
      case "prompt_done":
        {
          const runId = promptRunIdRef.current;
          const promptWasPending = rpcPromptPendingRef.current;
          rpcPromptPendingRef.current = false;
          optimisticUserMessageKeyRef.current = null;
          const firstNotification = notifyPromptStage(runId);
          firePromptFinished(runId, "success");
          if (!promptWasPending && !firstNotification) break;

          const sid = sessionIdRef.current;
          if (sid) void loadSession(sid);
          // An extension-injected agent may already have started before the
          // command's prompt_done. Keep that active stage visible and let its
          // agent_settled event perform the next completion transition.
          if (!sdkAgentActiveRef.current) {
            settleUiStage();
            if (sid) scheduleEventStreamClose(sid);
          }
        }
        break;
      case "prompt_error":
        firePromptFinished(promptRunIdRef.current, "failed", (event.errorMessage as string | undefined) ?? "Command failed");
        addNotice({ type: "error", message: (event.errorMessage as string | undefined) ?? "Command failed" });
        break;
      case "extension_error":
        addNotice({
          type: "error",
          message: (event.error as string | undefined) ?? "Extension command failed",
        });
        break;
      case "message_start":
      case "message_update": {
        // Ignore streaming events arriving after this run already finished
        // (e.g. SSE data buffered while the tab was frozen, flushed after
        // reconcile) — they would resurrect a ghost streaming bubble.
        if (!agentRunningRef.current) break;
        const msg = event.message as Partial<AgentMessage> | undefined;
        if (msg?.role === "user") {
          break;
        }
        if (msg) {
          dispatch({ type: "update", message: normalizeToolCalls(msg as AgentMessage) });
        }
        setAgentPhase(null);
        // Live-follow the streaming output only when the user is already near
        // the bottom of the message list. If they scrolled up, leave them there.
        if (!pendingScrollToUserRef.current && isNearBottomRef.current && liveFollowFrameRef.current === null) {
          // Defer the scroll so React has time to update the DOM with the new
          // streaming content; otherwise scrollIntoView may target stale layout.
          liveFollowFrameRef.current = requestAnimationFrame(() => {
            liveFollowFrameRef.current = null;
            if (isNearBottomRef.current) scrollToBottom("auto");
          });
        }
        break;
      }
      case "message_end": {
        // Same late-event guard: after reconcile finished this run,
        // loadSession already loaded this message from the session file —
        // appending it again would duplicate it.
        if (!agentRunningRef.current) break;
        const completed = event.message as AgentMessage | undefined;
        if (completed && completed.role === "user") {
          // Delivered steering/follow-up messages surface here as user
          // messages. The run's initial prompt also emits one, but handleSend
          // already appended it optimistically. Consume only the still-adjacent
          // optimistic bubble; later same-text queue deliveries must render.
          const delivered = normalizeToolCalls(completed);
          const deliveredKey = userMessageKey(delivered);
          const optimisticKey = optimisticUserMessageKeyRef.current;
          optimisticUserMessageKeyRef.current = null;
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (optimisticKey && last?.role === "user" && userMessageKey(last) === optimisticKey) {
              return optimisticKey === deliveredKey
                ? prev
                : [...prev.slice(0, -1), delivered];
            }
            return [...prev, delivered];
          });
        } else if (completed) {
          setMessages((prev) => [...prev, normalizeToolCalls(completed)]);
        }
        dispatch({ type: "reset" });
        setAgentPhase({ kind: "waiting_model" });
        break;
      }
      case "tool_execution_start": {
        const id = event.toolCallId as string;
        const name = event.toolName as string;
        setAgentPhase((prev) => {
          const tools = prev?.kind === "running_tools" ? [...prev.tools] : [];
          if (!tools.some((t) => t.id === id)) tools.push({ id, name });
          return { kind: "running_tools", tools };
        });
        if (name === "subagent") {
          const args = (event as { args?: unknown }).args as Record<string, unknown> | undefined;
          // Management/control calls (action: "list", "get", "interrupt", …)
          // are not delegations — never spawn the panel for them.
          if (args && typeof args.action === "string") break;
          const children = buildSubagentChildren(args);
          if (children.length === 0) break;
          const task =
            typeof args?.task === "string"
              ? args.task
              : typeof args?.workflowScript === "string"
                ? args.workflowScript.slice(0, 140)
                : undefined;
          setSubagents((prev) => {
            const list = prev.filter((d) => d.toolCallId !== id);
            list.unshift({ toolCallId: id, task, running: true, children });
            return list.slice(0, 20);
          });
        }
        break;
      }
      case "subagent_update": {
        const callId = (event as { toolCallId?: unknown }).toolCallId as string | undefined;
        if (!callId) break;
        const partial = (event as { partialResult?: unknown }).partialResult as
          | {
              content?: Array<{ type?: string; text?: string }>;
              details?: { progress?: Array<Record<string, unknown>>; results?: Array<Record<string, unknown>> };
            }
          | string
          | undefined;
        setSubagents((prev) =>
          prev.map((d) => {
            if (d.toolCallId !== callId) return d;
            // Snapshot text output lives in content[].text — always capture it.
            const contentText =
              cleanSubagentOutput(
                typeof partial === "string"
                  ? partial
                  : (partial?.content ?? [])
                      .filter((b) => b?.type === "text" && b.text)
                      .map((b) => b.text ?? "")
                      .join("\n")
                      .trim(),
              ) ?? "";
            const progress = typeof partial === "object" ? partial?.details?.progress ?? [] : [];
            if (progress.length === 0) {
              if (!contentText) return d;
              const lines = contentText.split("\n");
              return {
                ...d,
                children: d.children.map((c) => ({
                  ...c,
                  recentOutput: lines[lines.length - 1]?.slice(0, 500),
                  recentOutputLines: lines.slice(-10),
                })),
              };
            }
            const results = typeof partial === "object" ? partial.details?.results ?? [] : [];
            const children: SubagentChild[] = progress.map((p) => {
              const agent = typeof p.agent === "string" ? p.agent : "agent";
              const existing = d.children.find((c) => c.agent === agent);
              const result = results.find((r) => r.agent === p.agent);
              const output = contentText ||
                (Array.isArray(p.recentOutput)
                  ? (p.recentOutput[p.recentOutput.length - 1] as string | undefined)
                  : undefined);
              const outputLines = contentText
                ? contentText.split("\n").slice(-10)
                : Array.isArray(p.recentOutput)
                  ? (p.recentOutput as string[]).slice(-10)
                  : existing?.recentOutputLines;
              const recentTools = Array.isArray(p.recentTools)
                ? (p.recentTools as Array<Record<string, unknown>>).slice(-6).map((t) => ({
                    tool: typeof t.tool === "string" ? t.tool : "tool",
                    args: typeof t.args === "string" ? t.args : undefined,
                  }))
                : existing?.recentTools;
              const thinking = typeof p.thinking === "string" ? p.thinking : existing?.thinking;
              return {
                agent,
                task:
                  (typeof result?.task === "string" ? result.task : undefined) ??
                  existing?.task ??
                  d.task,
                status: typeof p.status === "string" ? p.status : existing?.status ?? "running",
                currentTool: typeof p.currentTool === "string" ? p.currentTool : existing?.currentTool,
                currentToolArgs:
                  typeof p.currentToolArgs === "string" ? p.currentToolArgs : existing?.currentToolArgs,
                recentOutput: output ?? existing?.recentOutput,
                recentOutputLines: outputLines ?? existing?.recentOutputLines,
                recentTools: recentTools ?? existing?.recentTools,
                thinking,
                toolCount: typeof p.toolCount === "number" ? p.toolCount : existing?.toolCount,
                tokens: typeof p.tokens === "number" ? p.tokens : existing?.tokens,
                model: typeof p.model === "string" ? p.model : existing?.model,
                durationMs: typeof p.durationMs === "number" ? p.durationMs : existing?.durationMs,
                activityState:
                  typeof p.activityState === "string" ? p.activityState : existing?.activityState,
              };
            });
            return { ...d, task: children[0]?.task ?? d.task, children, running: true };
          }),
        );
        break;
      }
      case "tool_execution_end": {
        const id = event.toolCallId as string;
        const name = event.toolName as string;
        setAgentPhase((prev) => {
          if (prev?.kind !== "running_tools") return prev;
          const tools = prev.tools.filter((t) => t.id !== id);
          if (tools.length === 0) return { kind: "waiting_model" };
          return { kind: "running_tools", tools };
        });
        if (name === "subagent") {
          const isError = (event as { isError?: unknown }).isError === true;
          const result = (event as { result?: unknown }).result as
            | {
                content?: Array<{ type?: string; text?: string }>;
                details?: {
                  results?: Array<Record<string, unknown>>;
                  progress?: Array<Record<string, unknown>>;
                };
              }
            | string
            | undefined;
          // Final output of the delegation (what the subagent produced).
          const resultText = cleanSubagentOutput(
            typeof result === "string"
              ? result
              : (result?.content ?? [])
                  .filter((b) => b?.type === "text" && b.text)
                  .map((b) => b.text ?? "")
                  .join("\n")
                  .trim(),
          ) ?? "";
          const resultOutput = resultText ? resultText.slice(0, 500) : undefined;
          const resultOutputLines = resultText ? resultText.split("\n").slice(-10) : undefined;
          setSubagents((prev) =>
            prev.map((d) => {
              if (d.toolCallId !== id) return d;
              const details =
                typeof result === "object" && result?.details ? result.details : undefined;
              const asyncDir = typeof details?.asyncDir === "string" ? details.asyncDir : undefined;
              const runId = typeof details?.runId === "string" ? details.runId : undefined;
              const results = details?.results ?? [];
              const progress = details?.progress ?? [];
              let children: SubagentChild[];
              if (results.length > 0) {
                children = results
                  .map((r) => {
                    const agent = typeof r.agent === "string" ? r.agent : undefined;
                    if (!agent) return null;
                    const existing = d.children.find((c) => c.agent === agent);
                    const status =
                      r.exitCode === 0
                        ? "completed"
                        : r.timedOut
                          ? "timed_out"
                          : r.interrupted
                            ? "interrupted"
                            : "failed";
                    const artifactPaths = isRecord(r.artifactPaths) ? r.artifactPaths : undefined;
                    const outputReference = isRecord(r.outputReference) ? r.outputReference : undefined;
                    const progressSummary = isRecord(r.progressSummary) ? r.progressSummary : undefined;
                    const usage = isRecord(r.usage) ? r.usage : undefined;
                    const finalOutput = typeof r.finalOutput === "string" ? r.finalOutput : undefined;
                    const transcriptPath =
                      (typeof r.transcriptPath === "string" ? r.transcriptPath : undefined)
                      ?? (typeof artifactPaths?.transcriptPath === "string" ? artifactPaths.transcriptPath : undefined);
                    const sessionFile =
                      (typeof r.sessionFile === "string" ? r.sessionFile : undefined)
                      ?? (typeof artifactPaths?.sessionFile === "string" ? artifactPaths.sessionFile : undefined);
                    const outputPath =
                      (typeof r.savedOutputPath === "string" ? r.savedOutputPath : undefined)
                      ?? (typeof outputReference?.path === "string" ? outputReference.path : undefined)
                      ?? (typeof artifactPaths?.outputPath === "string" ? artifactPaths.outputPath : undefined);
                    return {
                      ...existing,
                      agent,
                      task: cleanTaskLabel(
                        typeof r.task === "string" ? r.task : existing?.task ?? d.task,
                      ),
                      status,
                      exitCode: typeof r.exitCode === "number" ? r.exitCode : existing?.exitCode,
                      recentOutput:
                        existing?.recentOutput
                        ?? finalOutput?.split("\n").find((line) => line.trim())?.slice(0, 500)
                        ?? resultOutput,
                      recentOutputLines: existing?.recentOutputLines ?? resultOutputLines,
                      finalOutput: finalOutput ?? existing?.finalOutput,
                      transcriptPath: transcriptPath ?? existing?.transcriptPath,
                      sessionFile: sessionFile ?? existing?.sessionFile,
                      outputPath: outputPath ?? existing?.outputPath,
                      toolCount:
                        typeof progressSummary?.toolCount === "number"
                          ? progressSummary.toolCount
                          : existing?.toolCount,
                      turnCount: typeof usage?.turns === "number" ? usage.turns : existing?.turnCount,
                      tokens:
                        typeof progressSummary?.tokens === "number"
                          ? progressSummary.tokens
                          : existing?.tokens,
                      model: typeof r.model === "string" ? r.model : existing?.model,
                      thinking: typeof r.thinking === "string" ? r.thinking : existing?.thinking,
                      durationMs:
                        typeof progressSummary?.durationMs === "number"
                          ? progressSummary.durationMs
                          : existing?.durationMs,
                    } as SubagentChild;
                  })
                  .filter((c): c is SubagentChild => c !== null);
              } else if (progress.length > 0) {
                // No result rows (e.g. workflowScript runs) — resolve children
                // from the final progress snapshot instead of placeholder names.
                children = progress.map((p) => {
                  const agent = typeof p.agent === "string" ? p.agent : "agent";
                  const existing = d.children.find((c) => c.agent === agent);
                  return {
                    ...existing,
                    agent,
                    task: cleanTaskLabel(existing?.task ?? d.task),
                    status: typeof p.status === "string" ? p.status : "completed",
                    currentTool:
                      typeof p.currentTool === "string" ? p.currentTool : existing?.currentTool,
                    recentOutput: existing?.recentOutput ?? resultOutput,
                    recentOutputLines: existing?.recentOutputLines ?? resultOutputLines,
                    recentTools:
                      Array.isArray(p.recentTools)
                        ? (p.recentTools as Array<Record<string, unknown>>).slice(-6).map((t) => ({
                            tool: typeof t.tool === "string" ? t.tool : "tool",
                            args: typeof t.args === "string" ? t.args : undefined,
                          }))
                        : existing?.recentTools,
                    toolCount: typeof p.toolCount === "number" ? p.toolCount : existing?.toolCount,
                    tokens: typeof p.tokens === "number" ? p.tokens : existing?.tokens,
                    model: typeof p.model === "string" ? p.model : existing?.model,
                    durationMs:
                      typeof p.durationMs === "number" ? p.durationMs : existing?.durationMs,
                  } as SubagentChild;
                });
              } else {
                children = d.children.map((c) => ({
                  ...c,
                  status: isError ? "failed" : "completed",
                  recentOutput: c.recentOutput ?? resultOutput,
                  recentOutputLines: c.recentOutputLines ?? resultOutputLines,
                }));
              }
              // Detached async runs return instantly — the tool's own end is
              // NOT the real completion. Stay running; the status.json poller
              // flips to completed when the background run actually finishes.
              const detached = Boolean(asyncDir);
              return {
                ...d,
                children: detached
                  ? children.map((c) => ({ ...c, status: "running" }))
                  : children,
                running: detached ? true : false,
                asyncDir: d.asyncDir ?? asyncDir,
                runId: d.runId ?? runId,
                transcriptSessionId:
                  d.transcriptSessionId
                  ?? children.map((child) => sessionIdFromArtifactPath(child.sessionFile)).find(Boolean),
              };
            }),
          );
        }
        break;
      }
      case "queue_update":
        setQueuedMessages({
          steering: [...((event.steering as string[] | undefined) ?? [])],
          followUp: [...((event.followUp as string[] | undefined) ?? [])],
        });
        break;
      case "auto_retry_start":
        setRetryInfo({ attempt: event.attempt as number, maxAttempts: event.maxAttempts as number, errorMessage: event.errorMessage as string | undefined });
        break;
      case "auto_retry_end":
        setRetryInfo(null);
        break;
      case "auto_compaction_start":
      case "compaction_start":
        setIsCompacting(true);
        setCompactError(null);
        setCompactResult(null);
        break;
      case "auto_compaction_end":
      case "compaction_end":
        setIsCompacting(false);
        if (event.errorMessage) {
          setCompactError(event.errorMessage as string);
          setCompactResult(null);
        } else if (!event.aborted) {
          setCompactResult(readCompactResult(event.result, (event.reason as string | undefined) ?? "auto"));
          if (sessionIdRef.current) loadSession(sessionIdRef.current);
        }
        break;
      case "extension_ui_request":
        handleExtensionUiRequest(event as ExtensionUiRequest);
        break;
    }
  }, [addNotice, cancelEventStreamGrace, firePromptFinished, handleExtensionUiRequest, loadSession, notifyPromptStage, onAgentEnd, scheduleEventStreamClose, scrollToBottom, settleUiStage]);
  handleAgentEventRef.current = handleAgentEvent;

  const handleSend = useCallback(async (message: string, images?: AttachedImage[]) => {
    const trimmedMessage = message.trim();
    if (!trimmedMessage && !images?.length) return;
    if (agentRunningRef.current || bashRunningRef.current) return;
    const isSlashCommandPrompt = !images?.length && trimmedMessage.startsWith("/");

    const isBashCommand = !images?.length && trimmedMessage.startsWith("!");
    if (isBashCommand) {
      const isExcluded = trimmedMessage.startsWith("!!");
      const bashCmd = (isExcluded ? trimmedMessage.slice(2) : trimmedMessage.slice(1)).trim();
      if (!bashCmd) return;
      await executeBashRef.current?.(bashCmd, isExcluded);
      return;
    }

    const promptRunId = promptRunIdRef.current + 1;
    cancelEventStreamGrace();
    rpcPromptPendingRef.current = true;

    const imageBlocks = images?.map((img) => ({ type: "image" as const, source: { type: "base64" as const, media_type: img.mimeType, data: img.data } }));
    const userMsg: AgentMessage = {
      role: "user",
      content: imageBlocks?.length
        ? [...(message.trim() ? [{ type: "text" as const, text: message }] : []), ...imageBlocks]
        : message,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, userMsg]);
    optimisticUserMessageKeyRef.current = userMessageKey(userMsg);
    promptRunIdRef.current = promptRunId;
    currentRunPromptRef.current = trimmedMessage || null;
    currentRunStartedAtRef.current = Date.now();
    notifiedRunFinishedRef.current = promptRunId - 1;
    agentRunningRef.current = true;
    setAgentRunning(true);
    setAgentPhase(isSlashCommandPrompt ? { kind: "running_command" } : { kind: "waiting_model" });
    dispatch({ type: "start" });
    pendingScrollToUserRef.current = true;
    setPromptAnchorActive(true);
    completionScrollAllowedRef.current = true;

    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    let sentSessionId: string | null = null;
    let promptRequestStarted = false;

    try {
      if (isNew && newSessionCwd) {
        const selectedModel = newSessionModel;
        const existingSid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
        const sid = existingSid ?? await ensureNewSession();

        if (sid) {
          sentSessionId = sid;
          if (selectedModel) {
            setPendingModel(selectedModel);
            if (existingSid) {
              await sendAgentCommand(sid, { type: "set_model", provider: selectedModel.provider, modelId: selectedModel.modelId });
            }
          }
          await ensureEventsConnected(sid);
          promptRequestStarted = true;
          await sendAgentCommand(sid, {
            type: "prompt",
            message,
            ...(piImages?.length ? { images: piImages } : {}),
          });
          promoteNewSession(1, message);
        }
      } else if (session) {
        sentSessionId = session.id;
        await ensureEventsConnected(session.id);
        promptRequestStarted = true;
        await sendAgentCommand(session.id, {
          type: "prompt",
          message,
          ...(piImages?.length ? { images: piImages } : {}),
        });
      }
      if (isSlashCommandPrompt && sentSessionId) {
        void waitForPromptSettlement(sentSessionId, promptRunId);
      }
    } catch (e) {
      console.error("Failed to send message:", e);
      // A failed prompt POST is ambiguous: the server may have accepted it
      // before the response connection was lost. Keep SSE alive until the
      // server confirms idle so a real run cannot continue unseen.
      if (promptRequestStarted && sentSessionId) {
        void waitForPromptSettlement(sentSessionId, promptRunId);
        return;
      }
      rpcPromptPendingRef.current = false;
      agentRunningRef.current = false;
      closeEvents();
      if (e instanceof EventStreamConnectionError) {
        const optimisticKey = optimisticUserMessageKeyRef.current;
        if (optimisticKey) {
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            return last?.role === "user" && userMessageKey(last) === optimisticKey
              ? prev.slice(0, -1)
              : prev;
          });
        }
        addNotice({ type: "error", message: e.message });
        // The prompt never reached the agent, so restore the user's text into
        // the input instead of losing it. Mirrors the shell-command recovery in
        // executeBash; insertIfEmpty avoids clobbering anything typed since.
        if (message) opts.chatInputRef?.current?.insertIfEmpty(message);
      }
      optimisticUserMessageKeyRef.current = null;
      setAgentRunning(false);
      setAgentPhase(null);
      dispatch({ type: "end" });
    }
  }, [isNew, newSessionCwd, newSessionModel, session, ensureNewSession, ensureEventsConnected, promoteNewSession, waitForPromptSettlement, addNotice, cancelEventStreamGrace, closeEvents, opts.chatInputRef]);

  const executeBash = useCallback(async (command: string, excludeFromContext: boolean) => {
    if (agentRunningRef.current || bashRunningRef.current) return;
    const inputText = `${excludeFromContext ? "!!" : "!"}${command}`;
    bashRunningRef.current = true;
    setPendingBash({ command, excludeFromContext });
    setBashRunning(true);
    try {
      const sid = sessionIdRef.current ?? session?.id ?? await ensureNewSession();
      if (!sid) throw new Error("Unable to create a session for the shell command");
      await sendAgentCommand(sid, {
        type: "bash",
        command,
        excludeFromContext,
      });
      await loadSession(sid);
      promoteNewSession(1, inputText);
    } catch (e) {
      console.error("Failed to execute shell command:", e);
      addNotice({ type: "error", message: e instanceof Error ? e.message : String(e) });
      opts.chatInputRef?.current?.insertIfEmpty(inputText);
    } finally {
      bashRunningRef.current = false;
      setPendingBash(null);
      setBashRunning(false);
    }
  }, [addNotice, ensureNewSession, loadSession, opts.chatInputRef, promoteNewSession, session]);
  executeBashRef.current = executeBash;

  const handleAbort = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    if (bashRunningRef.current) {
      try {
        await sendAgentCommand(sid, { type: "abort_bash" });
      } catch (e) {
        console.error("Failed to abort bash:", e);
      }
      return;
    }
    try {
      await sendAgentCommand(sid, { type: "abort" });
    } catch (e) {
      console.error("Failed to abort:", e);
    }
  }, []);

  const handleFork = useCallback(async (entryId: string) => {
    if (bashRunningRef.current) return;
    const sid = sessionIdRef.current;
    if (!sid) return;
    setForkingEntryId(entryId);
    try {
      const result = await sendAgentCommand<{ cancelled?: boolean; newSessionId?: string }>(sid, {
        type: "fork",
        entryId,
      });
      const { cancelled, newSessionId } = result ?? {};
      if (!cancelled && newSessionId) {
        onSessionForked?.(newSessionId);
      }
    } catch (e) {
      console.error("Fork failed:", e);
    } finally {
      setForkingEntryId(null);
    }
  }, [onSessionForked]);

  const handleNavigate = useCallback(async (entryId: string) => {
    if (bashRunningRef.current) return;
    const sid = sessionIdRef.current;
    if (!sid) return;
    sendAgentCommand(sid, { type: "navigate_tree", targetId: entryId }).catch(() => {});
    setActiveLeafId(entryId);
    await loadContext(sid, entryId);
  }, [loadContext]);

  const handleLeafChange = useCallback(async (leafId: string | null) => {
    if (bashRunningRef.current) return;
    setActiveLeafId(leafId);
    const sid = sessionIdRef.current;
    if (!sid) return;
    await loadContext(sid, leafId);
    if (leafId) {
      sendAgentCommand(sid, { type: "navigate_tree", targetId: leafId }).catch(() => {});
    }
  }, [loadContext]);

  const handleModelChange = useCallback(async (provider: string, modelId: string) => {
    if (isNew) {
      const selectedModel = { provider, modelId };
      newSessionModelOverrideRef.current = selectedModel;
      setNewSessionModel(selectedModel);
      setPendingModel(selectedModel);
      const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
      if (!sid) return;
      try {
        await sendAgentCommand(sid, { type: "set_model", provider, modelId });
      } catch (e) {
        console.error("Failed to set model:", e);
      }
      return;
    }
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "set_model", provider, modelId });
      setCurrentModelOverride({ provider, modelId });
    } catch (e) {
      console.error("Failed to set model:", e);
    }
  }, [isNew, setNewSessionModel]);

  const handleCompact = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid || isCompacting) return;
    setIsCompacting(true);
    setCompactError(null);
    setCompactResult(null);
    try {
      const result = await sendAgentCommand<CompactCommandResult>(sid, { type: "compact" });
      setCompactResult(readCompactResult(result, "manual"));
      await loadSession(sid, true);
    } catch (e) {
      setCompactError(e instanceof Error ? e.message : String(e));
      setCompactResult(null);
    } finally {
      setIsCompacting(false);
    }
  }, [isCompacting, loadSession]);

  const loadModels = useCallback(async (signal?: AbortSignal) => {
    const modelCwd = newSessionCwd ?? session?.cwd ?? "";
    const modelsUrl = modelCwd ? `/api/models?cwd=${encodeURIComponent(modelCwd)}` : "/api/models";
    const res = await fetch(modelsUrl, signal ? { signal } : undefined);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json() as ModelsResponse;
    setModelNames(d.models);
    setModelError(d.modelError ?? null);
    setModelScopeWarnings(d.modelScopeWarnings ?? []);
    setModelThinkingLevels(d.thinkingLevels ?? {});
    setModelThinkingLevelMaps(d.thinkingLevelMaps ?? {});
    const nextModelList = d.modelList ?? [];
    setModelList(nextModelList);
    if (isNew && !sessionIdRef.current) {
      const match = d.defaultModel
        ? nextModelList.find((m) => m.id === d.defaultModel?.modelId && m.provider === d.defaultModel?.provider)
        : undefined;
      const displayModel = match ?? nextModelList[0];
      setNewSessionDefaultModel(displayModel ? { provider: displayModel.provider, modelId: displayModel.id } : null);
      // An `enabledModels` pattern may pin a thinking level (`anthropic/*:high`).
      // Like pi, apply it to the model a new session starts with.
      const pinned = displayModel && d.thinkingLevelPins?.[`${displayModel.provider}/${displayModel.id}`];
      if (thinkingLevelOverrideRef.current === null) {
        setThinkingLevel((pinned as ThinkingLevelOption | undefined) ?? "auto");
      }
    }
  }, [isNew, newSessionCwd, session?.cwd]);

  const handleBuiltinSlashCommand = useCallback(async (text: string): Promise<BuiltinSlashCommandResult> => {
    if (!text.startsWith("/")) return { handled: false };
    const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
    if (!match) return { handled: false };

    const [, commandName, rawArgs = ""] = match;
    const args = rawArgs.trim();
    const sid = sessionIdRef.current ?? await ensureNewSession();
    const complete = (result: BuiltinSlashCommandResult): BuiltinSlashCommandResult => {
      if (!result.handled) return result;
      if (result.error) {
        addNotice({ type: "error", message: result.error });
      } else if (result.action !== "openSessionStats") {
        addNotice({ type: "success", message: result.message ?? "Command completed" });
      }
      return result;
    };

    try {
      switch (commandName) {
        case "compact": {
          if (!sid || isCompacting) return complete({ handled: true, error: "No active session to compact" });
          setIsCompacting(true);
          setCompactError(null);
          setCompactResult(null);
          const result = await sendAgentCommand<CompactCommandResult>(sid, {
            type: "compact",
            ...(args ? { customInstructions: args } : {}),
          });
          setCompactResult(readCompactResult(result, "manual"));
          if (await loadSession(sid, true)) promoteNewSession();
          return complete({ handled: true, message: "Compacted context" });
        }

        case "reload": {
          if (!sid) return complete({ handled: true, error: "No active session to reload" });
          await sendAgentCommand(sid, { type: "reload" });
          await Promise.all([
            loadSession(sid, false, true),
            loadTools(sid),
            loadSlashCommands(),
            loadModels(),
          ]);
          return complete({ handled: true, message: "Reloaded session resources" });
        }

        case "name": {
          if (!sid) return complete({ handled: true, error: "No active session to name" });
          if (!args) return complete({ handled: true, error: "Usage: /name <name>" });
          await sendAgentCommand(sid, { type: "set_session_name", name: args });
          if (await loadSession(sid)) promoteNewSession();
          return complete({ handled: true, message: `Session renamed to ${args}` });
        }

        case "session": {
          if (!sid) return complete({ handled: true, error: "No active session" });
          const stats = await sendAgentCommand<SessionStatsInfo>(sid, { type: "get_session_stats" });
          if (stats) {
            setSessionStatsOverride(stats);
          }
          onSessionStatsPanelOpen?.();
          return complete({ handled: true, action: "openSessionStats" });
        }

        case "copy": {
          if (!sid) return complete({ handled: true, error: "No active session" });
          const data = await sendAgentCommand<LastAssistantTextResponse>(sid, { type: "get_last_assistant_text" });
          const textToCopy = data?.text ?? "";
          if (!textToCopy) return complete({ handled: true, error: "No assistant message to copy" });
          await navigator.clipboard.writeText(textToCopy);
          return complete({ handled: true, message: "Copied last assistant message" });
        }

        default:
          return { handled: false };
      }
    } catch (e) {
      return complete({ handled: true, error: e instanceof Error ? e.message : String(e) });
    } finally {
      if (commandName === "compact") setIsCompacting(false);
    }
  }, [addNotice, ensureNewSession, isCompacting, loadModels, loadSession, loadSlashCommands, loadTools, promoteNewSession, onSessionStatsPanelOpen]);

  // Queued (undelivered) messages live in the queue panel only; the chat gets
  // the real user message when pi delivers it (user message_end event). An
  // optimistic chat bubble here would duplicate the queue panel and turn into
  // a ghost message if the queue is recalled.
  const handleSteer = useCallback(async (message: string, images?: AttachedImage[]) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    try {
      await sendAgentCommand(sid, {
        type: "steer",
        message,
        ...(piImages?.length ? { images: piImages } : {}),
      });
    } catch (e) {
      console.error("Failed to steer:", e);
    }
  }, []);

  const handlePromptWithStreamingBehavior = useCallback(async (
    message: string,
    behavior: "steer" | "followUp",
    images?: AttachedImage[],
  ) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    try {
      await sendAgentCommand(sid, {
        type: "prompt",
        message,
        streamingBehavior: behavior,
        ...(piImages?.length ? { images: piImages } : {}),
      });
    } catch (e) {
      console.error("Failed to queue prompt:", e);
    }
  }, []);

  const handleFollowUp = useCallback(async (message: string, images?: AttachedImage[]) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    try {
      await sendAgentCommand(sid, {
        type: "follow_up",
        message,
        ...(piImages?.length ? { images: piImages } : {}),
      });
    } catch (e) {
      console.error("Failed to follow up:", e);
    }
  }, []);

  const handleAbortCompaction = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "abort_compaction" });
    } catch (e) {
      console.error("Failed to abort compaction:", e);
    }
  }, []);

  const handleRecallQueue = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      const result = await sendAgentCommand<{ steering?: string[]; followUp?: string[] }>(sid, { type: "clear_queue" });
      // clearQueue also emits an empty queue_update, but that only reaches us
      // while SSE is connected — clear locally so idle recalls update the UI.
      setQueuedMessages({ steering: [], followUp: [] });
      const texts = [...(result?.steering ?? []), ...(result?.followUp ?? [])];
      if (texts.length > 0) {
        opts.chatInputRef?.current?.prependText(texts.join("\n\n"));
      }
    } catch (e) {
      console.error("Failed to recall queued messages:", e);
      addNotice({ type: "error", message: "Failed to recall queued messages" });
    }
  }, [opts.chatInputRef, addNotice]);

  const handleThinkingLevelChange = useCallback(async (level: ThinkingLevelOption) => {
    setThinkingLevel(level);
    if (isNew && !sessionIdRef.current) {
      thinkingLevelOverrideRef.current = level === "auto" ? null : level;
    }
    if (level === "auto") return; // "auto" leaves pi's current setting untouched
    const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "set_thinking_level", level });
    } catch (e) {
      console.error("Failed to set thinking level:", e);
    }
  }, [isNew]);

  const handleToolPresetChange = useCallback(async (preset: "none" | "default" | "full") => {
    const toolNames = getToolNamesForPreset(preset);
    setToolPresetState(preset);
    const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "set_tools", toolNames });
    } catch (e) {
      console.error("Failed to set tools:", e);
    }
  }, [setToolPresetState]);

  const scrollUserMsgToTop = useCallback(() => {
    const container = scrollContainerRef.current;
    const el = lastUserMsgRef.current;
    if (!container || !el) return;
    const elAbsTop = el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    const targetTop = Math.min(Math.max(0, elAbsTop - 16), maxScrollTop);

    if (liveFollowFrameRef.current !== null) {
      cancelAnimationFrame(liveFollowFrameRef.current);
      liveFollowFrameRef.current = null;
    }
    // A smooth scroll reports its position after the first streaming event can
    // arrive, so update the tail state before the browser emits that event.
    isNearBottomRef.current = targetTop >= maxScrollTop - SCROLL_BOTTOM_THRESHOLD;
    ignoreProgrammaticScrollUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_IGNORE_MS;
    container.scrollTo({ top: targetTop, behavior: "smooth" });
  }, []);

  const markUserScrollIntent = useCallback((event: Event) => {
    if (event instanceof KeyboardEvent) {
      if (!SCROLL_KEYS.has(event.key)) return;
      if (event.target instanceof Element && event.target.closest("input, textarea, [contenteditable='true']")) return;
    }
    userScrollIntentUntilRef.current = Date.now() + USER_SCROLL_INTENT_MS;
  }, []);

  const handleScrollPositionChange = useCallback(() => {
    const container = scrollContainerRef.current;
    if (container) {
      const { scrollTop, clientHeight, scrollHeight } = container;
      isNearBottomRef.current = scrollTop + clientHeight >= scrollHeight - SCROLL_BOTTOM_THRESHOLD;
      if (!isNearBottomRef.current && liveFollowFrameRef.current !== null) {
        cancelAnimationFrame(liveFollowFrameRef.current);
        liveFollowFrameRef.current = null;
      }
    }
    if (!agentRunningRef.current) return;
    if (Date.now() < ignoreProgrammaticScrollUntilRef.current) return;
    if (Date.now() > userScrollIntentUntilRef.current) return;
    completionScrollAllowedRef.current = false;
  }, []);

  // Load session on mount
  useEffect(() => {
    if (session) {
      sessionIdRef.current = session.id;
      loadSession(session.id, true, true).then((agentState) => {
        if (agentState?.running) {
          loadTools(session.id);
          if (agentState.state?.isStreaming || agentState.state?.isPromptRunning) {
            sdkAgentActiveRef.current = Boolean(agentState.state.isStreaming);
            rpcPromptPendingRef.current = Boolean(agentState.state.isPromptRunning);
            agentRunningRef.current = true;
            setAgentRunning(true);
            setAgentPhase(agentState.state.isStreaming ? { kind: "waiting_model" } : { kind: "running_command" });
            dispatch({ type: "start" });
            void connectEvents(session.id);
            if (!agentState.state.isStreaming && agentState.state.isPromptRunning) {
              void waitForPromptSettlement(session.id);
            }
          }
          if (agentState.state?.isBashRunning) {
            bashRunningRef.current = true;
            setBashRunning(true);
            void waitForBashSettlement(session.id);
          }
        }
        if (agentState?.state) {
          if (agentState.state.isCompacting !== undefined) setIsCompacting(agentState.state.isCompacting);
          if (agentState.state.contextUsage !== undefined) setContextUsage(agentState.state.contextUsage ?? null);
          if (agentState.state.systemPrompt !== undefined) setSystemPrompt(agentState.state.systemPrompt ?? null);
          if (agentState.state.thinkingLevel !== undefined) setThinkingLevel((agentState.state.thinkingLevel as ThinkingLevelOption) ?? "auto");
          if (agentState.state.extensionStatuses !== undefined) setExtensionStatuses(agentState.state.extensionStatuses ?? []);
          if (agentState.state.extensionWidgets !== undefined) setExtensionWidgets(agentState.state.extensionWidgets ?? []);
          if (agentState.state.queuedMessages !== undefined) setQueuedMessages(normalizeQueuedMessages(agentState.state.queuedMessages));
        }
      });
    }
    return () => {
      if (liveFollowFrameRef.current !== null) {
        cancelAnimationFrame(liveFollowFrameRef.current);
        liveFollowFrameRef.current = null;
      }
      bashRecoveryIdRef.current += 1;
      cancelEventStreamGrace();
      closeEvents();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    onSystemPromptChange?.(systemPrompt);
  }, [systemPrompt, onSystemPromptChange]);

  useEffect(() => {
    if (!onBranchDataChange) return;
    onBranchDataChange(data?.tree ?? [], activeLeafId, handleLeafChange);
  }, [data?.tree, activeLeafId, handleLeafChange, onBranchDataChange]);

  useEffect(() => {
    window.addEventListener("keydown", markUserScrollIntent);
    window.addEventListener("pointerdown", markUserScrollIntent, { passive: true });
    return () => {
      window.removeEventListener("keydown", markUserScrollIntent);
      window.removeEventListener("pointerdown", markUserScrollIntent);
    };
  }, [markUserScrollIntent]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.addEventListener("wheel", markUserScrollIntent, { passive: true });
    container.addEventListener("touchstart", markUserScrollIntent, { passive: true });
    container.addEventListener("scroll", handleScrollPositionChange, { passive: true });
    return () => {
      container.removeEventListener("wheel", markUserScrollIntent);
      container.removeEventListener("touchstart", markUserScrollIntent);
      container.removeEventListener("scroll", handleScrollPositionChange);
    };
  }, [messages.length, loading, handleScrollPositionChange, markUserScrollIntent]);

  useEffect(() => {
    if (!agentRunning) setPromptAnchorActive(false);
  }, [agentRunning]);

  useLayoutEffect(() => {
    if (messages.length > 0) {
      if (pendingScrollToUserRef.current) {
        pendingScrollToUserRef.current = false;
        initialScrollDoneRef.current = true;
        scrollUserMsgToTop();
      } else if (!initialScrollDoneRef.current) {
        initialScrollDoneRef.current = true;
        scrollToBottom("instant");
      } else if (!agentRunningRef.current && (completionScrollAllowedRef.current || isNearBottomRef.current)) {
        scrollToBottom("smooth");
      }
    }
  }, [messages.length, agentRunning, scrollToBottom, scrollUserMsgToTop]);

  // Load model list
  useEffect(() => {
    const controller = new AbortController();
    loadModels(controller.signal).catch((e) => {
      if (e instanceof DOMException && e.name === "AbortError") return;
    });
    return () => controller.abort();
  }, [loadModels, modelsRefreshKey]);

  useEffect(() => {
    if (!compactResult) return;
    const t = setTimeout(() => setCompactResult(null), 6000);
    return () => clearTimeout(t);
  }, [compactResult]);

  useEffect(() => {
    if (noticeState.visible.length === 0) return;
    const exiting = noticeState.visible.find((notice) => notice.exiting);
    if (exiting) {
      const t = setTimeout(() => {
        dispatchNotice({ type: "remove", id: exiting.id });
      }, NOTICE_EXIT_ANIMATION_MS);
      return () => clearTimeout(t);
    }
    const oldest = noticeState.visible[0];
    if (!oldest) return;
    const t = setTimeout(() => {
      dispatchNotice({ type: "mark_oldest_exiting" });
    }, NOTICE_VISIBLE_MS);
    return () => clearTimeout(t);
  }, [noticeState.visible]);

  useEffect(() => {
    setSessionStatsOverride(null);
  }, [messages.length, contextUsage?.tokens, contextUsage?.percent, contextUsage?.contextWindow]);

  return {
    // State
    data, loading, error, activeLeafId, messages, entryIds, streamState,
    agentRunning, modelNames, modelList, modelError, modelScopeWarnings, modelThinkingLevels, modelThinkingLevelMaps, newSessionModel, toolPreset, thinkingLevel,
    retryInfo, contextUsage, systemPrompt, forkingEntryId,
    isCompacting, compactError, compactResult, currentModel, displayModel, sessionStats,
    slashCommands, slashCommandsLoading, queuedMessages,
    notices: noticeState.visible, extensionDialog, extensionCustomUi, extensionStatuses, extensionWidgets, respondToExtensionUi, sendExtensionCustomInput,
    isAutoModelSelection: isNew && newSessionModel === null,
    agentPhase,
    subagents,
    clearSubagents,
    isNew,
    promptAnchorActive,
    // Refs
    sessionIdRef, eventSourceRef, messagesEndRef, scrollContainerRef,
    lastUserMsgRef, pendingScrollToUserRef, initialScrollDoneRef,
    // Actions
    handleSend, handleAbort, handleFork, handleNavigate, handleModelChange,
    handleCompact, handleSteer, handleFollowUp, handlePromptWithStreamingBehavior, handleAbortCompaction,
    handleRecallQueue,
    handleBuiltinSlashCommand,
    handleToolPresetChange, handleThinkingLevelChange, loadTools, loadSlashCommands, setActiveLeafId, setData, setMessages,
    scrollToBottom, scrollUserMsgToTop,
    dispatch, setAgentRunning, setForkingEntryId,
    bashRunning, pendingBash,
    // Subscriptions
    handleAgentEventRef,
  };
}
