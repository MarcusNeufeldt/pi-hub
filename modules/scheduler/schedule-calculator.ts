/**
 * Timezone-aware schedule calculation for the Pi Hub scheduler.
 *
 * Pure functions — no I/O, no database. This keeps scheduling logic in one
 * place (design doc §11.2) so the API, scanner, and tests all agree.
 *
 * Strategy for converting "local wall-clock time in an IANA zone" to UTC:
 * we synthesize a fixed-format local timestamp string, then use
 * `Intl.DateTimeFormat` to validate the zone and `Date` parsing on a
 * constructed ISO string that *claims* UTC to recover the epoch, then offset
 * by the zone's actual offset for that instant. This avoids pulling in a
 * cron/tz library and correctly handles DST gaps and folds.
 */

import { SchedulerError, SchedulerErrorCode } from "./errors";
import type {
  DailyScheduleInput,
  HourlyScheduleInput,
  OnceScheduleInput,
  PersistedSchedule,
  ScheduleInput,
} from "./types";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const TIME_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;
const LOCAL_DATETIME_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/;

/** Returns the IANA offset (minutes east of UTC) for `epochMs` in `zone`. */
export function offsetMinutesForZone(epochMs: number, zone: string): number {
  // Format the instant in the target zone and read back the offset field.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = fmt.formatToParts(new Date(epochMs));
  const get = (type: string) =>
    parts.find((p) => p.type === type)?.value ?? "";
  // Construct what the UTC epoch WOULD be if these local parts were UTC.
  const asUtc = Date.UTC(
    Number(get("year")),
    Number(get("month")) - 1,
    Number(get("day")),
    Number(get("hour")) === 24 ? 0 : Number(get("hour")),
    Number(get("minute")),
    Number(get("second")),
  );
  return Math.round((asUtc - epochMs) / 60000);
}

/** Throws if `zone` is not a valid IANA timezone identifier. */
export function assertValidTimezone(zone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
  } catch {
    throw new SchedulerError(
      SchedulerErrorCode.INVALID_TIMEZONE,
      `Invalid timezone: ${zone}`,
    );
  }
}

function assertValidDaily(input: DailyScheduleInput): void {
  assertValidTimezone(input.timezone);
  if (!TIME_REGEX.test(input.time)) {
    throw new SchedulerError(
      SchedulerErrorCode.INVALID_SCHEDULE,
      `Invalid daily time: ${input.time} (expected HH:MM)`,
    );
  }
}

function assertValidOnce(input: OnceScheduleInput): void {
  assertValidTimezone(input.timezone);
  if (!LOCAL_DATETIME_REGEX.test(input.localDateTime)) {
    throw new SchedulerError(
      SchedulerErrorCode.INVALID_SCHEDULE,
      `Invalid once datetime: ${input.localDateTime} (expected YYYY-MM-DDTHH:MM[:SS])`,
    );
  }
}

function assertValidHourly(input: HourlyScheduleInput): void {
  assertValidTimezone(input.timezone);
  if (!Number.isInteger(input.intervalHours) || input.intervalHours < 1 || input.intervalHours > 24) {
    throw new SchedulerError(
      SchedulerErrorCode.INVALID_SCHEDULE,
      `Invalid hourly interval: ${input.intervalHours} (expected 1-24)`,
    );
  }
  if (!Number.isInteger(input.minute) || input.minute < 0 || input.minute > 59) {
    throw new SchedulerError(
      SchedulerErrorCode.INVALID_SCHEDULE,
      `Invalid hourly minute: ${input.minute} (expected 0-59)`,
    );
  }
}

// ---------------------------------------------------------------------------
// Local-time → epoch conversion
// ---------------------------------------------------------------------------

/**
 * Converts local wall-clock Y/M/D/H/M/S in `zone` to a UTC epoch ms.
 *
 * Handles DST fold (ambiguous time — returns the earlier/first occurrence,
 * matching "run as soon as the clock reaches this time") and DST gap
 * (non-existent time — falls forward to the first real instant after it).
 */
function localToEpoch(
  year: number,
  month: number, // 1-12
  day: number,
  hour: number,
  minute: number,
  second: number,
  zone: string,
): number {
  // First guess: pretend the local fields are UTC. Compute the offset of that
  // instant in the zone, then subtract it to get the true epoch.
  const guessUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const offset = offsetMinutesForZone(guessUtc, zone);
  let epoch = guessUtc - offset * 60000;

  // DST gap fix: if the offset at the corrected instant differs from the
  // offset we applied, the local time didn't exist. Fall forward by
  // re-deriving from the corrected instant.
  const offset2 = offsetMinutesForZone(epoch, zone);
  if (offset2 !== offset) {
    epoch = guessUtc - offset2 * 60000;
  }
  return epoch;
}

