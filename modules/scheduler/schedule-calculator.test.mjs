import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  resolveSchedule,
  calculateNextRun,
  nextDailyRun,
  nextHourlyRun,
  previewNextRun,
  withinMisfireGrace,
  cronFromDaily,
  assertValidTimezone,
  SchedulerError,
} = await jiti.import("./schedule-calculator.ts");

// Daily: "08:00 Asia/Singapore" → next run strictly after the reference instant.

test("daily: next run is the following day when reference is exactly the target time", () => {
  // 2026-08-07T00:00Z == 08:00 SGT. Since nextDailyRun is strictly-after,
  // the answer is the next day's 08:00 SGT (2026-08-08T00:00Z).
  const next = nextDailyRun("08:00", "Asia/Singapore", Date.UTC(2026, 7, 7, 0, 0, 0));
  assert.equal(new Date(next).toISOString(), "2026-08-08T00:00:00.000Z");
});

test("daily: next run is today when reference is before the target time", () => {
  // 2026-08-07T00:00Z is 08:00 SGT; 02:00 UTC is 10:00 SGT, before 08:00? No —
  // 08:00 SGT == 00:00 UTC, so 02:00 UTC is 10:00 SGT, AFTER 08:00 SGT → next day.
  // Use 2026-08-06T18:00Z = 2026-08-07 02:00 SGT, before 08:00 → same day 08:00 SGT.
  const next = nextDailyRun("08:00", "Asia/Singapore", Date.UTC(2026, 7, 6, 18, 0, 0));
  assert.equal(new Date(next).toISOString(), "2026-08-07T00:00:00.000Z");
});

test("daily: crosses month boundary", () => {
  // 2026-08-31T16:00Z = 2026-09-01 00:00 SGT. Next 08:00 SGT = 2026-08-31T... no:
  // 00:00 local on Sep 1 → next 08:00 is Sep 1 08:00 SGT = 2026-09-01T00:00Z.
  const next = nextDailyRun("08:00", "Asia/Singapore", Date.UTC(2026, 7, 31, 16, 0, 0));
  assert.equal(new Date(next).toISOString(), "2026-09-01T00:00:00.000Z");
});

test("daily: crosses year boundary", () => {
  // 2026-12-31T16:00Z = 2027-01-01 00:00 SGT → next 08:00 SGT = 2027-01-01T00:00Z.
  const next = nextDailyRun("08:00", "Asia/Singapore", Date.UTC(2026, 11, 31, 16, 0, 0));
  assert.equal(new Date(next).toISOString(), "2027-01-01T00:00:00.000Z");
});

test("daily: different timezone (UTC) — 09:30 UTC", () => {
  const next = nextDailyRun("09:30", "UTC", Date.UTC(2026, 7, 7, 9, 30, 0));
  assert.equal(new Date(next).toISOString(), "2026-08-08T09:30:00.000Z");
});

test("daily: DST start (spring forward) — America/New_York 02:30 does not exist", () => {
  // US 2026 DST starts 2026-03-08 02:00 EST → clocks jump to 03:00 EDT.
  // 02:30 local does not exist. We just need a deterministic, valid future instant
  // (no infinite loop, no throw). Assert it lands on 2026-03-08 or 2026-03-09.
  const ref = Date.UTC(2026, 2, 7, 12, 0, 0); // 2026-03-07 noon UTC
  const next = nextDailyRun("02:30", "America/New_York", ref);
  const d = new Date(next);
  assert.ok(d.getUTCMonth() === 2 && (d.getUTCDate() === 8 || d.getUTCDate() === 9));
});

test("once: converts local datetime + timezone to UTC epoch", () => {
  const r = resolveSchedule({
    type: "once",
    localDateTime: "2026-08-08T10:00:00",
    timezone: "Asia/Singapore",
  });
  assert.equal(r.scheduleType, "once");
  assert.equal(new Date(r.nextRunAt).toISOString(), "2026-08-08T02:00:00.000Z");
});

test("once: returns executeAt equal to nextRunAt", () => {
  const r = resolveSchedule({
    type: "once",
    localDateTime: "2026-08-08T10:00:00",
    timezone: "UTC",
  });
  assert.equal(r.executeAt, r.nextRunAt);
  assert.equal(new Date(r.nextRunAt).toISOString(), "2026-08-08T10:00:00.000Z");
});

test("calculateNextRun: recurring advances by one day", () => {
  const schedule = {
    scheduleType: "recurring",
    cronExpression: "0 8 * * *",
    executeAt: null,
    timezone: "Asia/Singapore",
  };
  const next = calculateNextRun(schedule, Date.UTC(2026, 7, 7, 0, 0, 0));
  assert.equal(new Date(next).toISOString(), "2026-08-08T00:00:00.000Z");
});

test("calculateNextRun: once returns executeAt", () => {
  const executeAt = Date.UTC(2026, 7, 8, 2, 0, 0);
  const schedule = { scheduleType: "once", cronExpression: null, executeAt, timezone: "UTC" };
  assert.equal(calculateNextRun(schedule, Date.now()), executeAt);
});

