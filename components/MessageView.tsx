"use client";

import { memo, useState, useRef, useEffect, useMemo } from "react";
import { MarkdownBody } from "./MarkdownBody";
import { Collapse } from "./ui/Collapse";
import { copyText } from "@/lib/clipboard";
import { useI18n } from "@/hooks/useI18n";
import { SpeakButton } from "./SpeakButton";
import { parseCompactionSummary } from "@/lib/compaction-summary";
import { formatDuration, getAssistantErrorMessage, isEmptyThinkingBlock, modelDisplayLabel } from "@/lib/message-display";
import { buildDisplayRows, parseUnifiedPatch, type SplitDiffCell } from "@/lib/patch";
import { skillExpansionToCommand } from "@/lib/slash-display";
import type {
  AgentMessage,
  UserMessage,
  AssistantMessage,
  CustomMessage,
  ToolResultMessage,
  BashExecutionMessage,
  AssistantContentBlock,
  TextContent,
  ImageContent,
  ToolCallContent,
  ThinkingContent,
} from "@/lib/types";

const MAX_THINKING_CACHE_ENTRIES = 100;
const thinkingContentCache = new Map<string, Promise<string>>();

// Messages larger than this skip markdown rendering entirely. react-markdown +
// KaTeX + syntax highlighting on multi-hundred-KB payloads (e.g. pasted HAR or
// log dumps) freezes the browser main thread.
const MAX_MARKDOWN_CHARS = 100_000;

function formatMessageBytes(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
  if (n >= 1_000) return `${Math.round(n / 1_000)} KB`;
  return `${n} B`;
}

/**
 * MarkdownBody with an oversized-content guard: huge messages render as a
 * click-to-reveal plain-text <pre> instead of running the markdown pipeline.
 */
function SafeMarkdownBody({ children, className, ...props }: React.ComponentProps<typeof MarkdownBody>) {
  const { t } = useI18n();
  const [showRaw, setShowRaw] = useState(false);

  if (children.length <= MAX_MARKDOWN_CHARS) {
    return <MarkdownBody className={className} {...props}>{children}</MarkdownBody>;
  }
  if (!showRaw) {
    return (
      <button
        onClick={() => setShowRaw(true)}
        style={{
          display: "block",
          width: "100%",
          margin: "4px 0",
          padding: "7px 10px",
          border: "1px solid var(--border)",
          borderRadius: 6,
          background: "var(--bg-panel)",
          color: "var(--text-muted)",
          cursor: "pointer",
          fontSize: 12,
          textAlign: "left",
        }}
      >
        ⚠ {t("i18n.largeMessageReveal", { size: formatMessageBytes(children.length) })}
      </button>
    );
  }
  return (
    <div className={className} style={{ maxHeight: 420, overflow: "auto", fontSize: 12, lineHeight: 1.5 }}>
      <pre
        style={{
          margin: 0,
          padding: "8px 10px",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          fontFamily: "var(--font-mono)",
          color: "var(--text-muted)",
        }}
      >
        {children}
      </pre>
    </div>
  );
}

