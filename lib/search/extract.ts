/**
 * Pulls the searchable text out of one session transcript.
 *
 * Only user and assistant *text* parts are kept. That is 2.4% of the corpus on
 * this machine (5 MB of 206 MB): thinking blocks are 22 MB and tool calls and
 * results are 84 MB. Dropping them keeps the whole index small enough to hold in
 * memory and to hand to a model, and it is also what makes results readable —
 * a filename appears in hundreds of tool calls but in few actual sentences.
 *
 * The JSONL is parsed here rather than through lib/session-reader's
 * getSessionEntries: that path builds full render-ready messages with tool
 * pairing and diff state, all of which would be discarded immediately.
 */
import { readFileSync } from "fs";
import { normalizeText, redactSecrets } from "./text.ts";

/**
 * The skill-expansion collapser is injected rather than imported so this module
 * keeps only type-level dependencies. Every tested module under lib/ follows
 * that rule: `node --experimental-strip-types` erases type imports but cannot
 * resolve the "@/" alias, so a runtime import here would make the module
 * untestable. lib/search/cache.ts passes the real skillExpansionToCommand.
 */
export interface ExtractOptions {
  collapseSkillExpansion?: (text: string) => string | null;
}

export interface ExtractedMessage {
  role: "user" | "assistant";
  text: string;
}

export interface ExtractedSession {
  /** Session id as recorded in the transcript header, not the file name. */
  id: string;
  path: string;
  messages: ExtractedMessage[];
  /** Total characters of message text, used for payload budgeting. */
  chars: number;
}

/**
 * Message openings that carry no search signal. Scheduled-run headers are the
 * only one that shows up in volume; those sessions are normally excluded by
 * isTaskRunSession already, so this is a second line of defence for runs whose
 * name does not match the pattern.
 */
const BOILERPLATE_PREFIXES = [
  "[pi hub scheduled execution]",
  "<environment_context>",
  "<permissions instructions>",
  "# agents.md instructions",
];

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const record = part as { type?: unknown; text?: unknown };
    if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
  }
  return parts.join("\n");
}

/**
 * Normalise one message's text, or return null when it should not be indexed.
 * Skill invocations arrive as the SDK-expanded `<skill …>` block; collapse them
 * to the command the user actually typed, mirroring MessageView and the sidebar.
 */
export function prepareMessageText(raw: string, options: ExtractOptions = {}): string | null {
  const collapsed = options.collapseSkillExpansion?.(raw) ?? raw;
  const text = normalizeText(redactSecrets(collapsed));
  if (!text) return null;
  const lowered = text.toLowerCase();
  if (BOILERPLATE_PREFIXES.some((prefix) => lowered.startsWith(prefix))) return null;
  return text;
}

/** Parse a transcript into searchable text. Returns null when unreadable. */
export function extractSessionText(
  filePath: string,
  options: ExtractOptions = {},
): ExtractedSession | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  const messages: ExtractedMessage[] = [];
  let id = "";
  let chars = 0;

  for (const line of raw.split("\n")) {
    if (!line) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      // A transcript being appended to can end mid-line; skip it rather than
      // abandoning every message already parsed.
      continue;
    }
    const record = entry as {
      type?: unknown;
      id?: unknown;
      message?: { role?: unknown; content?: unknown };
    };

    // Only the `session` header record carries the session id. `session_info`
    // also has an `id`, but it is a short per-fork id ("6a1629d2") alongside a
    // parentId — reading that one would key the cache on the wrong value.
    if (record.type === "session" && typeof record.id === "string" && record.id) {
      id ||= record.id;
    }
    if (record.type !== "message") continue;

    const role = record.message?.role;
    if (role !== "user" && role !== "assistant") continue;

    const prepared = prepareMessageText(textFromContent(record.message?.content), options);
    if (!prepared) continue;
    messages.push({ role, text: prepared });
    chars += prepared.length;
  }

  return { id, path: filePath, messages, chars };
}