/**
 * Cron-style expression for a daily task: "M H * * *" with unpadded numeric
 * fields (e.g. "0 8 * * *" for 08:00), matching design doc §11.2. The parser
 * in calculateNextRun accepts both padded and unpadded forms.
 */
export function cronFromDaily(time: string): string {
  const m = TIME_REGEX.exec(time);
  if (!m) {
    throw new SchedulerError(
      SchedulerErrorCode.INVALID_SCHEDULE,
      `Invalid daily time: ${time}`,
    );
  }
  return `${Number(m[2])} ${Number(m[1])} * * *`;
}

// Cron-style expression for an hourly task: "M * /N * * *" (e.g. "15 * /2 * * *"
// for every 2 hours at :15). Hourly runs always use the task timezone.
export function cronFromHourly(intervalHours: number, minute: number): string {
  return `${minute} */${intervalHours} * * *`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ResolvedSchedule {
  scheduleType: "recurring" | "once";
  cronExpression: string | null;
  executeAt: number | null;
  timezone: string;
  /** First next-run time (UTC epoch ms). */
  nextRunAt: number;
}

/** Validates input and computes the persisted schedule + first next run. */
export function resolveSchedule(input: ScheduleInput): ResolvedSchedule {
  if (input.type === "daily") {
    assertValidDaily(input);
    const cron = cronFromDaily(input.time);
    const next = nextDailyRun(input.time, input.timezone, Date.now());
    return {
      scheduleType: "recurring",
      cronExpression: cron,
      executeAt: null,
      timezone: input.timezone,
      nextRunAt: next,
    };
  }
  if (input.type === "hourly") {
    assertValidHourly(input);
    const cron = cronFromHourly(input.intervalHours, input.minute);
    const next = nextHourlyRun(input.intervalHours, input.minute, input.timezone, Date.now());
    return {
      scheduleType: "recurring",
      cronExpression: cron,
      executeAt: null,
      timezone: input.timezone,
      nextRunAt: next,
    };
  }
  assertValidOnce(input);
  const [datePart, timePart] = input.localDateTime.split("T");
  const [y, mo, d] = datePart.split("-").map(Number);
  const [h, mi, se = 0] = timePart.split(":").map(Number);
  const executeAt = localToEpoch(y, mo, d, h, mi, se, input.timezone);
  return {
    scheduleType: "once",
    cronExpression: null,
    executeAt,
    timezone: input.timezone,
    nextRunAt: executeAt,
  };
}

/**
 * Computes the next UTC epoch ms a daily "HH:MM in zone" should fire, at or
 * strictly after `fromMs`. Iterates day-by-day from today (zone-local) up to
 * a week ahead — enough to cross DST boundaries without an unbounded loop.
 */
export function nextDailyRun(
  time: string,
  zone: string,
  fromMs: number,
): number {
  const m = TIME_REGEX.exec(time);
  if (!m) {
    throw new SchedulerError(
      SchedulerErrorCode.INVALID_SCHEDULE,
      `Invalid daily time: ${time}`,
    );
  }
  const hour = Number(m[1]);
  const minute = Number(m[2]);

  // Find the zone-local Y/M/D of `fromMs`.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(new Date(fromMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  let year = get("year");
  let month = get("month");
  let day = get("day");

  for (let i = 0; i < 8; i++) {
    const candidate = localToEpoch(year, month, day, hour, minute, 0, zone);
    if (candidate > fromMs) return candidate;
    // Advance one zone-local day. Use UTC math on a noon anchor to avoid any
    // DST edge when adding ~24h, then re-derive local fields.
    const anchor = localToEpoch(year, month, day, 12, 0, 0, zone) + 86400000;
    const np = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(anchor));
    year = Number(np.find((p) => p.type === "year")?.value);
    month = Number(np.find((p) => p.type === "month")?.value);
    day = Number(np.find((p) => p.type === "day")?.value);
  }
  // Should be unreachable for valid inputs.
  throw new SchedulerError(
    SchedulerErrorCode.INVALID_SCHEDULE,
    `Could not resolve next daily run for ${time} in ${zone}`,
  );
}

