import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  badgeReading,
  formatPlanLabel,
  formatWindowLabel,
  governingWindow,
  parseCodexUsage,
} from "./codex-usage.ts";

const NOW = 1_760_000_000_000;

/** Shape of a real `wham/usage` response, including the fields we must drop. */
const LIVE_PAYLOAD = {
  user_id: "user-SENSITIVE",
  account_id: "8613535d-SENSITIVE",
  email: "someone@example.com",
  plan_type: "pro",
  rate_limit: {
    primary_window: { used_percent: 15, limit_window_seconds: 604_800, reset_at: 1_786_567_975 },
    secondary_window: null,
    tertiary_window: null,
  },
  code_review_rate_limit: null,
  additional_rate_limits: [
    {
      limit_name: "GPT-5.3-Codex-Spark",
      metered_feature: "codex_bengalfox",
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: { used_percent: 0, limit_window_seconds: 604_800, reset_at: 1_786_871_472 },
        secondary_window: null,
      },
    },
  ],
  credits: { has_credits: true, unlimited: false, balance: "3738.9150000000" },
  spend_control: { hard_limit_reached: false },
  rate_limit_reset_credits: { available_count: 0, applicable_available_count: 0 },
};

describe("parseCodexUsage", () => {
  it("reads plan, account window and per-model bucket from a live payload", () => {
    const usage = parseCodexUsage(LIVE_PAYLOAD, NOW);
    assert.ok(usage);
    assert.equal(usage.plan, "pro");
    assert.deepEqual(usage.windows, [
      { usedPercent: 15, windowSeconds: 604_800, resetAt: 1_786_567_975 },
    ]);
    assert.equal(usage.extras.length, 1);
    assert.equal(usage.extras[0].key, "codex_bengalfox");
    assert.equal(usage.extras[0].label, "GPT-5.3-Codex-Spark");
    assert.deepEqual(usage.extras[0].windows, [
      { usedPercent: 0, windowSeconds: 604_800, resetAt: 1_786_871_472 },
    ]);
    assert.equal(usage.resetCredits, 0);
    assert.equal(usage.fetchedAt, NOW);
  });

  it("never carries account identity or balance through the parser", () => {
    // The whitelist is the security boundary for the API route: this route is
    // reachable from any device that clears the host gate.
    const serialized = JSON.stringify(parseCodexUsage(LIVE_PAYLOAD, NOW));
    for (const leak of ["user-SENSITIVE", "8613535d", "example.com", "3738.915", "spend_control"]) {
      assert.equal(serialized.includes(leak), false, `leaked ${leak}`);
    }
  });

  it("keeps both windows when the plan reports a 5h and a weekly limit", () => {
    const usage = parseCodexUsage({
      plan_type: "pro",
      rate_limit: {
        primary_window: { used_percent: 82, limit_window_seconds: 18_000, reset_at: 10 },
        secondary_window: { used_percent: 21, limit_window_seconds: 604_800, reset_at: 20 },
      },
    }, NOW);
    assert.ok(usage);
    assert.deepEqual(usage.windows.map((w) => w.windowSeconds), [18_000, 604_800]);
  });

  it("returns null when every window is an explicit null", () => {
    // Observed on the account-level bucket: a payload whose primary, secondary
    // and credits are all null. This must not render as 0% used.
    assert.equal(parseCodexUsage({
      plan_type: "pro",
      rate_limit: { primary_window: null, secondary_window: null, tertiary_window: null },
    }, NOW), null);
  });

  it("returns null for a payload with no rate_limit at all", () => {
    assert.equal(parseCodexUsage({ plan_type: "pro" }, NOW), null);
  });

  it("returns null for non-object payloads", () => {
    for (const bad of [null, undefined, 42, "nope", []]) {
      assert.equal(parseCodexUsage(bad, NOW), null);
    }
  });

  it("keeps a bucket-only payload when the account window is missing", () => {
    const usage = parseCodexUsage({
      additional_rate_limits: [{
        limit_name: "Spark",
        rate_limit: { primary_window: { used_percent: 4, limit_window_seconds: 604_800 } },
      }],
    }, NOW);
    assert.ok(usage);
    assert.deepEqual(usage.windows, []);
    assert.equal(usage.extras.length, 1);
    assert.equal(usage.extras[0].windows[0].resetAt, null);
  });

  it("skips malformed additional_rate_limits entries", () => {
    const usage = parseCodexUsage({
      rate_limit: { primary_window: { used_percent: 5 } },
      additional_rate_limits: [null, 7, { limit_name: "No windows", rate_limit: null }, "x"],
    }, NOW);
    assert.ok(usage);
    assert.deepEqual(usage.extras, []);
  });

  it("normalizes numeric strings and clamps out-of-range percentages", () => {
    const usage = parseCodexUsage({
      rate_limit: {
        primary_window: { used_percent: "42" },
        secondary_window: { used_percent: 140 },
        tertiary_window: { used_percent: -3 },
      },
    }, NOW);
    assert.ok(usage);
    assert.deepEqual(usage.windows.map((w) => w.usedPercent), [42, 100]);
  });

  it("drops non-positive window lengths and reset times", () => {
    const usage = parseCodexUsage({
      rate_limit: { primary_window: { used_percent: 9, limit_window_seconds: 0, reset_at: -1 } },
    }, NOW);
    assert.ok(usage);
    assert.equal(usage.windows[0].windowSeconds, null);
    assert.equal(usage.windows[0].resetAt, null);
  });
});

