/**
 * The conversation as it was actually held, which is not the same thing as the
 * model's context.
 *
 * The SDK's context builder returns what the model sees, so after a compaction
 * it starts at the summary and everything earlier disappears. In a terminal that
 * is invisible — the scrollback stays on screen — but pi-hub rebuilds the chat
 * from the session file on every load, so compacting used to erase the visible
 * history even though all of it is still on disk.
 *
 * Kept in its own module, with the entry→message conversion injected, because
 * lib/session-reader.ts imports `./normalize` extensionlessly and therefore
 * cannot be loaded by the plain-node test runner.
 */

export type ChainEntry = { id: string; parentId?: string | null };

export type SessionHistoryResult<TMessage> = {
  messages: TMessage[];
  entryIds: string[];
  /** Index into `messages` where the model's context starts; -1 if none of it is. */
  contextStartIndex: number;
  /** How many messages precede the context — what compaction dropped. */
  droppedCount: number;
};

/**
 * Walk leaf → root and reverse, then mark where the context begins.
 *
 * The in-context entries are a contiguous suffix of the chain (measured on a real
 * session: 319 entries, of which the 74 context entries occupied positions
 * 245-318), so a single index describes the split.
 */
export function buildHistoryFromChain<TEntry extends ChainEntry, TMessage>(
  entries: TEntry[],
  leafId: string | null | undefined,
  contextIds: ReadonlySet<string>,
  toMessage: (entry: TEntry) => TMessage | null,
): SessionHistoryResult<TMessage> {
  const byId = new Map<string, TEntry>();
  for (const entry of entries) byId.set(entry.id, entry);

  const chain: TEntry[] = [];
  // A visited set rather than a depth cap: a corrupt file with a parent cycle
  // must terminate, and silently truncating a deep-but-valid chain would be a
  // worse failure than the one being guarded against.
  const visited = new Set<string>();
  let cursor: string | null | undefined = leafId ?? entries[entries.length - 1]?.id;
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    const entry = byId.get(cursor);
    if (!entry) break;
    chain.push(entry);
    cursor = entry.parentId;
  }
  chain.reverse();

  const messages: TMessage[] = [];
  const entryIds: string[] = [];
  let contextStartIndex = -1;
  for (const entry of chain) {
    const message = toMessage(entry);
    // Entries that render nothing (model_change, thinking_level_change, …) must
    // be absent from BOTH arrays: the UI indexes entryIds by message position to
    // resolve fork and navigate targets.
    if (message === null || message === undefined) continue;
    if (contextStartIndex === -1 && contextIds.has(entry.id)) contextStartIndex = messages.length;
    messages.push(message);
    entryIds.push(entry.id);
  }

  return {
    messages,
    entryIds,
    contextStartIndex,
    droppedCount: contextStartIndex === -1 ? 0 : contextStartIndex,
  };
}
