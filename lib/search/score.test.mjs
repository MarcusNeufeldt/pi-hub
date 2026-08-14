import assert from "node:assert/strict";
import test from "node:test";
import { extractSnippet, recencyBoost, scoreSessions } from "./score.ts";

const session = (id, over = {}) => ({
  id,
  name: "",
  firstMessage: "",
  cwd: "",
  modifiedMs: 0,
  messages: [],
  ...over,
});

const NOW = 1_760_000_000_000;

test("a name match outranks a body-only match for the same query", () => {
  const results = scoreSessions([
    session("body", { messages: [{ role: "user", text: "we discussed the model catalog at length" }] }),
    session("named", { name: "model catalog refresh" }),
  ], "model catalog", { nowMs: NOW });

  assert.equal(results[0].id, "named");
  assert.equal(results[0].matchSource, "name");
  assert.equal(results[1].matchSource, "context");
});

test("sessions matching nothing are excluded, not ranked last", () => {
  const results = scoreSessions([
    session("hit", { messages: [{ role: "user", text: "about pricing" }] }),
    session("miss", { messages: [{ role: "user", text: "completely unrelated" }] }),
  ], "pricing", { nowMs: NOW });

  assert.equal(results.length, 1);
  assert.equal(results[0].id, "hit");
});

test("more term coverage beats higher density of one term", () => {
  const both = session("both", {
    messages: [{ role: "user", text: "wedged turn and the mcp deadline" }],
  });
  const oneRepeated = session("one", {
    messages: [{ role: "user", text: Array(30).fill("wedged").join(" ") }],
  });
  const results = scoreSessions([oneRepeated, both], "wedged mcp", { nowMs: NOW });
  assert.equal(results[0].id, "both");
});

test("recency only breaks ties, it cannot outweigh a matched term", () => {
  const fresh = session("fresh", {
    modifiedMs: NOW,
    messages: [{ role: "user", text: "alpha" }],
  });
  const staleButBetter = session("stale", {
    modifiedMs: NOW - 400 * 86_400_000,
    messages: [{ role: "user", text: "alpha beta" }],
  });
  const results = scoreSessions([fresh, staleButBetter], "alpha beta", { nowMs: NOW });
  assert.equal(results[0].id, "stale", "coverage must dominate recency");
});

test("recency boost decays and is bounded", () => {
  assert.ok(recencyBoost(NOW, NOW) <= 0.15);
  assert.ok(recencyBoost(NOW - 400 * 86_400_000, NOW) < 0.01);
  assert.equal(recencyBoost(undefined, NOW), 0);
});

test("an empty query returns the most recent sessions", () => {
  const results = scoreSessions([
    session("old", { modifiedMs: NOW - 10_000 }),
    session("new", { modifiedMs: NOW }),
  ], "   ", { nowMs: NOW });
  assert.deepEqual(results.map((r) => r.id), ["new", "old"]);
});

test("a query of only stop words behaves like an empty query", () => {
  const results = scoreSessions([
    session("a", { modifiedMs: NOW, messages: [{ role: "user", text: "anything" }] }),
  ], "which session did we", { nowMs: NOW });
  assert.equal(results.length, 1);
});

test("snippets show the matched term in context", () => {
  const results = scoreSessions([
    session("s", {
      messages: [{ role: "user", text: `${"x".repeat(200)} deepseek pricing ${"y".repeat(200)}` }],
    }),
  ], "deepseek", { nowMs: NOW });

  assert.equal(results[0].snippets.length, 1);
  assert.match(results[0].snippets[0], /deepseek/);
  assert.ok(results[0].snippets[0].startsWith("…"), "elision marked at the start");
});

test("snippet returns null when the term is absent", () => {
  assert.equal(extractSnippet("nothing here", "absent"), null);
});

test("limit caps the candidate set", () => {
  const many = Array.from({ length: 60 }, (_, i) =>
    session(`s${i}`, { messages: [{ role: "user", text: "pricing" }] }));
  assert.equal(scoreSessions(many, "pricing", { limit: 25, nowMs: NOW }).length, 25);
});
