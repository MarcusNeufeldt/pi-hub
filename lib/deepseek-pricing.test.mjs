import assert from "node:assert/strict";
import test from "node:test";
import {
  isDeepSeekModel,
  isPeakAt,
  localDayKey,
  nextBoundaryAt,
  peakWindowsLocal,
  pricingStateAt,
  PRICING_EFFECTIVE_AT_MS,
  shouldRemind,
} from "./deepseek-pricing.ts";

const utc = (h, m = 0) => new Date(Date.UTC(2026, 7, 20, h, m, 0));

test("detects DeepSeek models from every provider that serves them", () => {
  // The id spelling differs per provider; the family name is the constant.
  assert.ok(isDeepSeekModel({ provider: "openrouter", modelId: "deepseek/deepseek-v4-pro-0813" }));
  assert.ok(isDeepSeekModel({ provider: "opencode-go", modelId: "deepseek-v4-flash" }));
  assert.ok(isDeepSeekModel({ provider: "hetzner", modelId: "DeepSeek-V4-Flash-0731" }), "case-insensitive");
  assert.ok(isDeepSeekModel({ provider: "openrouter", modelId: "~deepseek/deepseek-v4-flash-latest" }));
});

test("does not fire for other models", () => {
  assert.ok(!isDeepSeekModel({ provider: "openrouter", modelId: "google/gemini-3.7-flash" }));
  assert.ok(!isDeepSeekModel({ provider: "openrouter", modelId: "x-ai/grok-4.6" }));
  assert.ok(!isDeepSeekModel(null));
  assert.ok(!isDeepSeekModel({}));
  assert.ok(!isDeepSeekModel({ provider: "openrouter", modelId: "" }));
});

test("peak windows follow the announcement, half-open at the top", () => {
  // 01:00-04:00 and 06:00-10:00 UTC.
  assert.equal(isPeakAt(utc(0, 59)), false);
  assert.equal(isPeakAt(utc(1, 0)), true, "start is inclusive");
  assert.equal(isPeakAt(utc(3, 59)), true);
  assert.equal(isPeakAt(utc(4, 0)), false, "end is exclusive");
  assert.equal(isPeakAt(utc(5, 30)), false, "the gap between windows is off-peak");
  assert.equal(isPeakAt(utc(6, 0)), true);
  assert.equal(isPeakAt(utc(9, 59)), true);
  assert.equal(isPeakAt(utc(10, 0)), false);
  assert.equal(isPeakAt(utc(23, 0)), false);
});

test("next boundary is the next flip, not the next window start", () => {
  assert.equal(nextBoundaryAt(utc(2, 30)).getUTCHours(), 4, "mid-peak -> window end");
  assert.equal(nextBoundaryAt(utc(4, 30)).getUTCHours(), 6, "between windows -> next start");
  assert.equal(nextBoundaryAt(utc(9, 0)).getUTCHours(), 10);
});

test("a boundary late in the day rolls into tomorrow", () => {
  const boundary = nextBoundaryAt(utc(23, 30));
  assert.equal(boundary.getUTCHours(), 1);
  assert.equal(boundary.getUTCDate(), 21, "next day");
});

test("nothing is in effect before the announced start", () => {
  const before = new Date(PRICING_EFFECTIVE_AT_MS - 60_000);
  const after = new Date(PRICING_EFFECTIVE_AT_MS + 60_000);
  assert.equal(pricingStateAt(before).inEffect, false);
  assert.equal(pricingStateAt(after).inEffect, true);
});

test("the once-a-day gate keys on the local calendar day", () => {
  const now = new Date(2026, 7, 20, 9, 0, 0);
  assert.equal(shouldRemind(null, now), true, "never shown");
  assert.equal(shouldRemind(localDayKey(now), now), false, "already shown today");
  assert.equal(shouldRemind("2026-08-19", now), true, "shown yesterday");
});

test("the gate does not reset when the clock crosses UTC midnight mid-day", () => {
  // A local day must map to one key regardless of the UTC date underneath it.
  const morning = new Date(2026, 7, 20, 1, 0, 0);
  const evening = new Date(2026, 7, 20, 23, 0, 0);
  assert.equal(localDayKey(morning), localDayKey(evening));
});

test("peak windows are rendered in local time", () => {
  const rendered = peakWindowsLocal(utc(12));
  // Two spans, whatever the runner's timezone.
  assert.equal(rendered.split(", ").length, 2);
  assert.match(rendered, /^\d\d:\d\d–\d\d:\d\d, \d\d:\d\d–\d\d:\d\d$/);
});

test("pricingState reports when the current state ends", () => {
  const state = pricingStateAt(utc(2, 30));
  assert.match(state.changesAtLocal, /^\d\d:\d\d$/);
  assert.equal(state.isPeak, true);
});
