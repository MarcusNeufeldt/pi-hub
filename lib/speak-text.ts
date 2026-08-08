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