function loadThinkingContent(sessionId: string, entryId: string, blockIndex: number): Promise<string> {
  const key = `${sessionId}:${entryId}:${blockIndex}`;
  const cached = thinkingContentCache.get(key);
  if (cached) {
    thinkingContentCache.delete(key);
    thinkingContentCache.set(key, cached);
    return cached;
  }

  const request = fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/entries/${encodeURIComponent(entryId)}/thinking?blockIndex=${blockIndex}`,
  ).then(async (response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json() as { thinking?: unknown };
    if (typeof data.thinking !== "string") throw new Error("Invalid thinking response");
    return data.thinking;
  }).catch((error) => {
    thinkingContentCache.delete(key);
    throw error;
  });

  thinkingContentCache.set(key, request);
  if (thinkingContentCache.size > MAX_THINKING_CACHE_ENTRIES) {
    const oldestKey = thinkingContentCache.keys().next().value;
    if (oldestKey) thinkingContentCache.delete(oldestKey);
  }
  return request;
}

interface Props {
  message: AgentMessage;
  isStreaming?: boolean;
  toolResults?: Map<string, ToolResultMessage>;
  modelNames?: Record<string, string>;
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
  entryId?: string;
  onFork?: (entryId: string) => void;
  forking?: boolean;
  onNavigate?: (entryId: string) => void;
  prevAssistantEntryId?: string;
  onEditContent?: (message: UserMessage) => void;
  showTimestamp?: boolean;
  sessionId?: string;
  onOpenSession?: (sessionId: string) => void;
  /**
   * How much provenance this turn shows above itself.
   *
   * "full" is a turn standing on its own. Inside a collapsed process group the
   * group header states the model, cost and elapsed time once, so a step repeating
   * all three is noise — a ten-message group printed the same model name ten
   * times. "none" drops the line; "model" keeps just the model, for the one step
   * where it changed mid-turn and the header's single name would be a lie.
   *
   * The per-message actions (copy, read aloud) follow this: they act on a final
   * answer, not on an intermediate step.
   */
  meta?: "full" | "model" | "none";
}

function formatTime(ts?: number): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (isToday) return time;
  const date = d.toLocaleDateString([], { month: "short", day: "numeric", year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined });
  return `${date} ${time}`;
}

export function replaceUserMessageText(message: UserMessage, text: string): UserMessage {
  if (typeof message.content === "string") return { ...message, content: text };

  const content: Array<TextContent | ImageContent> = [];
  let replaced = false;
  for (const block of message.content) {
    if (block.type !== "text") {
      content.push(block);
      continue;
    }
    if (!replaced) {
      content.push({ ...block, text });
      replaced = true;
    }
  }
  if (!replaced) content.unshift({ type: "text", text });
  return { ...message, content };
}

function haveSameRelevantToolResults(
  message: AgentMessage,
  previous: Map<string, ToolResultMessage> | undefined,
  next: Map<string, ToolResultMessage> | undefined,
): boolean {
  if (previous === next || message.role !== "assistant") return true;
  for (const block of (message as AssistantMessage).content ?? []) {
    if (block.type === "toolCall" && previous?.get(block.toolCallId) !== next?.get(block.toolCallId)) {
      return false;
    }
  }
  return true;
}

export const MessageView = memo(function MessageView({ message, isStreaming, toolResults, modelNames, cwd, onOpenFile, entryId, onFork, forking, onNavigate, prevAssistantEntryId, onEditContent, showTimestamp, sessionId, onOpenSession, meta }: Props) {
  if (message.role === "user") {
    return <UserMessageView message={message as UserMessage} cwd={cwd} onOpenFile={onOpenFile} entryId={entryId} onFork={onFork} forking={forking} onNavigate={onNavigate} prevAssistantEntryId={prevAssistantEntryId} onEditContent={onEditContent} />;
  }
  if (message.role === "assistant") {
    return <AssistantMessageView message={message as AssistantMessage} isStreaming={isStreaming} toolResults={toolResults} modelNames={modelNames} cwd={cwd} onOpenFile={onOpenFile} showTimestamp={showTimestamp} sessionId={sessionId} entryId={entryId} meta={meta ?? "full"} />;
  }
  if (message.role === "toolResult") {
    // Rendered inline under its toolCall — skip standalone rendering if paired
    return null;
  }
  if (message.role === "custom") {
    if ((message as CustomMessage).customType === "compaction") {
      return <CompactionMessageView message={message as CustomMessage} />;
    }
    if ((message as CustomMessage).customType === "subagent-notify") {
      return <SubagentNotifyView message={message as CustomMessage} onOpenSession={onOpenSession} />;
    }
    return <CustomMessageView message={message as CustomMessage} cwd={cwd} onOpenFile={onOpenFile} />;
  }
  if (message.role === "bashExecution") {
    return <BashExecutionView message={message as BashExecutionMessage} sessionId={sessionId} />;
  }
  return null;
}, (prev, next) => {
  return prev.message === next.message
    && prev.isStreaming === next.isStreaming
    && haveSameRelevantToolResults(prev.message, prev.toolResults, next.toolResults)
    && prev.modelNames === next.modelNames
    && prev.cwd === next.cwd
    && prev.onOpenFile === next.onOpenFile
    && prev.entryId === next.entryId
    && prev.onFork === next.onFork
    && prev.forking === next.forking
    && prev.onNavigate === next.onNavigate
    && prev.prevAssistantEntryId === next.prevAssistantEntryId
    && prev.onEditContent === next.onEditContent
    && prev.showTimestamp === next.showTimestamp
    && prev.sessionId === next.sessionId
    && prev.meta === next.meta;
});

function UserMessageView({ message, cwd, onOpenFile, entryId, onFork, forking, onNavigate, prevAssistantEntryId, onEditContent }: {
  message: UserMessage;
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
  entryId?: string;
  onFork?: (entryId: string) => void;
  forking?: boolean;
  onNavigate?: (entryId: string) => void;
  prevAssistantEntryId?: string;
  onEditContent?: (message: UserMessage) => void;
}) {
  const { t } = useI18n();
  const [hovered, setHovered] = useState(false);
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const content =
    typeof message.content === "string"
      ? message.content
      : message.content
          .filter((b): b is TextContent => b.type === "text")
          .map((b) => b.text)
          .join("\n");

  const imageBlocks: ImageContent[] =
    typeof message.content === "string"
      ? []
      : message.content.filter((b): b is ImageContent => b.type === "image");

  const commandText = skillExpansionToCommand(content);
  const commandSeparator = commandText?.search(/\s/) ?? -1;
  const commandName = commandText
    ? commandSeparator === -1 ? commandText : commandText.slice(0, commandSeparator)
    : "";
  const commandArgs = commandText && commandSeparator !== -1
    ? commandText.slice(commandSeparator + 1)
    : "";

  const time = formatTime(message.timestamp);
  const canFork = !!entryId && !!onFork;
  const copyTarget = commandText ?? content;
  const editTarget = commandText ? replaceUserMessageText(message, commandText) : message;

  const imageBlocksNode = imageBlocks.length > 0 && (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: content ? 8 : 0 }}>
      {imageBlocks.map((img, i) => {
        // lib/types.ts ImageContent uses {source:{type,data,media_type,url}}
        // pi-ai on-disk format uses flat {data, mimeType} — handle both
        const flat = img as unknown as { data?: string; mimeType?: string };
        const src = img.source
          ? img.source.type === "base64"
            ? `data:${img.source.media_type};base64,${img.source.data}`
            : img.source.url ?? ""
          : flat.data
            ? `data:${flat.mimeType};base64,${flat.data}`
            : "";
        return (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={i}
            src={src}
            alt=""
            style={{ maxWidth: 240, maxHeight: 240, borderRadius: 6, objectFit: "contain", display: "block", border: "1px solid rgba(59,130,246,0.15)" }}
          />
        );
      })}
    </div>
  );
  const canNavigate = !!prevAssistantEntryId && !!onNavigate;

  const copyContent = () => {
    copyText(copyTarget).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div
      style={{ marginBottom: "var(--sp-7)" }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Timestamp as a right-aligned caption over the bubble, matching the
          assistant turn's meta line. The shared two-column grid is gone. */}
      {time && <div className="turn-meta turn-meta--end">{time}</div>}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 6, maxWidth: "85%" }}>
        <div
          style={{
            flex: 1,
            minWidth: 0,
            background: "var(--user-bg)",
            // Was a stale rgba(59,130,246,.2) blue that would have survived the
            // retune. Your own messages are not an accent state, so they take a
            // neutral edge and let the surface tint carry the distinction.
            border: "1px solid color-mix(in srgb, var(--border) 85%, transparent)",
            borderRadius: 16,
            padding: "10px 14px",
            fontSize: "var(--fs-body)",
            lineHeight: 1.6,
            color: "var(--text)",
            wordBreak: "break-word",
          }}
        >
          {commandText ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
              {imageBlocksNode}
              <div style={{ display: "flex", alignItems: "flex-start", gap: 8, flexWrap: "wrap" }}>
                <button
                  onClick={() => setExpanded((prev) => !prev)}
                  title={expanded ? t("i18n.collapse") : t("i18n.expand")}
                  aria-expanded={expanded}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    flexShrink: 0,
                    padding: 0,
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    color: "var(--accent)",
                    fontFamily: "var(--font-mono)",
                    fontSize: "var(--fs-ui)",
                    textAlign: "left",
                  }}
                >
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {commandName}
                  </span>
                  <svg
                    width="11"
                    height="11"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{ flexShrink: 0, opacity: 0.75, transform: expanded ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}
                    aria-hidden="true"
                  >
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>
                {commandArgs && (
                  <span style={{
                    color: "var(--text)",
                    fontSize: "var(--fs-body)",
                    lineHeight: 1.6,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    minWidth: 0,
                    flex: 1,
                  }}>
                    {commandArgs}
                  </span>
                )}
              </div>
              {expanded && (
                <MarkdownBody className="markdown-user-message" cwd={cwd} onOpenFile={onOpenFile}>{content}</MarkdownBody>
              )}
            </div>
          ) : (
          <>
          {imageBlocksNode}
          {content && <SafeMarkdownBody className="markdown-user-message" cwd={cwd} onOpenFile={onOpenFile}>{content}</SafeMarkdownBody>}
          </>
          )}
        </div>

      </div>

      {/* Bottom row: action buttons + timestamp */}
      {(time || canFork || canNavigate || true) && (
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "flex-end",
          gap: 6, marginTop: 3,
        }}>
          {/* Mounted on hover, not faded: a hidden button's label is still part of
              a text selection, so copying the transcript picked up a stray "Copy"
              after every message. */}
          <div style={{ display: "flex", gap: 3, minHeight: 20 }}>
            {hovered && (
            <button
              className={`ui-btn ui-btn--hint${copied ? " ui-btn--accent" : ""}`}
              onClick={copyContent}
               title={t("i18n.copyMessage")}
              style={{ animation: "fade-in 0.12s var(--ease-expo)" }}
            >
              {copied ? (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              )}
               {copied ? t("i18n.copied") : t("i18n.copy")}
            </button>
            )}
          </div>
          {(canFork || canNavigate) && (hovered || forking) && (
            <div style={{
              display: "flex", gap: 3,
              animation: "fade-in 0.12s var(--ease-expo)",
            }}>
              {canNavigate && (
                <button
                  className="ui-btn ui-btn--hint"
                  onClick={() => { onNavigate!(prevAssistantEntryId!); onEditContent?.(editTarget); }}
                   title={t("i18n.editFromHereTitle")}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="15 10 20 15 15 20" />
                    <path d="M4 4v7a4 4 0 0 0 4 4h12" />
                  </svg>
                   {t("i18n.editFromHere")}
                </button>
              )}
              {canFork && (
                <button
                  className={`ui-btn ui-btn--hint${forking ? " ui-btn--accent" : ""}`}
                  onClick={() => { onFork!(entryId!); }}
                  disabled={forking}
                   title={forking ? t("i18n.creatingSession") : t("i18n.newSessionTitle")}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="6" y1="3" x2="6" y2="15" />
                    <circle cx="18" cy="6" r="3" />
                    <circle cx="6" cy="18" r="3" />
                    <path d="M18 9a9 9 0 0 1-9 9" />
                  </svg>
                   {forking ? t("i18n.creating") : t("i18n.newSession")}
                </button>
              )}
            </div>
          )}
          {/* Timestamp lives in the gutter now, so it is not repeated here. */}
        </div>
      )}
      </div>
    </div>
  );
}

function AssistantMessageView({
  message,
  isStreaming,
  toolResults,
  modelNames,
  cwd,
  onOpenFile,
  showTimestamp,
  sessionId,
  entryId,
  meta = "full",
}: {
  message: AssistantMessage;
  isStreaming?: boolean;
  toolResults?: Map<string, ToolResultMessage>;
  modelNames?: Record<string, string>;
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
  showTimestamp?: boolean;
  sessionId?: string;
  entryId?: string;
  meta?: "full" | "model" | "none";
}) {
  const { t } = useI18n();
  const time = showTimestamp ? formatTime(message.timestamp) : null;
  const blockItems = (message.content ?? [])
    .map((block, originalIndex) => ({ block, originalIndex }))
    .filter(({ block }) => !isEmptyThinkingBlock(block, { isStreaming }));
  const blocks = blockItems.map(({ block }) => block);
  const providerError = getAssistantErrorMessage(message, { isStreaming });
  const [hovered, setHovered] = useState(false);
  const [copied, setCopied] = useState(false);
  const streamStartRef = useRef<number | null>(null);
  const [tps, setTps] = useState<number | null>(null);
  const blockItemsRef = useRef(blockItems);
  blockItemsRef.current = blockItems;

  // Streaming-based timing for thinking blocks. Milliseconds, like every other
  // duration here — formatDuration renders them and the trace bar divides them.
  const blockStartTimesRef = useRef<Map<number, number>>(new Map());
  const [streamingDurations, setStreamingDurations] = useState<Map<number, number>>(new Map());

  // How long this message took to generate: start (timestamp) to end (endedAt).
  //
  // This used to measure from the *previous* message's timestamp, on the
  // assumption that message.timestamp marked the end of generation. It marks the
  // start, so the subtraction produced the few milliseconds between a tool result
  // landing and the next message being created — under a second, which the
  // `> 0` guard then discarded. 1,820 of 1,947 thinking blocks across 25 real
  // sessions (93%) lost their duration that way and fell back to a bare label.
  const generationDuration = useMemo<number | undefined>(() => {
    if (!message.timestamp || !message.endedAt) return undefined;
    const ms = message.endedAt - message.timestamp;
    return ms > 0 ? ms : undefined;
  }, [message.timestamp, message.endedAt]);

  // Tool execution time: from the end of generation to the tool result landing.
  //
  // Anchored on endedAt, not timestamp. Anchoring on the start of generation
  // charged the model's own thinking time to the tool, which overstated every one
  // of 2,484 measured call/result pairs — median 12s shown against a median 0s of
  // actual execution. Falls back to timestamp for a live turn, which has no entry
  // on disk yet and so no endedAt.
  const toolCallDurations = useMemo<Map<string, number>>(() => {
    const map = new Map<string, number>();
    const generationEnd = message.endedAt ?? message.timestamp;
    if (!toolResults || !generationEnd) return map;
    for (const [callId, result] of toolResults) {
      if (result.timestamp) {
        const ms = result.timestamp - generationEnd;
        // Sub-second is real and worth showing as "<1s"; only a negative gap is
        // nonsense (a result that predates the generation it answers).
        if (ms >= 0) map.set(callId, ms);
      }
    }
    return map;
  }, [toolResults, message.timestamp, message.endedAt]);

  const textContent = blocks
    .filter((b): b is TextContent => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  const copyContent = () => {
    copyText(textContent).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  useEffect(() => {
    if (!isStreaming) {
      // Finalise any un-finished thinking block durations on stream end
      const now = new Date().getTime();
      setStreamingDurations((prev: Map<number, number>) => {
        const next = new Map(prev);
        for (const [idx, start] of blockStartTimesRef.current) {
          if (!next.has(idx)) next.set(idx, now - start);
        }
        return next;
      });
      streamStartRef.current = null;
      setTps(null);
      return;
    }
    const tick = () => {
      const items = blockItemsRef.current;
      const bs = items.map(({ block }) => block);
      const now = Date.now();

      // Record start time for each block the first time we see it
      items.forEach(({ originalIndex }) => {
        if (!blockStartTimesRef.current.has(originalIndex)) blockStartTimesRef.current.set(originalIndex, now);
      });

      // When a non-last block has a successor already started, finalise its duration
      setStreamingDurations((prev: Map<number, number>) => {
        let changed = false;
        const next = new Map(prev);
        for (let i = 0; i < items.length - 1; i++) {
          const originalIndex = items[i].originalIndex;
          const nextOriginalIndex = items[i + 1].originalIndex;
          if (!next.has(originalIndex) && blockStartTimesRef.current.has(originalIndex)) {
            const start = blockStartTimesRef.current.get(originalIndex)!;
            const nextStart = blockStartTimesRef.current.get(nextOriginalIndex) ?? now;
            next.set(originalIndex, nextStart - start);
            changed = true;
          }
        }
        return changed ? next : prev;
      });

      let chars = 0;
      for (const b of bs) {
        if (b.type === "text") chars += (b as TextContent).text?.length ?? 0;
        else if (b.type === "thinking") chars += (b as ThinkingContent).thinking?.length ?? 0;
        else if (b.type === "toolCall") chars += JSON.stringify((b as ToolCallContent).input ?? {}).length;
      }
      if (chars === 0) return;
      if (streamStartRef.current === null) streamStartRef.current = now;
      const elapsed = (now - streamStartRef.current) / 1000;
      if (elapsed > 0.5) setTps(chars / 4 / elapsed);
    };
    const id = setInterval(tick, 300);
    return () => clearInterval(id);
  }, [isStreaming]);

  if (blocks.length === 0 && !isStreaming && !providerError) return null;

  return (
    <div
      style={{ marginBottom: "var(--sp-7)" }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Provenance as one quiet dot-separated line, not a gutter.
          The two-column rail this replaced stacked model, tokens, cost and time
          as four separate lines in a 108px column — a ragged list that competed
          with the content and cost every turn permanent horizontal space for
          reference data you want occasionally. One line, dim and small, reads as
          a caption; the content gets the full width back. */}
      {meta !== "none" && (
      <div className="turn-meta">
        {message.provider && (() => {
          const label = modelDisplayLabel(message, modelNames);
          return <span className="turn-meta__model" title={label}>{label}</span>;
        })()}
        {meta === "full" && isStreaming && (
          // Amber pulse = this turn is live, the one meaning amber carries. No
          // text label: no i18n key exists for it and inventing one would need a
          // zh-CN translation too. The existing agent-running string labels it
          // for assistive tech instead.
          <span
            role="status"
            aria-label={t("sidebar.agentRunning")}
            style={{ display: "inline-flex", alignItems: "center" }}
          >
            <span className="ui-rail__dot is-live" />
          </span>
        )}
        {meta === "full" && message.usage && !isStreaming && formatUsageCompact(message.usage).map((part) => (
          // Full breakdown stays on title; the line shows the two scalars.
          <span key={part} title={formatUsage(message.usage!)}>{part}</span>
        ))}
        {meta === "full" && time && !isStreaming && <span>{time}</span>}
        {meta === "full" && isStreaming && (() => {
          let chars = 0;
          for (const b of blocks) {
            if (b.type === "text") chars += (b as TextContent).text?.length ?? 0;
            else if (b.type === "thinking") chars += (b as ThinkingContent).thinking?.length ?? 0;
            else if (b.type === "toolCall") chars += JSON.stringify((b as ToolCallContent).input ?? {}).length;
          }
          const est = Math.round(chars / 4);
          return (
            <>

              {est > 0 && (
                <span style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--text)" }} title={t("i18n.estimatedTokens")}>
                  <span style={{ display: "flex", alignItems: "center", gap: 2, fontSize: "var(--fs-micro)", fontWeight: 400 }}>
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="5" y1="1.5" x2="5" y2="8.5" /><polyline points="2 6 5 8.5 8 6" />
                    </svg>
                    {est}
                  </span>
                  {tps !== null && (() => {
                    const bg = tps >= 50 ? "#53b3cb" : tps >= 30 ? "#9bc53d" : tps >= 15 ? "#f9c22e" : "#e01a4f";
                    return (
                      <span style={{ marginLeft: 6, padding: "1px 6px", borderRadius: 4, background: bg, color: "#fff", fontSize: "var(--fs-micro)", fontWeight: 400 }}>
                        {tps.toFixed(1)} t/s
                      </span>
                    );
                  })()}
                </span>
              )}
            </>
          );
        })()}
      </div>
      )}

      <div className={`turn-surface${isStreaming ? " turn-surface--live" : ""}`}>
      <div className="turn-blocks">
        {blockItems.map(({ block, originalIndex }) => (
          <BlockView key={`${entryId ?? "stream"}-${originalIndex}`} block={block} toolResults={toolResults} isStreaming={isStreaming} streamingDuration={streamingDurations.get(originalIndex) ?? (block.type === "thinking" ? generationDuration : undefined)} toolCallDurations={toolCallDurations} cwd={cwd} onOpenFile={onOpenFile} sessionId={sessionId} entryId={entryId} blockIndex={originalIndex} />
        ))}
      </div>

      {providerError && (
        <div
          role="alert"
          style={{
            marginTop: blocks.length > 0 ? 8 : 0,
            padding: "7px 10px",
            border: "1px solid rgba(239,68,68,0.3)",
            borderRadius: 6,
            background: "rgba(239,68,68,0.07)",
            color: "#ef4444",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--fs-meta)",
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
          }}
        >
          Error: {providerError}
        </div>
      )}

      {/* Actions only. Usage and timestamp moved to the gutter above.

          Mounted on hover rather than faded to opacity 0. A hidden-but-present
          button still contributes its label to a text selection, so copying a
          transcript picked up a stray "Copy" and "Read aloud" after every message
          that had them — visible in any paste of the page. It also left an
          invisible tab stop behind, since pointer-events: none does not remove an
          element from the focus order. Not rendering it fixes both. */}
      {meta === "full" && (
      <div style={{
        display: "flex", alignItems: "center", gap: 8, marginTop: "var(--sp-3)",
        // The row keeps its height whether or not the buttons are mounted, so
        // revealing them does not shift the message below.
        minHeight: 22,
      }}>
        {hovered && textContent && !isStreaming && (
          <button
            className={`ui-btn ui-btn--hint${copied ? " ui-btn--accent" : ""}`}
            onClick={copyContent}
             title={t("i18n.copyMessage")}
            style={{ animation: "fade-in 0.12s var(--ease-expo)" }}
          >
            {copied ? (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            )}
             {copied ? t("i18n.copied") : t("i18n.copy")}
          </button>
        )}
        {hovered && textContent && !isStreaming && (
          <SpeakButton
            text={textContent}
            style={{ animation: "fade-in 0.12s var(--ease-expo)" }}
          />
        )}
      </div>
      )}
      </div>
    </div>
  );
}

function BlockView({ block, toolResults, isStreaming, streamingDuration, toolCallDurations, cwd, onOpenFile, sessionId, entryId, blockIndex }: { block: AssistantContentBlock; toolResults?: Map<string, ToolResultMessage>; isStreaming?: boolean; streamingDuration?: number; toolCallDurations?: Map<string, number>; cwd?: string; onOpenFile?: (filePath: string) => void; sessionId?: string; entryId?: string; blockIndex: number }) {
  if (block.type === "text") {
    return <TextBlock block={block as TextContent} isStreaming={isStreaming} cwd={cwd} onOpenFile={onOpenFile} />;
  }
  if (block.type === "thinking") {
    return <ThinkingBlock block={block as ThinkingContent} durationMs={streamingDuration} isStreaming={isStreaming} sessionId={sessionId} entryId={entryId} blockIndex={blockIndex} />;
  }
  if (block.type === "toolCall") {
    const tc = block as ToolCallContent;
    const result = toolResults?.get(tc.toolCallId);
    const durationMs = toolCallDurations?.get(tc.toolCallId);
    return <ToolCallBlock block={tc} result={result} durationMs={durationMs} isStreaming={isStreaming} />;
  }
  return null;
}

function TextBlock({ block, isStreaming, cwd, onOpenFile }: { block: TextContent; isStreaming?: boolean; cwd?: string; onOpenFile?: (filePath: string) => void }) {
  return <SafeMarkdownBody isStreaming={isStreaming} cwd={cwd} onOpenFile={onOpenFile}>{block.text}</SafeMarkdownBody>;
}

/**
 * Blank lines are the model's own segmentation of its reasoning, and measurement
 * over 78 real thinking blocks found them in every one (median 2 paragraphs, up
 * to 5) with a median of zero single newlines. So this splits on blank lines only
 * — never on sentences or single newlines, which would impose structure the model
 * did not write and break prose mid-thought.
 *
 * Returns a single step when there is nothing to split, so the rendering degrades
 * to exactly what it was before.
 */
function splitThinkingSteps(text: string): string[] {
  const steps = text.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  return steps.length > 0 ? steps : [text];
}

export function ThinkingBlock({ block, durationMs, isStreaming, defaultExpanded = false, sessionId, entryId, blockIndex }: {
  block: ThinkingContent;
  /** Generation time in milliseconds. Undefined for a session with no entry yet. */
  durationMs?: number;
  /** Marks the trailing step as still being written. */
  isStreaming?: boolean;
  /** Starts open. Used by the UI preview so the trace is visible without a click. */
  defaultExpanded?: boolean;
  sessionId?: string;
  entryId?: string;
  blockIndex: number;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async () => {
    const nextExpanded = !expanded;
    setExpanded(nextExpanded);
    if (!nextExpanded || !block.deferred || content !== null) return;
    if (!sessionId || !entryId) {
      setError(t("i18n.thinkingUnavailable"));
      return;
    }

    setLoading(true);
    setError(null);
    try {
      setContent(await loadThinkingContent(sessionId, entryId, blockIndex));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="think-block">
      <button
        className="think-block__header"
        onClick={() => void toggle()}
        aria-expanded={expanded}
      >
        {/* Filled while reasoning is arriving, dimmed once it has settled, so the
            glyph carries the state even before the label is read. */}
        <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"
          fill={isStreaming ? "var(--text-muted)" : "var(--text-dim)"} style={{ flexShrink: 0 }}>
          <path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" />
        </svg>
        {/* One label, two states. While streaming it shimmers as the progress
            indicator; once done it states how long it took, which is more useful
            than a bare "Thinking" beside a separate number. */}
        {isStreaming
          ? <span className="think-block__label--working">{t("i18n.thinking")}</span>
          : (
            <span className="think-block__label--done">
              {durationMs !== undefined
                ? t("i18n.thoughtFor", { duration: formatDuration(durationMs) })
                : t("i18n.thinking")}
            </span>
          )}
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
          className={`think-block__chevron${expanded ? " is-open" : ""}`}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      <Collapse open={expanded}>
        {/* Was a hardcoded #f87171 that the palette retune could not reach. */}
        <div className={`think-block__body${error ? " is-error" : ""}`}>
          {(() => {
            if (loading) return t("i18n.loadingThinking");
            // Loading and error are single messages, not reasoning: stepping them
            // would put a trace marker next to a failure string.
            if (error) return error;
            const text = block.deferred ? content : block.thinking;
            if (!text) return text;
            const steps = splitThinkingSteps(text);
            return steps.map((step, index) => (
              <div
                key={index}
                className={`think-step${isStreaming && index === steps.length - 1 ? " is-active" : ""}`}
                // Cascade rather than all at once. Set inline because the delay
                // depends on position, which CSS cannot express without a rule
                // per index.
                style={{ animationDelay: `${index * 120}ms` }}
              >
                <span className="think-step__marker" aria-hidden="true" />
                <span className="think-step__text">{step}</span>
              </div>
            ));
          })()}
        </div>
      </Collapse>
    </div>
  );
}


/**
 * Leading glyph for a trace row, chosen from the tool name.
 *
 * A shape is faster to scan down a column of rows than a word: the eye can tell
 * "three reads then an edit" without reading any of them. Names vary between
 * providers, so this matches on substrings and falls back to a neutral dot rather
 * than guessing.
 */
function toolRowIcon(toolName: string): React.ReactNode {
  const name = toolName.toLowerCase();
  const svg = (path: React.ReactNode) => (
    <svg className="tool-row__icon" width="11" height="11" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {path}
    </svg>
  );
  if (/bash|shell|exec|command|terminal/.test(name)) return svg(<><path d="M4 17l5-5-5-5" /><path d="M13 19h7" /></>);
  if (/edit|write|create|patch|replace/.test(name)) return svg(<path d="M4 20h4L20 8l-4-4L4 16v4z" />);
  if (/read|view|open|cat|file/.test(name)) return svg(<><path d="M14 3v5h5" /><path d="M19 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z" /></>);
  if (/search|grep|glob|find|list/.test(name)) return svg(<><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></>);
  if (/subagent|task|agent|spawn/.test(name)) return svg(<><circle cx="12" cy="6" r="3" /><path d="M6 20a6 6 0 0 1 12 0" /></>);
  if (/fetch|http|web|url|request/.test(name)) return svg(<><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" /></>);
  return svg(<circle cx="12" cy="12" r="4" />);
}

function ToolCallBlock({ block, result, durationMs, isStreaming }: { block: ToolCallContent; result?: ToolResultMessage; durationMs?: number; isStreaming?: boolean }) {
  const [expanded, setExpanded] = useState(() => isEditToolName(block.toolName));
  const inputStr = JSON.stringify(block.input, null, 2);
  const isEditTool = isEditToolName(block.toolName);
  const resultDiff = result && !result.isError ? getResultDiff(result) : null;

  // Result display
  const resultText = result
    ? result.content.filter((b): b is { type: "text"; text: string } => b.type === "text").map((b) => b.text).join("\n")
    : null;
  const resultIsEmpty = resultText === null ? false : (resultText.trim() === "(no output)" || resultText.trim() === "");
  const isError = result?.isError ?? false;
  // Gated on isStreaming on purpose: a historical session with a missing result
  // would otherwise show a spinner forever. Only a live turn can be "running".
  const isRunning = Boolean(isStreaming) && !result;

  return (
    <div className={`tool-block${isError ? " tool-block--error" : isRunning ? " tool-block--running" : ""}`}>
      {/* ── Tool call header ── */}
      <button
        className="tool-block__header"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        {/* A live row shows a spinner in place of its icon: the row that is
            working is the one thing worth finding in a long trace, and swapping
            the glyph keeps the columns aligned instead of inserting an element. */}
        {isRunning ? <span className="tool-row__spinner" aria-hidden="true" /> : toolRowIcon(block.toolName)}
        {/* The tool name is the identifier, so it reads as text. Only a failure
            takes colour — the block itself no longer signals success. */}
        <span style={{ color: isError ? "var(--danger)" : "var(--text)", fontFamily: "var(--font-mono)", fontWeight: 600, fontSize: "var(--fs-meta)", flexShrink: 0 }}>
          {block.toolName}
        </span>
        <span style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: "var(--fs-micro)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
          {getToolPreview(block)}
        </span>
        {durationMs !== undefined && (
          <span style={{ fontSize: "var(--fs-micro)", color: "var(--text-dim)", flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>{formatDuration(durationMs)}</span>
        )}
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--text-dim)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, transform: expanded ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>
          <polyline points="2 3.5 5 6.5 8 3.5" />
        </svg>
      </button>

      {/* Where the turn's time went, as a share of the whole process span.
          The row publishes its own duration and reads the total from an inherited
          custom property, so it needs no prop threaded down from the group. When
          no group sets a total the width resolves to zero and the bar is simply
          absent — which is what a standalone row should show. */}
      {durationMs !== undefined && (
        <span
          className="tool-row__bar"
          style={{ "--row-ms": durationMs } as React.CSSProperties}
          aria-hidden="true"
        />
      )}

      {/* ── Expanded: input args ── */}
      {expanded && !isEditTool && (
        <pre
          style={{
            margin: 0,
            padding: "8px 10px",
            color: "var(--text-muted)",
            fontSize: "var(--fs-meta)",
            lineHeight: 1.5,
            overflow: "auto",
            background: "var(--bg-subtle)",
            borderTop: isError ? "1px solid rgba(248,113,113,0.25)" : "1px solid rgba(34,197,94,0.2)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
          }}
        >
          {inputStr}
        </pre>
      )}

      {/* ── Paired result — only shown when expanded ── */}
      {expanded && result && (
        resultDiff ? (
          <PairedDiffResult
            diff={resultDiff}
          />
        ) : (
          <PairedResult
            text={resultText ?? ""}
            isEmpty={resultIsEmpty}
            isError={isError}
          />
        )
      )}
    </div>
  );
}

interface ResultDiff {
  text: string;
}

function PairedDiffResult({ diff }: {
  diff: ResultDiff;
}) {
  return (
    <div
      style={{
        borderTop: "1px solid rgba(34,197,94,0.15)",
        background: "var(--bg)",
      }}
    >
      <SplitPatchView text={diff.text} />
    </div>
  );
}

export function SplitPatchView({ text, changedOnly = false }: { text: string; changedOnly?: boolean }) {
  const { t } = useI18n();
  const files = useMemo(() => parseUnifiedPatch(text), [text]);
  if (!files) return <PatchTextView text={text} />;
  const showFileHeaders = files.length > 1;

  return (
    <div style={{ maxHeight: 560, overflowY: "auto", overflowX: "hidden", background: "var(--bg)" }}>
      {files.map((file, fileIndex) => (
        <div
          key={fileIndex}
          style={{
            minWidth: 0,
            borderTop: fileIndex === 0 ? "none" : "1px solid var(--border)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--fs-meta)",
            lineHeight: 1.55,
          }}
        >
          {showFileHeaders && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
                position: "sticky",
                top: 0,
                zIndex: 1,
                background: "var(--bg-panel)",
                borderBottom: "1px solid var(--border)",
              }}
            >
               <SplitDiffHeader title={file.oldPath || t("i18n.before")} side="left" />
               <SplitDiffHeader title={file.newPath || t("i18n.after")} side="right" />
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)" }}>
            {buildDisplayRows(file.rows, changedOnly).map((item) => {
              if (item.kind === "gap") {
                return (
                  <div key={item.key} className="diff-gap" style={{ gridColumn: "1 / -1" }}>
                    {t("changes.hiddenLines", { count: item.count })}
                  </div>
                );
              }
              return (
                <div key={item.key} style={{ display: "contents" }}>
                  <SplitDiffCellView cell={item.row.left} side="left" />
                  <SplitDiffCellView cell={item.row.right} side="right" />
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function SplitDiffHeader({ title, side }: { title: string; side: "left" | "right" }) {
  return (
    <div
      title={title}
      style={{
        padding: "5px 10px",
        color: "var(--text-dim)",
        borderRight: side === "left" ? "1px solid var(--border)" : "none",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      {title}
    </div>
  );
}

function SplitDiffCellView({ cell, side }: { cell: SplitDiffCell; side: "left" | "right" }) {
  const bg =
    cell.type === "added"
      ? "var(--diff-add-bg)"
      : cell.type === "removed"
      ? "var(--diff-del-bg)"
      : cell.type === "empty"
      ? "var(--bg-subtle)"
      : "transparent";
  const marker =
    cell.type === "added" ? "+" : cell.type === "removed" ? "-" : " ";
  // The palette's own status hues, which are already tuned per theme. The
  // literals here before were a light-mode green on both schemes: #22c55e read
  // 1.94:1 against the added row in light, under the 4.5:1 floor.
  const markerColor =
    cell.type === "added" ? "var(--diff-add-fg)" : cell.type === "removed" ? "var(--diff-del-fg)" : "var(--text-dim)";

  return (
    <div
      style={{
        display: "flex",
        minWidth: 0,
        background: bg,
        borderRight: side === "left" ? "1px solid var(--border)" : "none",
      }}
    >
      <span
        style={{
          width: 42,
          padding: "0 6px",
          textAlign: "right",
          color: "var(--text-dim)",
          userSelect: "none",
          background: "var(--bg-panel)",
          borderRight: "1px solid var(--border)",
          flexShrink: 0,
        }}
      >
        {cell.lineNo ?? ""}
      </span>
      <span
        style={{
          width: 18,
          padding: "0 5px",
          color: markerColor,
          userSelect: "none",
          fontWeight: cell.type === "context" || cell.type === "empty" ? 400 : 700,
          flexShrink: 0,
        }}
      >
        {marker}
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          padding: "0 10px 0 0",
          color: cell.type === "empty" ? "var(--text-dim)" : "var(--text)",
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
        }}
      >
        {cell.text || "\u00a0"}
      </span>
    </div>
  );
}

function PatchTextView({ text }: { text: string }) {
  const lines = text.split(/\r?\n/);

  return (
    <div style={{ maxHeight: 520, overflowY: "auto", overflowX: "hidden", fontFamily: "var(--font-mono)", fontSize: "var(--fs-meta)", lineHeight: 1.55, minWidth: 0 }}>
      {lines.map((line, i) => {
        const kind =
          line.startsWith("@@") ? "hunk" :
          line.startsWith("+") && !line.startsWith("+++") ? "added" :
          line.startsWith("-") && !line.startsWith("---") ? "removed" :
          "context";
        const bg =
          kind === "added" ? "var(--diff-add-bg)" :
          kind === "removed" ? "var(--diff-del-bg)" :
          // Was a blue rgba literal under accent-coloured text — the one tint in
          // the diff that matched no token in either palette.
          kind === "hunk" ? "var(--diff-hunk-bg)" :
          "transparent";
        const color =
          kind === "added" ? "var(--diff-add-fg)" :
          kind === "removed" ? "var(--diff-del-fg)" :
          kind === "hunk" ? "var(--accent)" :
          "var(--text)";

        return (
          <div
            key={i}
            style={{
              display: "flex",
              background: bg,
              borderLeft: kind === "added"
                ? "3px solid var(--success)"
                : kind === "removed"
                ? "3px solid var(--danger)"
                : kind === "hunk"
                ? "3px solid var(--accent)"
                : "3px solid transparent",
            }}
          >
            <span
              style={{
                width: 48,
                padding: "0 8px",
                color: "var(--text-dim)",
                background: "var(--bg-panel)",
                borderRight: "1px solid var(--border)",
                textAlign: "right",
                userSelect: "none",
                flexShrink: 0,
              }}
            >
              {i + 1}
            </span>
            <span style={{ padding: "0 10px", whiteSpace: "pre-wrap", overflowWrap: "anywhere", color }}>
              {line || "\u00a0"}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function getResultDiff(result: ToolResultMessage): ResultDiff | null {
  const details = (result as ToolResultMessage & { details?: unknown }).details;
  if (!isRecord(details)) return null;

  const patch = typeof details.patch === "string" ? details.patch : null;
  if (patch) return { text: patch };

  const diff = typeof details.diff === "string" ? details.diff : null;
  if (diff) return { text: diff };

  return null;
}

function isEditToolName(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return name === "edit" ||
    name.startsWith("edit_") ||
    name.endsWith(".edit") ||
    name.endsWith("_edit") ||
    name.includes("str_replace") ||
    name.includes("replace_editor");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function PairedResult({ text, isEmpty, isError }: {
  text: string;
  isEmpty: boolean;
  isError: boolean;
}) {
  const { t } = useI18n();
  return (
    <div
      style={{
        borderTop: `1px solid ${isError ? "rgba(248,113,113,0.3)" : "rgba(34,197,94,0.15)"}`,
        background: isError ? "rgba(248,113,113,0.04)" : "var(--bg-subtle)",
      }}
    >
      <pre
        style={{
          margin: 0,
          padding: "8px 10px",
          color: isError ? "#f87171" : (isEmpty ? "var(--text-dim)" : "var(--text-muted)"),
          fontSize: "var(--fs-meta)",
          lineHeight: 1.5,
          overflow: "auto",
          maxHeight: 400,
          background: "var(--bg)",
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
          fontStyle: isEmpty ? "italic" : "normal",
          opacity: isEmpty ? 0.6 : 1,
        }}
      >
         {isEmpty ? t("i18n.noOutput") : text}
      </pre>
    </div>
  );
}

function CompactionMessageView({ message }: { message: CustomMessage }) {
  const { t } = useI18n();
  const summary = getMessageText(message.content);
  const parsedSummary = useMemo(() => parseCompactionSummary(summary), [summary]);
  const time = formatTime(message.timestamp);

  return (
    <div style={{ marginBottom: "var(--sp-7)" }}>
      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: 8,
          overflow: "hidden",
          background: "var(--bg)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "7px 10px",
            borderBottom: "1px solid var(--border)",
            background: "var(--bg-panel)",
            color: "var(--text-muted)",
          }}
        >
          <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-micro)", fontWeight: 650 }}>
            compaction
          </span>
          {time && <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: "var(--fs-micro)" }}>{time}</span>}
        </div>

        <div style={{ padding: "11px 13px 12px" }}>
          <div style={{ color: "var(--text)", fontSize: "var(--fs-title)", fontWeight: 700, lineHeight: 1.35 }}>
             {t("i18n.conversationCompacted")}
          </div>
          <div style={{ marginTop: 3, marginBottom: 10, color: "var(--text)", fontSize: "var(--fs-body)", lineHeight: 1.5 }}>
             {t("i18n.compactionDescription")}
          </div>
          {parsedSummary.body ? (
            <MarkdownBody className="markdown-compaction-message">{parsedSummary.body}</MarkdownBody>
          ) : (
             <span style={{ color: "var(--text-dim)", fontSize: "var(--fs-meta)" }}>{t("i18n.noSummary")}</span>
          )}
          <CompactionFileMetadata readFiles={parsedSummary.readFiles} modifiedFiles={parsedSummary.modifiedFiles} />
        </div>
      </div>
    </div>
  );
}

function CompactionFileMetadata({ readFiles, modifiedFiles }: { readFiles: string[]; modifiedFiles: string[] }) {
  const { t } = useI18n();
  const total = readFiles.length + modifiedFiles.length;
  if (total === 0) return null;

  const parts = [];
  if (readFiles.length > 0) parts.push(`${readFiles.length} read`);
  if (modifiedFiles.length > 0) parts.push(`${modifiedFiles.length} modified`);

  return (
    <details className="compaction-file-details">
       <summary>{t("i18n.fileContext", { details: parts.join(", ") })}</summary>
       {modifiedFiles.length > 0 && <CompactionFileList title={t("i18n.modifiedFiles")} files={modifiedFiles} />}
       {readFiles.length > 0 && <CompactionFileList title={t("i18n.readFiles")} files={readFiles} />}
    </details>
  );
}

function CompactionFileList({ title, files }: { title: string; files: string[] }) {
  return (
    <div className="compaction-file-section">
      <div className="compaction-file-title">{title}</div>
      <ul className="compaction-file-list">
        {files.map((file) => (
          <li key={file}>{file}</li>
        ))}
      </ul>
    </div>
  );
}

interface SubagentNotifyInfo {
  output?: string;
  artifactPath?: string;
}

function parseSubagentNotify(content: string): SubagentNotifyInfo {
  const info: SubagentNotifyInfo = {};
  const m = content.match(/Return:\s*(\{[\s\S]*\})/);
  if (m) {
    try {
      const parsed = JSON.parse(m[1]) as {
        output?: string;
        artifactPaths?: string[];
      };
      info.output = typeof parsed.output === "string" ? parsed.output : undefined;
      info.artifactPath =
        Array.isArray(parsed.artifactPaths) && typeof parsed.artifactPaths[0] === "string"
          ? parsed.artifactPaths[0]
          : undefined;
    } catch {
      // fall through to raw rendering
    }
  }
  return info;
}

function sessionIdFromPath(filePath: string): string | undefined {
  const name = filePath.split(/[\\/]/).pop() ?? "";
  const m = name.match(/^.*?_([0-9a-f-]+)\.jsonl$/);
  return m ? m[1] : undefined;
}

/** Completion notice for a background subagent run — visible ping with the
 *  worker's result and a jump to its transcript. */
function SubagentNotifyView({
  message,
  onOpenSession,
}: {
  message: CustomMessage;
  onOpenSession?: (sessionId: string) => void;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const text = getMessageText(message.content);
  const info = parseSubagentNotify(text);
  const transcriptId = info.artifactPath ? sessionIdFromPath(info.artifactPath) : undefined;
  return (
    <div style={{ marginBottom: "var(--sp-7)" }}>
      <div
        style={{
          border: "1px solid rgba(34,197,94,0.35)",
          borderRadius: 8,
          overflow: "hidden",
          background: "rgba(34,197,94,0.05)",
        }}
      >
        <button
          onClick={() => setExpanded((v) => !v)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            width: "100%",
            padding: "7px 10px",
            background: "none",
            border: "none",
            color: "var(--text)",
            cursor: "pointer",
            fontSize: "var(--fs-meta)",
            fontWeight: 600,
            textAlign: "left",
          }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <polyline points="20 6 9 17 4 12" />
          </svg>
          {t("subagents.notifyTitle")}
          <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="var(--text-dim)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: "auto", transform: expanded ? "rotate(180deg)" : "none", transition: "transform 0.15s", flexShrink: 0 }}>
            <polyline points="2 3.5 5 6.5 8 3.5" />
          </svg>
        </button>
        <Collapse open={expanded}>
          <div style={{ padding: "0 10px 8px" }}>
            {info.output && (
              <div style={{ fontSize: "var(--fs-micro)", lineHeight: 1.5, color: "var(--text-muted)", whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "var(--font-mono)" }}>
                {info.output}
              </div>
            )}
            {!info.output && (
              <div style={{ fontSize: "var(--fs-micro)", fontFamily: "var(--font-mono)", color: "var(--text-dim)", whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 160, overflowY: "auto" }}>
                {text}
              </div>
            )}
            {transcriptId && onOpenSession && (
              <button
                onClick={() => onOpenSession(transcriptId!)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  marginTop: 8,
                  padding: "3px 8px",
                  background: "var(--bg-hover)",
                  border: "1px solid var(--border)",
                  borderRadius: 5,
                  color: "var(--accent)",
                  cursor: "pointer",
                  fontSize: "var(--fs-micro)",
                  fontWeight: 600,
                  letterSpacing: "0.03em",
                  textTransform: "uppercase",
                }}
              >
                {t("subagents.transcript")}
                <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                  <polyline points="15 3 21 3 21 9" />
                  <line x1="10" y1="14" x2="21" y2="3" />
                </svg>
              </button>
            )}
          </div>
        </Collapse>
      </div>
    </div>
  );
}

function CustomMessageView({ message, cwd, onOpenFile }: { message: CustomMessage; cwd?: string; onOpenFile?: (filePath: string) => void }) {
  const { t } = useI18n();
  const isHiddenDisplay = message.display === false;
  const [contentExpanded, setContentExpanded] = useState(!isHiddenDisplay);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = getMessageText(message.content);
  const images = getMessageImages(message.content);
  const hasDetails = message.details !== undefined;
  const detailsText = hasDetails ? safeJson(message.details) : "";
  const title = formatCustomType(message.customType);
  const time = formatTime(message.timestamp);

  const copyContent = () => {
    copyText(text || detailsText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div style={{ marginBottom: "var(--sp-7)" }}>
      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: 8,
          overflow: "hidden",
          background: isHiddenDisplay ? "var(--bg-subtle)" : "var(--bg)",
          opacity: isHiddenDisplay && !contentExpanded ? 0.82 : 1,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "7px 10px",
            borderBottom: "1px solid var(--border)",
            background: "var(--bg-panel)",
            color: "var(--text-muted)",
            fontSize: "var(--fs-meta)",
          }}
        >
          <span style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: "var(--fs-micro)", fontWeight: 650 }}>
            {title}
          </span>
           {isHiddenDisplay && <span style={{ color: "var(--text-dim)", fontSize: "var(--fs-micro)" }}>{t("i18n.hiddenExtensionMessage")}</span>}
          {time && <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: "var(--fs-micro)" }}>{time}</span>}
        </div>

        {contentExpanded ? (
          <div style={{ padding: "6px 9px" }}>
            {images.length > 0 && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: text ? 8 : 0 }}>
                {images.map((img, i) => {
                  const src = imageSource(img);
                  if (!src) return null;
                  return (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      key={i}
                      src={src}
                      alt=""
                      style={{ maxWidth: 240, maxHeight: 240, borderRadius: 6, objectFit: "contain", display: "block", border: "1px solid var(--border)" }}
                    />
                  );
                })}
              </div>
            )}
             {text ? <MarkdownBody className="markdown-custom-message" cwd={cwd} onOpenFile={onOpenFile}>{text}</MarkdownBody> : <span style={{ color: "var(--text-dim)", fontSize: "var(--fs-meta)" }}>{t("i18n.noMessage")}</span>}
          </div>
        ) : (
          <button
            onClick={() => setContentExpanded(true)}
            style={{
              display: "block",
              width: "100%",
              padding: "8px 10px",
              border: "none",
              background: "transparent",
              color: "var(--text-dim)",
              cursor: "pointer",
              fontSize: "var(--fs-meta)",
              textAlign: "left",
            }}
          >
             {text ? previewText(text) : t("i18n.showExtensionMessage")}
          </button>
        )}

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "4px 9px",
            borderTop: "1px solid var(--border)",
            background: "var(--bg-subtle)",
          }}
        >
          {text || detailsText ? (
            <button
              onClick={copyContent}
              style={{
                padding: "3px 7px",
                border: "none",
                background: "none",
                color: copied ? "var(--accent)" : "var(--text-dim)",
                cursor: "pointer",
                fontSize: "var(--fs-micro)",
              }}
            >
               {copied ? t("i18n.copied") : t("i18n.copy")}
            </button>
          ) : null}
          {(hasDetails || isHiddenDisplay) && (
            <button
              onClick={() => {
                if (isHiddenDisplay) setContentExpanded((v) => !v);
                else setDetailsExpanded((v) => !v);
              }}
              style={{
                marginLeft: "auto",
                padding: "3px 7px",
                border: "none",
                background: "none",
                color: "var(--text-dim)",
                cursor: "pointer",
                fontSize: "var(--fs-micro)",
              }}
            >
              {isHiddenDisplay
                 ? (contentExpanded ? t("i18n.collapse") : t("i18n.expand"))
                 : (detailsExpanded ? t("i18n.hideDetails") : t("i18n.showDetails"))}
            </button>
          )}
        </div>

        {hasDetails && ((isHiddenDisplay && contentExpanded) || (!isHiddenDisplay && detailsExpanded)) && (
          <pre
            style={{
              margin: 0,
              padding: "9px 10px",
              borderTop: "1px solid var(--border)",
              background: "var(--bg)",
              color: "var(--text-muted)",
              fontSize: "var(--fs-meta)",
              lineHeight: 1.5,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              maxHeight: 360,
              overflow: "auto",
              fontFamily: "var(--font-mono)",
            }}
          >
            {detailsText}
          </pre>
        )}
      </div>
    </div>
  );
}

function getMessageText(content: CustomMessage["content"] | UserMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b): b is TextContent => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function getMessageImages(content: CustomMessage["content"] | UserMessage["content"]): ImageContent[] {
  if (typeof content === "string") return [];
  return content.filter((b): b is ImageContent => b.type === "image");
}

function imageSource(img: ImageContent): string {
  const flat = img as unknown as { data?: string; mimeType?: string };
  if (img.source) {
    return img.source.type === "base64"
      ? `data:${img.source.media_type};base64,${img.source.data}`
      : img.source.url ?? "";
  }
  return flat.data ? `data:${flat.mimeType};base64,${flat.data}` : "";
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatCustomType(type: string): string {
  return type || "extension";
}

function previewText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "Show extension message";
  return normalized.length > 140 ? `${normalized.slice(0, 140)}...` : normalized;
}


const isPreviewablePrimitive = (v: unknown): v is string | number | boolean =>
  v !== null && (typeof v === "string" || typeof v === "number" || typeof v === "boolean");

/**
 * Keys worth showing, most informative first. Checked ahead of key order because
 * key order in a tool's arguments is arbitrary — `spawn_subagent` can arrive as
 * {sessionControl, tasks} or {tasks, cwd}, and the first key is meaningless.
 */
const PREVIEW_PREFERRED_KEYS = [
  "command", "path", "file_path", "pattern", "query", "tool", "name", "task",
  "describe", "search", "action", "url", "source", "code", "prompt", "message",
  "server", "connect",
] as const;

/** Plumbing, never the point of the call. Skipped so it cannot win the preview. */
const PREVIEW_SKIP_KEYS = new Set([
  "cwd", "timeout", "timeoutms", "concurrency", "async", "sessioncontrol", "limit",
  "query_scope", "ttl", "chatprogress", "index", "lines", "view", "mode",
  "numresults", "turnbudget", "toolbudget", "agentscope", "artifacts", "context",
  "mission", "id",
]);

/**
 * One-line summary of a tool call's arguments.
 *
 * The previous version ended in `String(input[keys[0]])`, which printed
 * "[object Object]" whenever the first argument was an object or an array of
 * objects. Measured across 9,402 real tool calls in ~/.pi/agent/sessions that hit
 * 85 calls (0.9%) over 12 shapes — every `mcp` call carrying an `args` object,
 * every `ctx_batch_execute`, `spawn_subagent` and `propose_task_list`.
 *
 * Falling back to "first primitive in key order" removes the [object Object] but
 * is barely better, because it surfaces noise: spawn_subagent rendered "false"
 * from sessionControl and ctx_batch_execute rendered "180000" from timeout. Hence
 * the preferred/skip lists, then a typed walk. Verified over the same corpus:
 * 0 "[object Object]", 19 empty (all genuinely empty argument objects).
 */
function getToolPreview(block: ToolCallContent): string {
  const input = block.input;
  if (!input || typeof input !== "object") return "";
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 0) return "";

  for (const key of PREVIEW_PREFERRED_KEYS) {
    if (key in record && isPreviewablePrimitive(record[key])) {
      return String(record[key]).slice(0, 120);
    }
  }

  const useful = keys.filter((k) => !PREVIEW_SKIP_KEYS.has(k.toLowerCase()));

  for (const key of useful) {
    if (isPreviewablePrimitive(record[key])) return String(record[key]).slice(0, 120);
  }

  // Arrays: join when they are primitives, otherwise count them — "4 commands"
  // says more than a truncated dump of the first element.
  for (const key of useful) {
    const value = record[key];
    if (Array.isArray(value)) {
      if (value.length > 0 && value.every(isPreviewablePrimitive)) {
        return value.join(", ").slice(0, 120);
      }
      return `${value.length} ${key}`;
    }
  }

  // Nested object: surface its first meaningful scalar, e.g. mcp {args:{server}}.
  for (const key of useful) {
    const value = record[key];
    if (value && typeof value === "object") {
      for (const [innerKey, innerValue] of Object.entries(value as Record<string, unknown>)) {
        if (isPreviewablePrimitive(innerValue) && !PREVIEW_SKIP_KEYS.has(innerKey.toLowerCase())) {
          return `${innerKey}: ${String(innerValue)}`.slice(0, 120);
        }
      }
      return `${key} {${Object.keys(value as object).slice(0, 3).join(", ")}}`.slice(0, 120);
    }
  }

  // Everything left was skipped as plumbing; better a value than nothing.
  for (const key of keys) {
    if (isPreviewablePrimitive(record[key])) return String(record[key]).slice(0, 120);
  }
  return "";
}

function formatUsage(usage: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: { total: number };
}): string {
  const parts = [];
  if (usage.input) parts.push(`${usage.input.toLocaleString()} in`);
  if (usage.output) parts.push(`${usage.output.toLocaleString()} out`);
  if (usage.cacheRead) parts.push(`${usage.cacheRead.toLocaleString()} cache R`);
  if (usage.cacheWrite) parts.push(`${usage.cacheWrite.toLocaleString()} cache W`);
  if (usage.cost?.total) parts.push(`$${usage.cost.total.toFixed(4)}`);
  return parts.join(" · ");
}

/**
 * Gutter-sized usage: two short scalars instead of the full breakdown.
 *
 * formatUsage produces something like "702 in · 64 out · 32,512 cache R ·
 * $0.0001" — around 40 characters, which wraps into a tall ragged stack inside
 * the 108px rail and dominates the turn. The full string still goes on title.
 */
function formatUsageCompact(usage: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: { total: number };
}): string[] {
  const out: string[] = [];
  const tokens = (usage.input ?? 0) + (usage.output ?? 0);
  if (tokens) {
    // Million tier matters: a long context turn renders as "1348.0k tok"
    // otherwise, which is both wide and unreadable.
    out.push(
      tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M tok`
        : tokens >= 1000 ? `${Math.round(tokens / 1000)}k tok`
          : `${tokens} tok`,
    );
  }
  if (usage.cost?.total) out.push(`$${usage.cost.total.toFixed(4)}`);
  return out;
}

