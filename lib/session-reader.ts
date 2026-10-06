import {
  SessionManager,
  buildSessionProjection as piBuildSessionProjection,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { spawn } from "child_process";
import { closeSync, openSync, readSync } from "fs";
import { readFile } from "fs/promises";
import { join, normalize as normalizePath } from "path";
import type { AgentMessage, SessionEntry, SessionHeader, SessionInfo, SessionContext, SessionMessage } from "./types";
import type { SessionEntry as PiSessionEntry } from "@earendil-works/pi-coding-agent";
import { normalizeToolCalls } from "./normalize";
import { buildHistoryFromChain, type SessionHistoryResult } from "./session-history";
import { sessionPathKey } from "./session-path";
import { resolveProject, type ProjectInfo } from "./worktree";

export { getAgentDir };

interface IndexedSessionInfo {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
  parentSessionPath?: string;
}

interface PersistedSessionIndex {
  version: number;
  files: Record<string, { session: IndexedSessionInfo | null }>;
}

const SESSION_INDEX_VERSION = 1;
const SESSION_INDEX_CACHE_PATH = join(getAgentDir(), "pi-hub-session-index-v1.json");
const SESSION_INDEXER_PATH = join(process.cwd(), "bin", "pi-hub-session-indexer.mjs");

async function readPersistedSessionIndex(): Promise<IndexedSessionInfo[] | null> {
  try {
    const index = JSON.parse(await readFile(SESSION_INDEX_CACHE_PATH, "utf8")) as PersistedSessionIndex;
    if (index.version !== SESSION_INDEX_VERSION || !index.files || typeof index.files !== "object") return null;
    return Object.values(index.files)
      .map((record) => record?.session)
      .filter((session): session is IndexedSessionInfo => Boolean(session));
  } catch {
    return null;
  }
}

async function refreshPersistedSessionIndex(): Promise<IndexedSessionInfo[]> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [
      SESSION_INDEXER_PATH,
      join(getAgentDir(), "sessions"),
      SESSION_INDEX_CACHE_PATH,
    ], {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < 8_000) stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Session indexer exited with ${signal ?? code}: ${stderr.trim()}`));
    });
  });

  const sessions = await readPersistedSessionIndex();
  if (!sessions) throw new Error("Session indexer completed without a readable cache");
  return sessions;
}

async function enrichSessions(piSessions: IndexedSessionInfo[]): Promise<SessionInfo[]> {
  const pathToId = new Map<string, string>();
  for (const s of piSessions) pathToId.set(sessionPathKey(s.path), s.id);

  // Resolve each unique cwd to its project root (main repo shared by all
  // worktrees). resolveProject caches per-cwd, so this is cheap after warmup.
  const uniqueCwds = [...new Set(piSessions.map((s) => s.cwd).filter(Boolean))];
  const projectByCwd = new Map<string, ProjectInfo>();
  await Promise.all(uniqueCwds.map(async (cwd) => {
    projectByCwd.set(cwd, await resolveProject(cwd));
  }));

  return piSessions.map((s) => {
    cacheSessionPath(s.id, s.path);
    const project = s.cwd ? projectByCwd.get(s.cwd) : undefined;
    return {
      path: s.path,
      id: s.id,
      cwd: s.cwd,
      name: s.name,
      created: s.created,
      modified: s.modified,
      messageCount: s.messageCount,
      firstMessage: s.firstMessage || "(no messages)",
      parentSessionId: s.parentSessionPath ? pathToId.get(sessionPathKey(s.parentSessionPath)) : undefined,
      projectRoot: project?.projectRoot ?? s.cwd,
      ...(project?.isWorktree && project.branch ? { worktreeBranch: project.branch } : {}),
    };
  });
}

async function loadAllSessions(): Promise<SessionInfo[]> {
  return enrichSessions(await refreshPersistedSessionIndex());
}

function startSessionListRefresh(): Promise<SessionInfo[]> {
  const generation = globalThis.__piSessionListGeneration ?? 0;
  if (globalThis.__piSessionListPromise) {
    if (globalThis.__piSessionListPromiseGeneration === generation) {
      return globalThis.__piSessionListPromise;
    }
    // Serialize indexer processes, but never reuse a scan started before the
    // mutation this caller needs to see.
    return globalThis.__piSessionListPromise.then(() => startSessionListRefresh());
  }
  const loadPromise = loadAllSessions().then((data) => {
    globalThis.__piSessionListCache = {
      data,
      ts: (globalThis.__piSessionListGeneration ?? 0) === generation ? Date.now() : 0,
    };
    return data;
  });
  const trackedPromise = loadPromise.finally(() => {
    if (globalThis.__piSessionListPromise === trackedPromise) {
      globalThis.__piSessionListPromise = undefined;
      globalThis.__piSessionListPromiseGeneration = undefined;
    }
  });
  globalThis.__piSessionListPromiseGeneration = generation;
  globalThis.__piSessionListPromise = trackedPromise;
  return trackedPromise;
}

export async function listAllSessions(): Promise<SessionInfo[]> {
  if (globalThis.__piSessionListCache && Date.now() - globalThis.__piSessionListCache.ts < SESSION_LIST_CACHE_TTL_MS) {
    return globalThis.__piSessionListCache.data;
  }

  // Serve stale catalogue data immediately while a hidden child process updates
  // the persistent per-file index. Large JSONL files must never block Next's
  // event loop or make the watchdog mistake a busy scan for a dead server.
  if (globalThis.__piSessionListCache) {
    void startSessionListRefresh().catch((error) => {
      console.error("[pi-hub] Session index refresh failed:", error);
    });
    return globalThis.__piSessionListCache.data;
  }

  const persisted = await readPersistedSessionIndex();
  if (!persisted) return startSessionListRefresh();

  const data = await enrichSessions(persisted);
  globalThis.__piSessionListCache = { data, ts: 0 };
  void startSessionListRefresh().catch((error) => {
    console.error("[pi-hub] Session index refresh failed:", error);
  });
  return data;
}

// ============================================================================
// Session path caches, stored in globalThis for hot-reload safety.
// ============================================================================
declare global {
  var __piSessionPathCache: Map<string, string> | undefined;
  var __piPathToSessionIdCache: Map<string, string> | undefined;
  var __piSessionListPromise: Promise<SessionInfo[]> | undefined;
  var __piSessionListPromiseGeneration: number | undefined;
  var __piSessionListGeneration: number | undefined;
  var __piSessionListCache: { data: SessionInfo[]; ts: number } | undefined;
}

const SESSION_LIST_CACHE_TTL_MS = 30_000;

export function invalidateSessionListCache(): void {
  globalThis.__piSessionListGeneration = (globalThis.__piSessionListGeneration ?? 0) + 1;
  if (globalThis.__piSessionListCache) globalThis.__piSessionListCache.ts = 0;
}

function getPathCache(): Map<string, string> {
  if (!globalThis.__piSessionPathCache) globalThis.__piSessionPathCache = new Map();
  return globalThis.__piSessionPathCache;
}

function getPathToIdCache(): Map<string, string> {
  if (!globalThis.__piPathToSessionIdCache) globalThis.__piPathToSessionIdCache = new Map();
  return globalThis.__piPathToSessionIdCache;
}

export async function refreshSessionListForPathLookup(
  refresh: () => Promise<unknown> = startSessionListRefresh,
): Promise<void> {
  // A mutation can invalidate the catalogue while the scan is in flight. Do
  // not return the older scan's miss; wait for one refresh from the current
  // generation before consulting the path cache.
  for (;;) {
    const generation = globalThis.__piSessionListGeneration ?? 0;
    await refresh();
    if ((globalThis.__piSessionListGeneration ?? 0) === generation) return;
  }
}

export async function resolveSessionPath(sessionId: string): Promise<string | null> {
  const cached = getPathCache().get(sessionId);
  if (cached) return cached;

  await refreshSessionListForPathLookup();
  return getPathCache().get(sessionId) ?? null;
}

export async function resolveSessionIdByPath(filePath: string): Promise<string | undefined> {
  const pathKey = sessionPathKey(filePath);
  const cached = getPathToIdCache().get(pathKey);
  if (cached) return cached;

  await refreshSessionListForPathLookup();
  return getPathToIdCache().get(pathKey);
}

export function cacheSessionPath(sessionId: string, filePath: string): void {
  const normalizedPath = normalizePath(filePath);
  const pathKey = sessionPathKey(normalizedPath);
  const pathCache = getPathCache();
  const reverseCache = getPathToIdCache();
  const previousPath = pathCache.get(sessionId);
  const previousPathKey = previousPath ? sessionPathKey(previousPath) : undefined;
  const previousSessionId = reverseCache.get(pathKey);
  const previousOwnerPath = previousSessionId ? pathCache.get(previousSessionId) : undefined;
  if (previousPathKey && previousPathKey !== pathKey && reverseCache.get(previousPathKey) === sessionId) {
    reverseCache.delete(previousPathKey);
  }
  if (
    previousSessionId &&
    previousSessionId !== sessionId &&
    previousOwnerPath &&
    sessionPathKey(previousOwnerPath) === pathKey
  ) {
    pathCache.delete(previousSessionId);
  }
  pathCache.set(sessionId, normalizedPath);
  reverseCache.set(pathKey, sessionId);
}

export function invalidateSessionPathCache(sessionId: string): void {
  const pathCache = getPathCache();
  const reverseCache = getPathToIdCache();
  const filePath = pathCache.get(sessionId);
  pathCache.delete(sessionId);
  const pathKey = filePath ? sessionPathKey(filePath) : undefined;
  if (pathKey && reverseCache.get(pathKey) === sessionId) {
    reverseCache.delete(pathKey);
  }
}

export function readSessionHeader(filePath: string): SessionHeader | null {
  const fd = openSync(filePath, "r");
  try {
    const chunks: Buffer[] = [];
    const maxHeaderBytes = 64 * 1024;
    let position = 0;
    let foundNewline = false;

    while (position < maxHeaderBytes && !foundNewline) {
      const buffer = Buffer.allocUnsafe(Math.min(4096, maxHeaderBytes - position));
      const bytesRead = readSync(fd, buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      const data = buffer.subarray(0, bytesRead);
      const newlineIndex = data.indexOf(0x0a);
      chunks.push(newlineIndex === -1 ? data : data.subarray(0, newlineIndex));
      position += bytesRead;
      foundNewline = newlineIndex !== -1;
    }

    if (!foundNewline && position >= maxHeaderBytes) return null;
    const firstLine = Buffer.concat(chunks).toString("utf8").trimEnd();
    if (!firstLine) return null;
    try {
      const header = JSON.parse(firstLine) as SessionHeader;
      return header.type === "session" ? header : null;
    } catch {
      return null;
    }
  } finally {
    closeSync(fd);
  }
}

export function getSessionEntries(filePath: string): SessionEntry[] {
  const entries = SessionManager.open(filePath).getEntries();
  return entries as unknown as SessionEntry[];
}

/**
 * The conversation as it was actually held, which is not the same thing as the
 * model's context.
 *
 * `buildSessionContext` returns what the SDK feeds the model, so after a
 * compaction it starts at the summary and everything earlier disappears. In a
 * terminal that is invisible — the scrollback stays on screen — but pi-hub
 * rebuilds the chat from the file on every load, so compacting used to erase the
 * visible history even though all of it is still on disk.
 *
 * This walks the raw parent chain instead, and reports where the model's context
 * begins so the UI can mark the boundary rather than pretend it is not there.
 * The in-context entries are a contiguous suffix of the chain (measured: a
 * 319-entry session whose 74 context entries occupied positions 245-318), so one
 * index is enough to describe the split.
 */
export type SessionHistory = SessionHistoryResult<AgentMessage>;

export function buildSessionHistory(
  entries: SessionEntry[],
  leafId?: string | null,
  options: { deferThinking?: boolean; deferToolResultImages?: boolean } = {},
): SessionHistory {
  const byId = new Map<string, SessionEntry>();
  for (const e of entries) byId.set(e.id, e);

  // Find the first raw history row still contributing to effective context.
  // This existing single boundary cannot describe removals inside the history.
  const projection = piBuildSessionProjection(
    entries as unknown as PiSessionEntry[],
    leafId,
    byId as unknown as Map<string, PiSessionEntry>,
  );
  const contextIds = new Set(
    projection.entries
      .filter((projected) => projected.messages.length > 0)
      .map((projected) => (projected.sourceEntry as unknown as SessionEntry).id),
  );

  return buildHistoryFromChain(entries, leafId, contextIds, (entry) => entryToUiMessage(entry, options));
}

/**
 * Render the SDK's effective context while retaining source IDs for navigation.
 * Raw history is built separately. Edited thinking stays inline because deferred
 * blocks are fetched from the original entry by block index.
 */
export function buildSessionContext(
  entries: SessionEntry[],
  leafId?: string | null,
  options: { deferThinking?: boolean; deferToolResultImages?: boolean } = {},
): SessionContext {
  const byId = new Map<string, SessionEntry>();
  for (const e of entries) byId.set(e.id, e);

  const projection = piBuildSessionProjection(
    entries as unknown as PiSessionEntry[],
    leafId,
    byId as unknown as Map<string, PiSessionEntry>,
  );

  const editedIds = new Set<string>();
  for (const { sourceEntry } of projection.entries) {
    if (sourceEntry.type === "context_edit") editedIds.add(sourceEntry.targetId);
  }

  const messages: AgentMessage[] = [];
  const entryIds: string[] = [];
  for (const projected of projection.entries) {
    if (projected.messages.length === 0) continue;
    const source = projected.sourceEntry as unknown as SessionEntry;
    const message = projected.messages[0];
    // Projected content can differ from the raw entry; keep all other metadata.
    const effectiveEntry: SessionEntry = source.type === "message"
      ? { ...source, message: message as unknown as SessionMessage }
      : source.type === "custom_message" && message.role === "custom"
        ? { ...source, content: message.content as typeof source.content }
        : source;
    // Compaction's recorded system message is provider input, not a chat row.
    const m = entryToUiMessage(effectiveEntry, editedIds.has(source.id)
      ? { ...options, deferThinking: false }
      : options);
    if (m) {
      messages.push(m);
      entryIds.push(source.id);
    }
  }

  return {
    messages,
    entryIds,
    thinkingLevel: projection.thinkingLevel,
    model: projection.model,
  };
}

function parseEntryTimestamp(timestamp: string): number | undefined {
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function base64ImageInfo(block: unknown): { bytes: number; mime?: string } | null {
  if (!isRecord(block) || block.type !== "image") return null;

  let data: string | undefined;
  let mime: string | undefined;
  if (typeof block.data === "string") {
    data = block.data;
    mime = typeof block.mimeType === "string" ? block.mimeType : undefined;
  } else if (isRecord(block.source) && block.source.type === "base64" && typeof block.source.data === "string") {
    data = block.source.data;
    mime = typeof block.source.media_type === "string" ? block.source.media_type : undefined;
  }
  if (!data) return null;

  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return { bytes: Math.max(0, Math.floor(data.length * 3 / 4) - padding), mime };
}

function omitToolResultBase64Images(message: AgentMessage): AgentMessage {
  if (message.role !== "toolResult") return message;

  let omitted = 0;
  let bytes = 0;
  const mimes = new Set<string>();
  const content = message.content.filter((block) => {
    const image = base64ImageInfo(block);
    if (!image) return true;
    omitted += 1;
    bytes += image.bytes;
    if (image.mime) mimes.add(image.mime);
    return false;
  });
  if (omitted === 0) return message;

  const mimeText = mimes.size > 0 ? `: ${[...mimes].join(", ")}` : "";
  content.push({
    type: "text",
    text: `[${omitted} tool result image${omitted === 1 ? "" : "s"} omitted from initial history payload${mimeText}, ~${bytes} bytes]`,
  });
  return { ...message, content };
}

// Convert a session entry on the active branch into a UI message.
// Returns null for entries that do not map to chat history (metadata, non-message types).
function entryToUiMessage(
  entry: SessionEntry,
  options: { deferThinking?: boolean; deferToolResultImages?: boolean },
): AgentMessage | null {
  // Supported message roles: user, assistant, toolResult, bashExecution.
  // bashExecution messages enter the case "message" branch (entry.type === "message").
  // The early return at line below ("!options.deferThinking || message.role !== "assistant"")
  // passes non-assistant messages — including bashExecution — through unchanged.
  // normalizeToolCalls is a secondary guard (returns non-assistant messages as-is).
  switch (entry.type) {
    case "message": {
      // Transcript system messages carry the prompt and tool loadout (Pi >= 0.86).
      // They are provider input, not conversation, so they never render.
      if (entry.message.role === "system") return null;
      const base = options.deferToolResultImages
        ? omitToolResultBase64Images(normalizeToolCalls(entry.message))
        : normalizeToolCalls(entry.message);
      // The entry timestamp is the only record of when generation ended — the
      // message's own timestamp is when it started. Carry it so the UI can time
      // thinking and tool execution separately instead of conflating them.
      const message = base.role === "assistant"
        ? { ...base, endedAt: parseEntryTimestamp(entry.timestamp) }
        : base;
      if (!options.deferThinking || message.role !== "assistant") return message;
      return {
        ...message,
        content: message.content.map((block) => (
          block.type === "thinking" && block.thinking.trim() !== ""
            ? { ...block, thinking: "", deferred: true }
            : block
        )),
      };
    }
    case "compaction":
      return {
        role: "custom",
        customType: "compaction",
        content: entry.summary,
        display: true,
        details: {
          tokensBefore: entry.tokensBefore,
          firstKeptEntryId: entry.firstKeptEntryId,
        },
        timestamp: parseEntryTimestamp(entry.timestamp),
      };
    case "branch_summary":
      if (!entry.summary) return null;
      return {
        role: "user",
        content: `*The conversation briefly explored another branch and returned with this summary:*\n\n${entry.summary}`,
        timestamp: parseEntryTimestamp(entry.timestamp),
      };
    case "custom_message":
      return {
        role: "custom",
        customType: entry.customType,
        content: entry.content,
        display: entry.display,
        details: entry.details,
        timestamp: parseEntryTimestamp(entry.timestamp),
      };
    default:
      return null;
  }
}