test("cronFromDaily: converts HH:MM to cron M H * * *", () => {
  assert.equal(cronFromDaily("08:00"), "0 8 * * *");
  assert.equal(cronFromDaily("23:45"), "45 23 * * *");
});

test("previewNextRun: returns local + UTC display strings", () => {
  const p = previewNextRun({ type: "daily", time: "08:00", timezone: "Asia/Singapore" });
  assert.ok(p.nextRunAt > Date.now() - 86400000);
  assert.match(p.localDisplay, /Asia\/Singapore/);
  assert.match(p.utcDisplay, /UTC/);
});

test("withinMisfireGrace: boundary", () => {
  const due = 1000000;
  assert.equal(withinMisfireGrace(due, due + 60000, 120), true); // 1 min late, 2 min grace → within
  assert.equal(withinMisfireGrace(due, due + 60000, 30), false); // 1 min late, 30s grace → outside
  assert.equal(withinMisfireGrace(due, due, 0), true); // exactly on time: now-due=0 <= 0 → within
  assert.equal(withinMisfireGrace(due, due + 1, 0), false); // 1ms late, 0 grace → outside
});

test("assertValidTimezone: rejects invalid zone", () => {
  assert.throws(() => assertValidTimezone("Not/A/Zone"), SchedulerError);
});

test("resolveSchedule: rejects invalid daily time", () => {
  assert.throws(
    () => resolveSchedule({ type: "daily", time: "25:00", timezone: "UTC" }),
    SchedulerError,
  );
});

// ---------------------------------------------------------------------------
// Hourly: "every N hours at :MM" in a zone
// ---------------------------------------------------------------------------

test("hourly: interval 1 runs at the next full hour", () => {
  // 2026-08-08T10:15Z == 12:15 Berlin (UTC+2). Next :00 hour → 13:00 local == 11:00Z.
  const next = nextHourlyRun(1, 0, "Europe/Berlin", Date.UTC(2026, 7, 8, 10, 15, 0));
  assert.equal(new Date(next).toISOString(), "2026-08-08T11:00:00.000Z");
});

test("hourly: interval 6 with :30 aligns to local hour multiples of 6", () => {
  // 2026-08-08T10:45Z == 12:45 Berlin. Next hour % 6 == 0 is 18:00 local → 16:00Z.
  const next = nextHourlyRun(6, 30, "Europe/Berlin", Date.UTC(2026, 7, 8, 10, 45, 0));
  assert.equal(new Date(next).toISOString(), "2026-08-08T16:30:00.000Z");
});

test("hourly: interval 24 with :00 lands on local midnight", () => {
  // 2026-08-08T11:00Z == 13:00 Berlin → next local 00:00 == 22:00Z the same day.
  const next = nextHourlyRun(24, 0, "Europe/Berlin", Date.UTC(2026, 7, 8, 11, 0, 0));
  assert.equal(new Date(next).toISOString(), "2026-08-08T22:00:00.000Z");
});

test("hourly: DST fall-back day still lands on local midnight", () => {
  // 2026-10-25 Berlin falls back (CEST+2 → CET+1). 12:00Z == 13:00 CET.
  // Next local midnight (Oct 26 00:00 CET) == 2026-10-25T23:00:00Z. A naive
  // UTC+1-offset guess would compute 22:00Z, so 23:00Z proves DST handling.
  const next = nextHourlyRun(24, 0, "Europe/Berlin", Date.UTC(2026, 9, 25, 12, 0, 0));
  assert.equal(new Date(next).toISOString(), "2026-10-25T23:00:00.000Z");
});

test("hourly: resolveSchedule persists */N cron and a future next run", () => {
  const resolved = resolveSchedule({
    type: "hourly",
    intervalHours: 2,
    minute: 15,
    timezone: "Europe/Berlin",
  });
  assert.equal(resolved.scheduleType, "recurring");
  assert.equal(resolved.cronExpression, "15 */2 * * *");
  assert.ok(resolved.nextRunAt > Date.now());
});

test("hourly: calculateNextRun round-trips the */N cron", () => {
  // 2026-08-08T11:00Z == 13:00 Berlin; every 3h at :30 → 15:30 local == 13:30Z.
  const next = calculateNextRun(
    {
      scheduleType: "recurring",
      cronExpression: "30 */3 * * *",
      executeAt: null,
      timezone: "Europe/Berlin",
    },
    Date.UTC(2026, 7, 8, 11, 0, 0),
  );
  assert.equal(new Date(next).toISOString(), "2026-08-08T13:30:00.000Z");
});

test("hourly: rejects invalid interval and minute", () => {
  assert.throws(
    () => resolveSchedule({ type: "hourly", intervalHours: 0, minute: 0, timezone: "UTC" }),
    SchedulerError,
  );
  assert.throws(
    () => resolveSchedule({ type: "hourly", intervalHours: 25, minute: 0, timezone: "UTC" }),
    SchedulerError,
  );
  assert.throws(
    () => resolveSchedule({ type: "hourly", intervalHours: 1, minute: 60, timezone: "UTC" }),
    SchedulerError,
  );
});