function BashExecutionView({ message, sessionId }: { message: BashExecutionMessage; sessionId?: string }) {
  const [fullOutput, setFullOutput] = useState<string | null>(null);
  const [loadingFull, setLoadingFull] = useState(false);
  const [fullError, setFullError] = useState<string | null>(null);

  const isPending = !message.output && message.exitCode === undefined && !message.cancelled;
  const isError = message.cancelled || (message.exitCode !== undefined && message.exitCode !== 0);
  const fullOutputUrl = sessionId && message.fullOutputPath
    ? `/api/agent/${encodeURIComponent(sessionId)}/bash-output?path=${encodeURIComponent(message.fullOutputPath)}`
    : null;
  const showFullButton = message.truncated && fullOutputUrl && fullOutput === null;
  const displayOutput = fullOutput ?? message.output;

  async function loadFullOutput() {
    if (!fullOutputUrl) return;
    setLoadingFull(true);
    setFullError(null);
    try {
      const res = await fetch(fullOutputUrl);
      const d = await res.json() as { success?: boolean; data?: { output?: string }; error?: string };
      if (d.success) {
        setFullOutput(d.data?.output ?? "");
      } else {
        setFullError(d.error ?? "failed");
      }
    } catch (e) {
      setFullError(String(e));
    } finally {
      setLoadingFull(false);
    }
  }

  // Reuse the existing ToolCallBlock so user-run bash looks identical to an
  // agent-run bash tool call: same header, collapse behavior, result pane.
  // Synthesize an equivalent ToolCallContent + ToolResultMessage pair.
  const toolName = message.excludeFromContext ? "bash (local)" : "bash";
  const block: ToolCallContent = {
    type: "toolCall",
    toolCallId: `bash-${message.timestamp ?? ""}`,
    toolName,
    input: { command: message.command },
  };
  const result: ToolResultMessage | undefined = isPending
    ? undefined
    : {
        role: "toolResult",
        toolCallId: block.toolCallId,
        toolName,
        content: displayOutput ? [{ type: "text", text: displayOutput }] : [],
        isError,
        timestamp: message.timestamp,
      };

  return (
    <div style={{ margin: "6px 0" }}>
      <ToolCallBlock block={block} result={result} />
      {message.truncated && fullOutputUrl && (
        <div style={{ padding: "4px 10px", fontSize: "var(--fs-micro)", marginTop: -1 }}>
          {showFullButton && (
            <button
              onClick={loadFullOutput}
              disabled={loadingFull}
              style={{ background: "none", border: "none", color: "var(--accent)", cursor: loadingFull ? "default" : "pointer", fontSize: "var(--fs-micro)", padding: 0, textDecoration: "underline" }}
            >
              {loadingFull ? "loading…" : "view full output"}
            </button>
          )}
          <a
            href={`${fullOutputUrl}&download=1`}
            style={{ marginLeft: showFullButton ? 10 : 0, color: "var(--accent)", fontSize: "var(--fs-micro)", textDecoration: "underline" }}
          >
            download full output
          </a>
          {fullError && <span style={{ marginLeft: 6, color: "var(--text-dim)", fontSize: "var(--fs-micro)" }}>({fullError})</span>}
        </div>
      )}
    </div>
  );
}
