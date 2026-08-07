/**
 * Markdown → Telegram HTML converter (design §15.4).
 *
 * Telegram supports a restricted HTML subset. This converter:
 *   - escapes `&` `<` `>` everywhere first;
 *   - extracts fenced code blocks and renders them as `<pre><code>`;
 *   - applies inline transforms (code, bold, italic, strike, links) to prose;
 *   - whitelists only `http`/`https`/`tg://` link protocols;
 *   - falls back to escaped plain text (no parseMode) if conversion fails, so a
 *     parse error can never break message delivery (§15.4 "解析失败时自动回退").
 *
 * Intentionally dependency-free and conservative — it does not attempt a full
 * CommonMark parse. Long output is chunked by the stream renderer, not here.
 */

export interface ConvertedMessage {
  text: string;
  parseMode: "HTML";
}

export interface ConversionResult {
  /** Best-effort HTML conversion (parseMode HTML). */
  html: ConvertedMessage;
  /** Escaped plain text — used as a fallback and for length measurement. */
  plain: string;
}

const LINK_PROTOCOL_WHITELIST = /^(https?:|tg:)/i;

/** Converts Markdown into Telegram-HTML + an escaped plain-text fallback. */
export function markdownToTelegramHtml(markdown: string): ConversionResult {
  const source = markdown ?? "";
  const plain = escapeHtml(source);

  try {
    const html = convert(source);
    if (!html || html.length === 0) return { html: { text: plain, parseMode: "HTML" }, plain };
    return { html: { text: html, parseMode: "HTML" }, plain };
  } catch {
    return { html: { text: plain, parseMode: "HTML" }, plain };
  }
}

function convert(source: string): string {
  const out: string[] = [];
  const lines = source.split("\n");
  let i = 0;
  let inParagraph: string[] = [];

  const flushParagraph = () => {
    if (inParagraph.length === 0) return;
    out.push(inline(inParagraph.join("\n")));
    inParagraph = [];
  };

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block ```
    const fence = /^```(.*)$/.exec(line);
    if (fence) {
      flushParagraph();
      const lang = fence[1].trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // consume closing fence (if present)
      const code = escapeHtml(codeLines.join("\n"));
      out.push(
        lang
          ? `<pre><code class="language-${escapeAttr(lang)}">${code}</code></pre>`
          : `<pre><code>${code}</code></pre>`,
      );
      continue;
    }

    // Headings (# .. ######)
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      out.push(`<b>${inline(heading[2])}</b>`);
      i++;
      continue;
    }

    inParagraph.push(line);
    i++;
  }
  flushParagraph();
  return out.join("\n");
}

/** Inline transforms on a single prose block (no code fences/headings). */
function inline(text: string): string {
  // First protect inline code spans so their content isn't reformatted.
  const segments: string[] = [];
  let rest = text;
  while (true) {
    const m = /`([^`]+)`/.exec(rest);
    if (!m) break;
    segments.push(proseTransform(rest.slice(0, m.index)));
    segments.push(`<code>${escapeHtml(m[1])}</code>`);
    rest = rest.slice((m.index ?? 0) + m[0].length);
  }
  segments.push(proseTransform(rest));
  return segments.join("");
}

/** Bold/italic/strike/link transforms on code-free prose. */
function proseTransform(text: string): string {
  let out = escapeHtml(text);
  // Bold: **x** or __x__
  out = out.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  out = out.replace(/__([^_]+)__/g, "<b>$1</b>");
  // Italic: *x* or _x_
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<i>$2</i>");
  out = out.replace(/(^|[^_])_([^_\n]+)_/g, "$1<i>$2</i>");
  // Strikethrough: ~~x~~
  out = out.replace(/~~([^~]+)~~/g, "<s>$1</s>");
  // Links: [text](url) — whitelisted protocols only.
  out = out.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_full, label: string, url: string) => {
      if (!LINK_PROTOCOL_WHITELIST.test(url)) return label;
      return `<a href="${escapeAttr(url)}">${label}</a>`;
    },
  );
  return out;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

/**
 * Splits a plain-text string into chunks ≤ maxLen on newline boundaries so a
 * long reply never exceeds Telegram's 4096-char limit (§15.3 suggests 3,800).
 */
export function chunkPlainText(text: string, maxLen = 3_800): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let cut = remaining.lastIndexOf("\n", maxLen);
    if (cut <= 0) cut = maxLen;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n/, "");
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}
