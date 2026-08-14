/**
 * Text helpers shared by the session-search extractor and scorer.
 *
 * Ported from the standalone `codex-recall` prototype, with two changes: the
 * secret list covers the providers pi-hub actually talks to, and redaction runs
 * at extract time rather than render time because the search cache is written
 * to disk (see lib/search/cache.ts).
 */

/**
 * Shapes worth redacting before any session text reaches the cache or a model
 * prompt. This is a safety net, not a scanner: it catches the common
 * `sk-`/`ghp_` style tokens and `key: value` assignments. Session transcripts
 * really do contain live keys — one turned up in this repo's own history.
 */
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-(?:proj-|or-v1-|ant-api\d\d-)?[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/g,
  /\bAIza[A-Za-z0-9_-]{30,}\b/g,
  /\btskey-[A-Za-z0-9-]{10,}\b/g,
  /((?:api[_ -]?key|access[_ -]?token|auth[_ -]?token|bearer|secret|password)\s*(?:is|:|=)\s*["']?)[^\s"'`,;]{12,}/gi,
];

/**
 * Query words that describe the act of searching rather than the thing being
 * searched for. "which session did we talk about X" should score on X alone.
 */
const QUERY_STOP_WORDS = new Set([
  "a", "about", "an", "and", "are", "at", "be", "but", "by", "chat", "conversation",
  "did", "do", "does", "find", "for", "from", "get", "had", "has", "have", "how",
  "i", "in", "into", "is", "it", "its", "locate", "look", "looking", "me", "my",
  "of", "on", "or", "our", "search", "session", "sessions", "show", "so", "some",
  "talk", "talked", "that", "the", "their", "them", "then", "there", "these",
  "they", "this", "thread", "to", "up", "us", "was", "we", "were", "what", "when",
  "where", "which", "while", "who", "why", "with", "you", "your",
]);

export function normalizeText(value: unknown): string {
  return String(value ?? "")
    .replace(/\u0000/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function redactSecrets(value: unknown): string {
  let text = String(value ?? "");
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, (match: string, prefix?: string) =>
      typeof prefix === "string" ? `${prefix}[redacted]` : "[redacted]");
  }
  return text;
}

export function truncate(value: unknown, max = 320): string {
  const text = normalizeText(value);
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/**
 * Split a query into scoreable terms. Quoted spans survive whole so a phrase
 * search still works; bare words are lowercased, de-stopworded and capped so a
 * pasted paragraph cannot turn into a 200-term scan.
 */
export function queryTerms(query: string): string[] {
  const quoted = [...String(query ?? "").matchAll(/"([^"\n]{2,120})"/g)]
    .map((match) => match[1].trim().toLowerCase())
    .filter(Boolean);
  const words = (String(query ?? "").toLowerCase().match(/[\p{L}\p{N}_.-]{2,}/gu) ?? [])
    .filter((word) => !QUERY_STOP_WORDS.has(word))
    .slice(0, 16);
  return [...new Set([...quoted, ...words])];
}

/** Fraction of `terms` present in `haystack`, 0 when there are no terms. */
export function coverage(haystack: string, terms: string[]): number {
  if (!terms.length) return 0;
  const lowered = haystack.toLowerCase();
  let hits = 0;
  for (const term of terms) if (lowered.includes(term)) hits += 1;
  return hits / terms.length;
}

/**
 * Cheap token estimate. The picker needs a budget, not accounting: a real
 * tokenizer would mean shipping vocab files for every provider, and the
 * chars/4 proxy was within 3% of the reported usage on a 271k-token payload.
 */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}
