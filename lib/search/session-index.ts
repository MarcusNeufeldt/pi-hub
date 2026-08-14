/**
 * In-memory searchable index of session transcripts.
 *
 * Held in globalThis rather than a module constant so a dev-server hot reload
 * does not silently orphan a warm index, matching lib/session-reader.ts.
 *
 * There is deliberately no on-disk cache. A full cold build of this machine's
 * 194 sessions takes 1.6s (206 MB of JSONL at ~130 MB/s), which is cheap enough
 * to pay once per server start. Persisting it would mean a file format, a
 * version field, a migration path, and conversation text sitting in plaintext
 * outside pi's own directory — all to save under two seconds.
 */
import { statSync } from "fs";
import { listAllSessions } from "@/lib/session-reader";
import { isSidebarConversationSession } from "@/lib/session-visibility";
import { skillExpansionToCommand } from "@/lib/slash-display";
import { extractSessionText } from "./extract.ts";
import type { ScorableSession } from "./score.ts";

export interface IndexedSession extends ScorableSession {
  path: string;
  /** Cheap change detector: a transcript only ever grows or is replaced. */
  mtimeMs: number;
  size: number;
}

declare global {
  var __piSearchIndex: Map<string, IndexedSession> | undefined;
  var __piSearchIndexPromise: Promise<SearchIndexStats> | undefined;
}

export interface SearchIndexStats {
  sessions: number;
  reindexed: number;
  skipped: number;
  removed: number;
  chars: number;
  ms: number;
}

function store(): Map<string, IndexedSession> {
  globalThis.__piSearchIndex ??= new Map();
  return globalThis.__piSearchIndex;
}

/**
 * Bring the index up to date. Concurrent callers share one in-flight refresh so
 * a burst of keystrokes cannot start 20 corpus walks.
 */
export function refreshSearchIndex(): Promise<SearchIndexStats> {
  if (globalThis.__piSearchIndexPromise) return globalThis.__piSearchIndexPromise;
  const run = doRefresh().finally(() => {
    globalThis.__piSearchIndexPromise = undefined;
  });
  globalThis.__piSearchIndexPromise = run;
  return run;
}

async function doRefresh(): Promise<SearchIndexStats> {
  const startedAt = Date.now();
  const index = store();
  const sessions = await listAllSessions();

  // Worker transcripts and scheduled runs are addressable but are not
  // conversations the user is trying to find again.
  const conversations = sessions.filter((session) => isSidebarConversationSession(session));

  let reindexed = 0;
  let skipped = 0;
  const seen = new Set<string>();

  for (const session of conversations) {
    seen.add(session.id);
    let mtimeMs = 0;
    let size = 0;
    try {
      const stats = statSync(session.path);
      mtimeMs = stats.mtimeMs;
      size = stats.size;
    } catch {
      continue;
    }

    const existing = index.get(session.id);
    const unchanged = existing && existing.mtimeMs === mtimeMs && existing.size === size;
    if (unchanged) {
      // Metadata can change without the transcript changing (a rename), so
      // refresh the cheap fields even when the body is reused.
      existing.name = session.name;
      existing.firstMessage = session.firstMessage;
      existing.modifiedMs = Date.parse(session.modified) || existing.modifiedMs;
      skipped += 1;
      continue;
    }

    const extracted = extractSessionText(session.path, {
      collapseSkillExpansion: skillExpansionToCommand,
    });
    if (!extracted) continue;

    index.set(session.id, {
      id: session.id,
      path: session.path,
      name: session.name,
      firstMessage: session.firstMessage,
      cwd: session.cwd,
      modifiedMs: Date.parse(session.modified) || 0,
      messages: extracted.messages,
      mtimeMs,
      size,
    });
    reindexed += 1;
  }

  let removed = 0;
  for (const id of [...index.keys()]) {
    if (!seen.has(id)) {
      index.delete(id);
      removed += 1;
    }
  }

  let chars = 0;
  for (const entry of index.values()) {
    for (const message of entry.messages) chars += message.text.length;
  }

  return {
    sessions: index.size,
    reindexed,
    skipped,
    removed,
    chars,
    ms: Date.now() - startedAt,
  };
}

/** Current index contents. Callers should refresh first if freshness matters. */
export function indexedSessions(): IndexedSession[] {
  return [...store().values()];
}

export function indexedSession(id: string): IndexedSession | undefined {
  return store().get(id);
}

export function searchIndexSize(): number {
  return store().size;
}
