// Guards for carrying a transcript selection into the composer as context.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  buildContextPrefix,
  composeWithContext,
  quoteSnippet,
  snippetLineCount,
  snippetPreview,
} = await jiti.import("./selection-context.ts");

test("nothing attached adds nothing at all", () => {
  // Not even a newline: the overwhelmingly common send has no context, and a
  // stray leading blank line would change every message the agent receives.
  assert.equal(buildContextPrefix([]), "");
  assert.equal(composeWithContext([], "just a question"), "just a question");
});

test("whitespace-only selections are dropped rather than quoted", () => {
  assert.equal(buildContextPrefix(["   ", "\n\n"]), "");
  assert.equal(composeWithContext(["  "], "hi"), "hi");
});

test("every line is quoted, blank lines included", () => {
  // A blank line without its marker ends the blockquote, and the rest of the
  // selection would render as the user's own prose.
  assert.equal(quoteSnippet("a\n\nb"), "> a\n>\n> b");
  assert.equal(quoteSnippet("  indented"), ">   indented");
});

test("context precedes the typed question", () => {
  const out = composeWithContext(["selected line"], "why does this happen?");
  assert.match(out, /^Context I selected from the conversation:\n\n> selected line\n\nwhy does this happen\?$/);
});

test("several selections each keep their own quote block", () => {
  const out = buildContextPrefix(["one", "two"]);
  assert.match(out, /> one\n\n> two/);
  // One label for the set, not one per snippet.
  assert.equal(out.split("Context I selected").length - 1, 1);
});

test("the prefix ends separated from the question", () => {
  const out = composeWithContext(["x"], "q");
  assert.ok(out.includes("> x\n\nq"), "quote and question must not run together");
});

test("snippetPreview takes the first non-empty line and clips it", () => {
  assert.equal(snippetPreview("\n\nfirst real line\nsecond"), "first real line");
  assert.equal(snippetPreview("short"), "short");
  const long = "x".repeat(80);
  const preview = snippetPreview(long, 10);
  assert.equal(preview.length, 10);
  assert.ok(preview.endsWith("…"));
});

test("snippetLineCount ignores blank lines", () => {
  assert.equal(snippetLineCount("a\n\nb\n   \nc"), 3);
  assert.equal(snippetLineCount("only"), 1);
});

test("slash commands are matched on what was typed, not the composed message", () => {
  // Prefixing context would hide a leading "/" and silently turn every builtin
  // command into prose. Both send paths do their own slash check.
  const source = readFileSync(new URL("../components/ChatInput.tsx", import.meta.url), "utf8");
  assert.match(source, /typed\.startsWith\("\/"\) && onBuiltinCommand/);
  assert.match(source, /typed\.startsWith\("\/"\) && onPromptWithStreamingBehavior/);
  assert.doesNotMatch(source, /msg\.startsWith\("\/"\)/);
});

test("every send path carries the attached context", () => {
  // handleSend and sendQueued (steer / follow-up) both end in clearInput, which
  // drops the snippets. A path that clears without composing loses them silently.
  const source = readFileSync(new URL("../components/ChatInput.tsx", import.meta.url), "utf8");
  const composeCalls = source.split("composeWithContext(").length - 1;
  assert.equal(composeCalls, 2, "expected handleSend and sendQueued to compose context");
});

test("attached context is cleared once the message is sent", () => {
  // Otherwise the next question silently carries the previous one's quotes.
  const source = readFileSync(new URL("../components/ChatInput.tsx", import.meta.url), "utf8");
  const clearInput = source.slice(source.indexOf("const clearInput = useCallback"));
  assert.match(clearInput.slice(0, 400), /setContextSnippets\(\[\]\)/);
});

test("the selection bar labels come from i18n in both locales", () => {
  const keys = [
    "selection.toolbar", "selection.addToChat", "selection.explain",
    "selection.improve", "selection.shorten", "chat.removeContext", "chat.contextLines",
  ];
  for (const file of ["en.ts", "zh-CN.ts"]) {
    const messages = readFileSync(new URL(`./i18n/messages/${file}`, import.meta.url), "utf8");
    for (const key of keys) {
      assert.equal(messages.split(`"${key}"`).length - 1, 1, `${file} needs exactly one ${key}`);
    }
  }
  // And the component reads them rather than shipping English literals.
  const bar = readFileSync(new URL("../components/SelectionActions.tsx", import.meta.url), "utf8");
  assert.match(bar, /t\(intent\.labelKey\)/);
  assert.match(bar, /aria-label=\{t\("selection\.toolbar"\)\}/);
});
