import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { extractAssistantText } = await jiti.import("./telegram-prompt-runner.ts");
test("extractAssistantText: joins text blocks from an assistant message", () => {
  const msg = { role: "assistant", content: [{ type: "text", text: "Hello " }, { type: "text", text: "world" }] };
  assert.equal(extractAssistantText(msg), "Hello world");
});
test("extractAssistantText: ignores non-assistant + non-text blocks", () => {
  assert.equal(extractAssistantText({ role: "user", content: [{ type: "text", text: "x" }] }), "");
  assert.equal(extractAssistantText({ role: "assistant", content: [{ type: "toolCall", name: "Read" }] }), "");
  assert.equal(extractAssistantText({ role: "assistant", content: "plain string" }), "plain string");
  assert.equal(extractAssistantText(null), "");
});
