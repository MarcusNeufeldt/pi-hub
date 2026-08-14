/**
 * DeepSeek's time-of-day API pricing.
 *
 * From 2026-08-16 16:00 UTC, DeepSeek bills V4 models at two rates: peak hours
 * cost exactly double off-peak on every component (cache hit, cache miss,
 * output). pi's cost model cannot express this — `ModelCost.tiers` keys off
 * `inputTokensAbove`, a token count, not a clock — so the catalog carries one
 * number and the displayed cost is necessarily wrong for part of the day. A
 * reminder is the honest substitute for pricing we cannot model.
 *
 * Deliberately provider-agnostic on detection, and deliberately hedged in
 * wording: the same weights are reachable through DeepSeek's API, resellers, and
 * self-hosted endpoints, and only the first is billed on this clock. Claiming
 * "prices doubled" to someone running their own GPUs would be false.
 */

/** Peak windows as [startHourUTC, endHourUTC), per DeepSeek's announcement. */
export const PEAK_WINDOWS_UTC: readonly (readonly [number, number])[] = [
  [1, 4],
  [6, 10],
];

/** 2026-08-16T16:00:00Z, when the two-tier pricing starts. */
export const PRICING_EFFECTIVE_AT_MS = Date.UTC(2026, 7, 16, 16, 0, 0);

/** Peak costs exactly twice off-peak on every rate component. */
export const PEAK_MULTIPLIER = 2;

/**
 * True for any DeepSeek model, whatever provider serves it.
 *
 * Matches on the model id rather than the provider because the id is where the
 * family shows up consistently: `deepseek/deepseek-v4-pro-0813` on OpenRouter,
 * `deepseek-v4-flash` on a gateway, `DeepSeek-V4-Flash-0731` self-hosted.
 */
export function isDeepSeekModel(
  model: { provider?: string; modelId?: string } | null | undefined,
): boolean {
  const id = model?.modelId;
  if (typeof id !== "string" || !id) return false;
  return id.toLowerCase().includes("deepseek");
}

function hourFractionUTC(at: Date): number {
  return at.getUTCHours() + at.getUTCMinutes() / 60 + at.getUTCSeconds() / 3600;
}

export function isPeakAt(at: Date): boolean {
  const hour = hourFractionUTC(at);
  return PEAK_WINDOWS_UTC.some(([start, end]) => hour >= start && hour < end);
}

/**
 * When the peak/off-peak state next flips. Windows start and end on the hour, so
 * scanning hour boundaries is exact; 48 hours is more than one full cycle.
 */
export function nextBoundaryAt(at: Date): Date {
  const current = isPeakAt(at);
  const probe = new Date(at);
  probe.setUTCMinutes(0, 0, 0);
  for (let step = 1; step <= 48; step += 1) {
    probe.setUTCHours(probe.getUTCHours() + 1);
    if (isPeakAt(probe) !== current) return new Date(probe);
  }
  // Unreachable while any window is a proper subset of the day.
  return new Date(at.getTime() + 86_400_000);
}

/** Local calendar day, used as the once-a-day key. */
export function localDayKey(at: Date): string {
  const year = at.getFullYear();
  const month = String(at.getMonth() + 1).padStart(2, "0");
  const day = String(at.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function shouldRemind(lastShownDayKey: string | null, at: Date): boolean {
  return localDayKey(at) !== lastShownDayKey;
}

/**
 * The viewer's IANA zone, e.g. "Europe/Berlin". Named in the reminder because
 * DeepSeek published the windows in UTC, so a bare "08:00–12:00" invites being
 * read as UTC by exactly the person who most needs it converted.
 */
export function resolvedTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/*
 * Formatting goes through Intl with an explicit timeZone rather than Date's
 * local getters. Both convert correctly, but only this form can be tested for a
 * zone other than the host's: Node on Windows ignores the TZ environment
 * variable for anything but UTC, so a getHours()-based implementation is
 * effectively untestable here — which is how a format-only assertion ended up
 * passing without proving any conversion happened.
 */
function formatHourMinute(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).format(at);
}

export interface PricingState {
  /** False before the announced start, when nothing has changed yet. */
  inEffect: boolean;
  isPeak: boolean;
  /** HH:MM in `timeZone` at which the current state ends. */
  changesAtLocal: string;
  /** The zone the times above are expressed in. */
  timeZone: string;
}

export function pricingStateAt(at: Date, timeZone = resolvedTimeZone()): PricingState {
  return {
    inEffect: at.getTime() >= PRICING_EFFECTIVE_AT_MS,
    isPeak: isPeakAt(at),
    changesAtLocal: formatHourMinute(nextBoundaryAt(at), timeZone),
    timeZone,
  };
}

/**
 * Peak windows in the viewer's zone, e.g. "03:00–06:00, 08:00–12:00" for Berlin.
 *
 * `at` supplies the date, which matters: the same UTC window lands on different
 * local hours either side of a DST transition.
 */
export function peakWindowsLocal(at: Date, timeZone = resolvedTimeZone()): string {
  const onTheHour = new Date(at);
  onTheHour.setUTCMinutes(0, 0, 0);
  return PEAK_WINDOWS_UTC.map(([start, end]) => {
    const from = new Date(onTheHour);
    from.setUTCHours(start);
    const to = new Date(onTheHour);
    to.setUTCHours(end);
    return `${formatHourMinute(from, timeZone)}–${formatHourMinute(to, timeZone)}`;
  }).join(", ");
}
