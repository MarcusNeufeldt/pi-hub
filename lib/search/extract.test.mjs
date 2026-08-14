import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractSessionText, prepareMessageText } from "./extract.ts";
import { coverage, estimateTokens, queryTerms, redactSecrets, truncate } from "./text.ts";

function fixture(lines) {
  const dir = mkdtempSync(join(tmpdir(), "pi-search-"));
  const file = join(dir, "session.jsonl");
  writeFileSync(file, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n"));
  return { dir, file };
}

const userMessage = (text) => ({
  type: "message",
  message: { role: "user", content: [{ type: "text", text }] },
});
const assistantMessage = (parts) => ({
  type: "message",
  message: { role: "assistant", content: parts },
});

test("redacts provider key shapes before text is stored", () => {
  // The cache is written to disk, so redaction has to happen at extract time.
  assert.match(redactSecrets("use sk-or-v1-abcdefghijklmnopqrstuvwxyz123456"), /\[redacted\]/);
  assert.match(redactSecrets("token ghp_abcdefghijklmnopqrstuvwxyz12"), /\[redacted\]/);
  assert.match(redactSecrets("tskey-auth-abcdefghijklmnop"), /\[redacted\]/);
  assert.match(redactSecrets("AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456"), /\[redacted\]/);
  assert.match(redactSecrets('api_key: "sup3rsecretvalue123"'), /\[redacted\]/);
  // The label survives so the sentence still reads, only the value is gone.
  assert.match(redactSecrets("api_key: sup3rsecretvalue123"), /^api_key: \[redacted\]$/);
});

test("leaves ordinary prose untouched", () => {
  const prose = "we fixed the wedged turn by calling destroy() instead of shutdown()";
  assert.equal(redactSecrets(prose), prose);
});

test("query terms drop search verbs and keep quoted phrases", () => {
  const terms = queryTerms('which session did we talk about "model catalog refresh" and pricing');
  assert.ok(terms.includes("model catalog refresh"), "quoted phrase kept whole");
  assert.ok(terms.includes("pricing"));
  for (const stop of ["which", "session", "did", "we", "talk", "about", "and"]) {
    assert.ok(!terms.includes(stop), `${stop} should be dropped`);
  }
});

test("query terms are capped so a pasted paragraph cannot explode the scan", () => {
  const many = Array.from({ length: 40 }, (_, i) => `term${i}`).join(" ");
  assert.ok(queryTerms(many).length <= 16);
});

test("coverage is the fraction of terms present", () => {
  assert.equal(coverage("alpha beta gamma", ["alpha", "beta"]), 1);
  assert.equal(coverage("alpha only", ["alpha", "beta"]), 0.5);
  assert.equal(coverage("nothing", []), 0);
});

test("truncate keeps short text and marks elision", () => {
  assert.equal(truncate("short", 20), "short");
  const long = truncate("x".repeat(50), 10);
  assert.equal(long.length, 10);
  assert.ok(long.endsWith("…"));
});

test("token estimate matches the chars/4 proxy", () => {
  assert.equal(estimateTokens(400), 100);
});

test("session id comes from the session header, never from session_info", () => {
  // session_info carries its own short per-fork id alongside a parentId.
  // Reading that one would key the whole cache on the wrong value.
  const { dir, file } = fixture([
    { type: "session", version: 3, id: "019fe529-real-session-id", cwd: "F:\\x" },
    { type: "session_info", id: "6a1629d2", parentId: "9be32a16", name: "subagent-reviewer-1" },
    userMessage("hello"),
  ]);
  try {
    const result = extractSessionText(file);
    assert.equal(result.id, "019fe529-real-session-id");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("keeps only user and assistant text parts", () => {
  const { dir, file } = fixture([
    { type: "session", id: "s1" },
    userMessage("question about pricing"),
    assistantMessage([
      { type: "thinking", thinking: "internal reasoning that must not be indexed" },
      { type: "text", text: "answer about pricing" },
      { type: "toolCall", name: "bash", args: { command: "ls" } },
    ]),
    { type: "message", message: { role: "toolResult", content: [{ type: "text", text: "tool output" }] } },
    { type: "model_change", model: "x" },
  ]);
  try {
    const result = extractSessionText(file);
    assert.equal(result.messages.length, 2);
    assert.deepEqual(result.messages.map((m) => m.role), ["user", "assistant"]);
    const all = result.messages.map((m) => m.text).join(" ");
    assert.ok(all.includes("question about pricing"));
    assert.ok(all.includes("answer about pricing"));
    assert.ok(!all.includes("internal reasoning"), "thinking must not be indexed");
    assert.ok(!all.includes("tool output"), "tool results must not be indexed");
    assert.equal(result.chars, "question about pricing".length + "answer about pricing".length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("survives a truncated trailing line", () => {
  // A transcript being appended to can end mid-line; earlier messages must survive.
  const { dir, file } = fixture([
    { type: "session", id: "s2" },
    userMessage("kept"),
    '{"type":"message","message":{"role":"assis',
  ]);
  try {
    const result = extractSessionText(file);
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].text, "kept");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("drops scheduled-run boilerplate", () => {
  assert.equal(prepareMessageText("[Pi Hub Scheduled Execution] This is an unattended run"), null);
  assert.equal(prepareMessageText("   "), null);
  assert.equal(prepareMessageText("real question"), "real question");
});

test("applies the injected skill-expansion collapser", () => {
  const collapsed = prepareMessageText("<skill …expanded…>", {
    collapseSkillExpansion: () => "/skill:prototype build a thing",
  });
  assert.equal(collapsed, "/skill:prototype build a thing");
});

test("falls back to raw text when the collapser returns null", () => {
  const text = prepareMessageText("ordinary message", {
    collapseSkillExpansion: () => null,
  });
  assert.equal(text, "ordinary message");
});

test("unreadable files return null rather than throwing", () => {
  assert.equal(extractSessionText(join(tmpdir(), "definitely-missing-9f3a.jsonl")), null);
});
