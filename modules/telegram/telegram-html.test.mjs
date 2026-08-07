import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { markdownToTelegramHtml, chunkPlainText } = await jiti.import("./telegram-html.ts");
const { SqliteTelegramStore } = await jiti.import("./sqlite-telegram-store.ts");
const { TelegramStreamRenderer } = await jiti.import("./telegram-stream-renderer.ts");

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "pihub-tg-html-"));
  return { store: SqliteTelegramStore.open(join(dir, "app.db")), dir };
}

// ---------------------------------------------------------------------------
// HTML conversion
// ---------------------------------------------------------------------------

test("html: escapes ampersand and angle brackets in plain text", () => {
  const { html } = markdownToTelegramHtml("a < b & c > d");
  assert.equal(html.text, "a &lt; b &amp; c &gt; d");
});

test("html: fenced code block is escaped and not reformatted", () => {
  const md = "```\n**not bold** <tag>\n```";
  const { html } = markdownToTelegramHtml(md);
  assert.equal(html.text, "<pre><code>**not bold** &lt;tag&gt;</code></pre>");
});

test("html: inline code, bold, italic transforms", () => {
  const { html } = markdownToTelegramHtml("this is `code` and **bold** and *italic*");
  assert.ok(html.text.includes("<code>code</code>"));
  assert.ok(html.text.includes("<b>bold</b>"));
  assert.ok(html.text.includes("<i>italic</i>"));
});

test("html: inline code protects its content from bold/italic", () => {
  const { html } = markdownToTelegramHtml("see `a **b** c`");
  assert.ok(html.text.includes("<code>a **b** c</code>"));
  assert.ok(!html.text.includes("<b>b</b>"));
});

test("html: link whitelist accepts http(s), rejects javascript", () => {
  const { html } = markdownToTelegramHtml("[ok](https://x.io) and [bad](javascript:alert(1))");
  assert.ok(html.text.includes('<a href="https://x.io">ok</a>'));
  // the bad link collapses to its label with no anchor
  assert.ok(!html.text.includes("javascript:"));
  assert.ok(html.text.includes("bad"));
});

test("html: heading rendered as bold", () => {
  const { html } = markdownToTelegramHtml("## Title");
  assert.equal(html.text, "<b>Title</b>");
});

test("html: empty / whitespace input does not crash", () => {
  const r = markdownToTelegramHtml("");
  assert.equal(r.html.text, "");
  assert.equal(r.plain, "");
});

// ---------------------------------------------------------------------------
// chunking
// ---------------------------------------------------------------------------

test("chunkPlainText: short text returns one chunk", () => {
  assert.deepEqual(chunkPlainText("hello", 100), ["hello"]);
});

test("chunkPlainText: splits on newline boundaries when possible", () => {
  const text = "line1\nline2\nline3";
  const chunks = chunkPlainText(text, 11);
  assert.ok(chunks.length >= 2);
  assert.equal(chunks.join("\n").replace(/\n+/g, "\n"), text);
});

test("chunkPlainText: hard-splits long lines with no newlines", () => {
  const text = "x".repeat(50);
  const chunks = chunkPlainText(text, 20);
  assert.equal(chunks.length, 3);
  assert.equal(chunks.reduce((a, c) => a + c.length, 0), 50);
});

// ---------------------------------------------------------------------------
// Stream renderer
// ---------------------------------------------------------------------------

function fakeTransport() {
  const calls = { send: [], edit: [], markup: [], actions: 0 };
  return {
    calls,
    lastSuccessfulSendAt: null,
    async sendMessage(input) {
      calls.send.push(input);
      return { messageId: 1000 + calls.send.length, chatId: input.chatId, date: 1 };
    },
    async editMessageText(input) {
      calls.edit.push(input);
      return true;
    },
    async editMessageReplyMarkup(chatId, messageId, kb) {
      calls.markup.push({ chatId, messageId, kb });
      return true;
    },
    async sendChatAction() {
      calls.actions++;
    },
  };
}

test("renderer: creates a message with a stop button, finalizes removing it", async () => {
  const { store, dir } = makeStore();
  try {
    const t = fakeTransport();
    const r = new TelegramStreamRenderer({ transport: t, store, chatId: 1, threadId: 0, debounceMs: 1 });
    r.startTyping();
    r.appendText("Hello ");
    r.appendText("world");
    await r.ensureMessageCreated();
    await new Promise((res) => setTimeout(res, 20)); // let debounce flush
    await r.finalize();

    assert.ok(t.calls.send.length >= 1, "message created");
    const created = t.calls.send[0];
    assert.ok(created.inlineKeyboard, "stop button present while running");
    // finalize removed the stop button via editMessageReplyMarkup([])
    assert.ok(t.calls.markup.some((m) => m.kb.length === 0), "stop button removed on finalize");
    r.stopTyping();
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renderer: summary footer counts tool calls", async () => {
  const { store, dir } = makeStore();
  try {
    const t = fakeTransport();
    const r = new TelegramStreamRenderer({ transport: t, store, chatId: 1, threadId: 0, debounceMs: 1, toolVerbosity: "summary" });
    r.recordTool("Read", false);
    r.recordTool("Bash", true);
    r.appendText("done");
    await r.ensureMessageCreated();
    await r.finalize();
    // the last sent/edited text should mention tool counts
    const last = t.calls.edit.at(-1)?.text ?? t.calls.send.at(-1)?.text ?? "";
    assert.match(last, /工具调用 2 次.*失败 1/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renderer: errors-only verbosity omits successful tools, shows failures", async () => {
  const { store, dir } = makeStore();
  try {
    const t = fakeTransport();
    const r = new TelegramStreamRenderer({ transport: t, store, chatId: 1, threadId: 0, debounceMs: 1, toolVerbosity: "errors-only" });
    r.recordTool("Read", false); // success → hidden
    r.recordTool("Grep", true); // failure → shown
    r.appendText("ok");
    await r.ensureMessageCreated();
    await r.finalize();
    const last = t.calls.edit.at(-1)?.text ?? t.calls.send.at(-1)?.text ?? "";
    assert.match(last, /失败工具.*Grep/);
    assert.ok(!/工具调用 \d+ 次/.test(last), "no summary count under errors-only");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