/**
 * Computes the next UTC epoch ms an hourly "every N hours at :MM in zone"
 * schedule should fire, at or strictly after `fromMs`. Iterates hourly
 * from `fromMs` (a 72h window — enough to cross any DST transition and, for
 * any interval 1-24, at least one full local day). Runs align to local hours
 * divisible by the interval (e.g. every 6h → 00:xx, 06:xx, 12:xx, 18:xx).
 */
export function nextHourlyRun(
  intervalHours: number,
  minute: number,
  zone: string,
  fromMs: number,
): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
  });
  for (let i = 0; i < 72; i++) {
    const anchor = fromMs + i * 3600000;
    const parts = fmt.formatToParts(new Date(anchor));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    let hour = get("hour");
    if (hour === 24) hour = 0;
    if (hour % intervalHours !== 0) continue;
    const candidate = localToEpoch(
      get("year"),
      get("month"),
      get("day"),
      hour,
      minute,
      0,
      zone,
    );
    if (candidate > fromMs) return candidate;
  }
  throw new SchedulerError(
    SchedulerErrorCode.INVALID_SCHEDULE,
    `Could not resolve next hourly run (every ${intervalHours}h at :${minute}) in ${zone}`,
  );
}

/**
 * Computes the next run for an already-persisted task, at or strictly after
 * `afterMs`. For once-tasks returns `executeAt` (which may be in the past).
 */
export function calculateNextRun(
  schedule: PersistedSchedule,
  afterMs: number,
): number {
  if (schedule.scheduleType === "once") {
    return schedule.executeAt ?? afterMs;
  }
  // recurring: parse "M H * * *" (daily) or "M */N * * *" (hourly).
  const parts = (schedule.cronExpression ?? "").split(/\s+/);
  const minuteRaw = Number(parts[0]);
  if (
    parts.length !== 5 ||
    parts.slice(2).some((p) => p !== "*") ||
    !Number.isInteger(minuteRaw) ||
    minuteRaw < 0 ||
    minuteRaw > 59
  ) {
    throw new SchedulerError(
      SchedulerErrorCode.INVALID_CRON,
      `Unsupported cron expression: ${schedule.cronExpression}`,
    );
  }
  const hourField = parts[1] ?? "";
  const hourly = /^\*\/(\d{1,2})$/.exec(hourField);
  if (hourly) {
    const interval = Number(hourly[1]);
    if (!Number.isInteger(interval) || interval < 1 || interval > 24) {
      throw new SchedulerError(
        SchedulerErrorCode.INVALID_CRON,
        `Unsupported cron expression: ${schedule.cronExpression}`,
      );
    }
    return nextHourlyRun(interval, minuteRaw, schedule.timezone, afterMs);
  }
  const hourRaw = Number(hourField);
  if (!Number.isInteger(hourRaw) || hourRaw < 0 || hourRaw > 23) {
    throw new SchedulerError(
      SchedulerErrorCode.INVALID_CRON,
      `Unsupported cron expression: ${schedule.cronExpression}`,
    );
  }
  // Re-pad to the HH:MM shape nextDailyRun expects (handles both "0 8" and "00 08").
  const time = `${hourRaw.toString().padStart(2, "0")}:${minuteRaw
    .toString()
    .padStart(2, "0")}`;
  return nextDailyRun(time, schedule.timezone, afterMs);
}

/** True if a due task is within its misfire grace window. */
export function withinMisfireGrace(
  dueAt: number,
  now: number,
  graceSeconds: number,
): boolean {
  return now - dueAt <= graceSeconds * 1000;
}

/**
 * Preview helper for the UI: returns the next-run instant for a schedule
 * input plus its human-readable local + UTC forms. Pure / synchronous.
 */
export function previewNextRun(input: ScheduleInput): {
  nextRunAt: number;
  localDisplay: string;
  utcDisplay: string;
} {
  const resolved = resolveSchedule(input);
  const localDisplay = formatZoned(resolved.nextRunAt, input.timezone);
  const utcDisplay = formatUtc(resolved.nextRunAt);
  return { nextRunAt: resolved.nextRunAt, localDisplay, utcDisplay };
}

const PAD = (n: number) => n.toString().padStart(2, "0");

function formatUtc(epochMs: number): string {
  const d = new Date(epochMs);
  return `${d.getUTCFullYear()}-${PAD(d.getUTCMonth() + 1)}-${PAD(
    d.getUTCDate(),
  )} ${PAD(d.getUTCHours())}:${PAD(d.getUTCMinutes())} UTC`;
}

function formatZoned(epochMs: number, zone: string): string {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = fmt.formatToParts(new Date(epochMs));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour") === "24" ? "00" : get("hour")}:${get("minute")} ${zone}`;
}