describe("governingWindow", () => {
  it("picks the highest reading, not the first slot", () => {
    const usage = parseCodexUsage({
      rate_limit: {
        primary_window: { used_percent: 12, limit_window_seconds: 604_800 },
        secondary_window: { used_percent: 88, limit_window_seconds: 18_000 },
      },
    }, NOW);
    assert.equal(governingWindow(usage).usedPercent, 88);
  });

  it("returns null when the account has no window of its own", () => {
    const usage = parseCodexUsage({
      additional_rate_limits: [{ rate_limit: { primary_window: { used_percent: 1 } } }],
    }, NOW);
    assert.equal(governingWindow(usage), null);
  });
});

describe("badgeReading", () => {
  it("labels the account window with the plan", () => {
    const reading = badgeReading(parseCodexUsage(LIVE_PAYLOAD, NOW));
    assert.equal(reading.name, "Pro");
    assert.equal(reading.window.usedPercent, 15);
  });

  it("falls back to the busiest model bucket when the account reports no window", () => {
    // Guards an empty top-bar chip: this shape leaves governingWindow() null
    // while the detail panel still has rows to show.
    const usage = parseCodexUsage({
      plan_type: "pro",
      rate_limit: { primary_window: null, secondary_window: null },
      additional_rate_limits: [
        { limit_name: "Quiet model", rate_limit: { primary_window: { used_percent: 3 } } },
        { limit_name: "Busy model", rate_limit: { primary_window: { used_percent: 61 } } },
      ],
    }, NOW);
    const reading = badgeReading(usage);
    assert.equal(reading.name, "Busy model");
    assert.equal(reading.window.usedPercent, 61);
  });

  it("names a bucket by its metered feature when it has no display name", () => {
    const usage = parseCodexUsage({
      additional_rate_limits: [{
        metered_feature: "codex_bengalfox",
        rate_limit: { primary_window: { used_percent: 8 } },
      }],
    }, NOW);
    assert.equal(badgeReading(usage).name, "codex_bengalfox");
  });
});

describe("formatWindowLabel", () => {
  it("formats the periods upstream actually sends", () => {
    assert.equal(formatWindowLabel(604_800), "7d");
    assert.equal(formatWindowLabel(18_000), "5h");
    assert.equal(formatWindowLabel(2_592_000), "30d");
    assert.equal(formatWindowLabel(900), "15min");
    assert.equal(formatWindowLabel(null), null);
  });
});

describe("formatPlanLabel", () => {
  it("titlecases short slugs and falls back for the rest", () => {
    assert.equal(formatPlanLabel("pro"), "Pro");
    assert.equal(formatPlanLabel("team"), "Team");
    assert.equal(formatPlanLabel(null), "Codex");
    assert.equal(formatPlanLabel(""), "Codex");
    // Upstream carries 21+ plan strings; long ones would blow out the top bar.
    assert.equal(formatPlanLabel("self_serve_business_usage_based"), "Codex");
  });
});
