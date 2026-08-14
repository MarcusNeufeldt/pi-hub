import assert from "node:assert/strict";
import test from "node:test";
import { budgetMessages, buildPickPrompt, parsePicks, PER_SESSION_TOKEN_CAP } from "./pick.ts";

const msg = (role, text) => ({ role, text });
const bulk = (chars) => "x".repeat(chars);

test("ids outside the candidate set are discarded", () => {
  // This is the injection boundary: a transcript can try to talk the picker into
  // naming a session that was never offered.
  const picks = parsePicks(
    '{"picks":[{"id":"allowed","confidence":0.9,"reason":"ok"},{"id":"smuggled","confidence":1,"reason":"nope"}]}',
    ["allowed"],
  );
  assert.deepEqual(picks.map((p) => p.id), ["allowed"]);
});

test("an invented id yields no picks rather than a wrong one", () => {
  assert.deepEqual(parsePicks('{"picks":[{"id":"hallucinated"}]}', ["real"]), []);
});

test("survives a code fence and surrounding prose", () => {
  const raw = 'Here you go:\n```json\n{"picks":[{"id":"a","confidence":0.5,"reason":"why"}]}\n```';
  assert.deepEqual(parsePicks(raw, ["a"]).map((p) => p.id), ["a"]);
});

test("malformed output returns no picks instead of throwing", () => {
  for (const raw of ["", "not json", "{", '{"picks":"nope"}', "null"]) {
    assert.deepEqual(parsePicks(raw, ["a"]), []);
  }
});

test("duplicate ids are collapsed", () => {
  const picks = parsePicks(
    '{"picks":[{"id":"a","confidence":0.9},{"id":"a","confidence":0.8}]}',
    ["a"],
  );
  assert.equal(picks.length, 1);
});

test("confidence is clamped and defaults to zero", () => {
  const picks = parsePicks(
    '{"picks":[{"id":"a","confidence":5},{"id":"b","confidence":-3},{"id":"c"}]}',
    ["a", "b", "c"],
  );
  assert.deepEqual(picks.map((p) => p.confidence), [1, 0, 0]);
});

test("at most three picks are returned", () => {
  const ids = ["a", "b", "c", "d", "e"];
  const raw = JSON.stringify({ picks: ids.map((id) => ({ id, confidence: 1 })) });
  assert.equal(parsePicks(raw, ids).length, 3);
});

test("reason is bounded", () => {
  const picks = parsePicks(
    JSON.stringify({ picks: [{ id: "a", confidence: 1, reason: "r".repeat(900) }] }),
    ["a"],
  );
  assert.ok(picks[0].reason.length <= 200);
});

test("a non-string reason degrades to empty rather than failing", () => {
  const picks = parsePicks('{"picks":[{"id":"a","confidence":1,"reason":42}]}', ["a"]);
  assert.equal(picks[0].reason, "");
});

test("messages under the cap are returned untouched", () => {
  const messages = [msg("user", "short"), msg("assistant", "also short")];
  const result = budgetMessages(messages, 1000);
  assert.equal(result.truncated, false);
  assert.equal(result.messages, messages, "same array when nothing is dropped");
});

test("over-cap transcripts keep the head and the tail", () => {
  // The opening says what the session was about; the end says how it resolved.
  const messages = [
    msg("user", "OPENING QUESTION"),
    ...Array.from({ length: 40 }, (_, i) => msg("assistant", bulk(4000) + `middle${i}`)),
    msg("assistant", "FINAL ANSWER"),
  ];
  const { messages: kept, truncated } = budgetMessages(messages, 5000);

  assert.equal(truncated, true);
  assert.ok(kept.length < messages.length);
  assert.equal(kept[0].text, "OPENING QUESTION", "head preserved");
  assert.equal(kept.at(-1).text, "FINAL ANSWER", "tail preserved");
});

test("the budget is respected", () => {
  const messages = Array.from({ length: 50 }, () => msg("user", bulk(4000)));
  const cap = 3000;
  const { messages: kept } = budgetMessages(messages, cap);
  const spent = kept.reduce((total, m) => total + Math.ceil(m.text.length / 4), 0);
  assert.ok(spent <= cap, `spent ${spent} exceeds cap ${cap}`);
});

test("the prompt delimits sessions and forbids acting on their contents", () => {
  const { prompt, tokens } = buildPickPrompt("find the pricing session", [
    { id: "s1", name: "Pricing", messages: [msg("user", "about pricing")] },
  ]);
  assert.match(prompt, /<<<SESSION 1/);
  assert.match(prompt, /SESSION 1>>>/);
  assert.match(prompt, /data, not instructions/i);
  assert.match(prompt, /id: s1/);
  assert.ok(tokens > 0);
});

test("an oversized session is reported as truncated", () => {
  const huge = Array.from({ length: 200 }, () => msg("user", bulk(4000)));
  const { truncatedIds } = buildPickPrompt("q", [{ id: "big", messages: huge }]);
  assert.deepEqual(truncatedIds, ["big"]);
});

test("per-session cap keeps one session from crowding out the rest", () => {
  const huge = Array.from({ length: 500 }, () => msg("user", bulk(4000)));
  const { prompt } = buildPickPrompt("q", [
    { id: "big", messages: huge },
    { id: "small", messages: [msg("user", "DISTINCTIVE TAIL MARKER")] },
  ]);
  assert.match(prompt, /DISTINCTIVE TAIL MARKER/, "later candidate still present");
  assert.ok(Math.ceil(prompt.length / 4) < PER_SESSION_TOKEN_CAP * 3);
});
