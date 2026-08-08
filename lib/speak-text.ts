/**
 * Prepares assistant text for TTS: strips markdown formatting so the spoken
 * output reads like plain speech instead of raw syntax.
 */
export function stripMarkdownForTTS(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ") // fenced code blocks
    .replace(/`([^`]+)`/g, "$1") // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links → label text
    .replace(/^#{1,6}\s+/gm, "") // headings
    .replace(/^\s{0,3}>\s?/gm, "") // blockquotes
    .replace(/\*\*([^*]+)\*\*/g, "$1") // bold
    .replace(/(^|\s)\*([^*\n]+)\*/g, "$1$2") // italic
    .replace(/^\s*[-*+]\s+/gm, "") // bullet lists
    .replace(/^\s*\d+[.)]\s+/gm, "") // numbered lists
    .replace(/^\s*[-=]{3,}\s*$/gm, " ") // hr
    .replace(/^[\s-]+$/gm, " ") // table separator rows (dash-only)
    .replace(/[|_~#*`>]/g, " ") // stray markers/pipes
    .replace(/\b[0-9a-f]{16,}\b/g, (m) => m.slice(0, 7)) // long commit hashes → short
    .replace(/\b(commit|SHA-1|sha1)\s+[0-9a-f]{7,}\b/g, (m) => {
      // "commit 92d2d8f1f2a…" → keep the word + short hash
      const [word] = m.split(/\s+/);
      const hash = m.split(/\s+/)[1]?.slice(0, 7) ?? "";
      return `${word} ${hash}`;
    })
    .replace(/\s+/g, " ")
    .trim();
}

/** Max characters read aloud per message (keeps car sessions sane). */
export const TTS_MAX_CHARS = 3000;

// ---------------------------------------------------------------------------
// Fluent speech extraction: keep only the narrative prose of a reply — skip
// code, tables, lists, paths and command fragments. Speak like a person.
// ---------------------------------------------------------------------------

function isCodeBlock(seg: string): boolean {
  return seg.startsWith("```") || seg.includes("```");
}

function isTable(seg: string): boolean {
  return (seg.match(/\|/g)?.length ?? 0) >= 2 && seg.includes("\n");
}

function isListFragment(seg: string): boolean {
  const lines = seg.split("\n").filter(Boolean);
  if (lines.length === 0) return false;
  return lines.every((l) => /^\s*(?:[-*+]|\d+[.)]|>)\s+/.test(l));
}

function isCodeyLine(seg: string): boolean {
  // paths, commands, assignments, shell-ish content
  return (
    /[\\/][A-Za-z0-9_.-]+[\\/]/.test(seg) || // path with separators
    /\b(?:npm|yarn|pnpm|git|pip|npx|curl|cd)\s+/.test(seg) ||
    /\b[A-Za-z0-9_.-]+\s*=\s*[^ ]/.test(seg) || // key=value
    /->|=>|::/.test(seg) ||
    /^[^A-Za-z]{0,3}[A-Za-z0-9_.-]+\.[A-Za-z0-9]+\s*$/.test(seg) // file.ext
  );
}

function isFluentSentence(sentence: string): boolean {
  const words = sentence.split(/\s+/).filter(Boolean);
  if (words.length < 4) return false;
  const letters = sentence.replace(/[^\p{L}]/gu, "").length;
  if (letters / Math.max(sentence.length, 1) < 0.6) return false;
  if (/[\\/][A-Za-z]/.test(sentence)) return false; // path-like
  if (/\b(?:npm|git|pip|npx|curl|cd|sudo)\s+/.test(sentence)) return false;
  if (/[=<>]\s*[A-Za-z0-9]/.test(sentence)) return false; // code-ish
  return true;
}

/**
 * Reduces an assistant reply to its fluent prose: paragraphs whose sentences
 * read naturally. Falls back to the markdown-stripped text if nothing fluent
 * survives (better to read something than silence).
 */
export function extractFluentSpeech(raw: string): string {
  const paragraphs = raw.split(/\n{2,}/);
  const kept: string[] = [];
  for (const paragraph of paragraphs) {
    const seg = paragraph.trim();
    if (!seg) continue;
    if (isCodeBlock(seg) || isTable(seg) || isListFragment(seg) || isCodeyLine(seg)) {
      continue;
    }
    const clean = stripMarkdownForTTS(seg);
    if (!clean) continue;
    const sentences = clean.split(/(?<=[.!?])\s+/);
    const fluent = sentences.filter(isFluentSentence);
    if (fluent.length > 0) kept.push(fluent.join(" "));
  }
  const result = kept.join(" ").trim();
  return result || stripMarkdownForTTS(raw);
}
