/**
 * Turning selected transcript text into context for the next message.
 *
 * The selection is not spliced into what the user types. It travels as an
 * attachment on the composer and is prefixed onto the message only at send time,
 * so a question can be written and edited freely without a quoted block sitting
 * in the middle of it.
 *
 * The prefix is deliberately English rather than localised: it is read by the
 * model, not shown in the UI, and the surrounding message is whatever language the
 * user wrote in.
 */

const CONTEXT_LABEL = "Context I selected from the conversation:";

/**
 * Blockquote every line, so a multi-line selection stays one unit in markdown and
 * cannot be mistaken for the user's own prose. Blank lines keep their marker,
 * otherwise the quote ends early and the remainder renders as body text.
 */
export function quoteSnippet(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => (line.trim().length > 0 ? `> ${line}` : ">"))
    .join("\n");
}

/**
 * The block that goes ahead of the typed message. Empty when nothing is attached,
 * so the common path adds no leading whitespace at all.
 */
export function buildContextPrefix(snippets: string[]): string {
  const usable = snippets.map((s) => s.trim()).filter((s) => s.length > 0);
  if (usable.length === 0) return "";
  return `${CONTEXT_LABEL}\n\n${usable.map(quoteSnippet).join("\n\n")}\n\n`;
}

/** Compose what actually gets sent. */
export function composeWithContext(snippets: string[], typed: string): string {
  return `${buildContextPrefix(snippets)}${typed}`;
}

/** One-line label for a snippet chip: the first non-empty line, clipped. */
export function snippetPreview(text: string, maxChars = 48): string {
  const firstLine = text.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "";
  const clean = firstLine.trim();
  return clean.length > maxChars ? `${clean.slice(0, maxChars - 1)}…` : clean;
}

/** Line count, for a chip to say a snippet is more than what it shows. */
export function snippetLineCount(text: string): number {
  return text.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
}
