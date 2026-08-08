import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { isRateLimitError } = await jiti.import("./rate-limit.ts");

test("isRateLimitError: matches common rate-limit phrasings", () => {
  assert.equal(isRateLimitError("Rate limit exceeded"), true);
  assert.equal(isRateLimitError("rate_limit hit"), true);
  assert.equal(isRateLimitError("You exceeded your quota"), true);
  assert.equal(isRateLimitError("5h limit reached"), true);
  assert.equal(isRateLimitError("Too many requests"), true);
  assert.equal(isRateLimitError("HTTP 429 Too Many Requests"), true);
  assert.equal(isRateLimitError("Service is overloaded"), true);
  assert.equal(isRateLimitError("Request capacity exceeded"), true);
});

test("isRateLimitError: false for non-rate-limit errors and empties", () => {
  assert.equal(isRateLimitError("Permission denied"), false);
  assert.equal(isRateLimitError("Prompt timed out after 5000ms"), false);
  assert.equal(isRateLimitError("Tool execution failed: ENOENT"), false);
  assert.equal(isRateLimitError(""), false);
  assert.equal(isRateLimitError(null), false);
  assert.equal(isRateLimitError(undefined), false);
});
