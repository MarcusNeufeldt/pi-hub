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

export interface PricingState {
  /** False before the announced start, when nothing has changed yet. */
  inEffect: boolean;
  isPeak: boolean;
  /** Local HH:MM at which the current state ends. */
  changesAtLocal: string;
}

export function pricingStateAt(at: Date): PricingState {
  const boundary = nextBoundaryAt(at);
  return {
    inEffect: at.getTime() >= PRICING_EFFECTIVE_AT_MS,
    isPeak: isPeakAt(at),
    changesAtLocal: `${String(boundary.getHours()).padStart(2, "0")}:${String(boundary.getMinutes()).padStart(2, "0")}`,
  };
}

/** Peak windows rendered in the viewer's own timezone, e.g. "03:00–06:00, 08:00–12:00". */
export function peakWindowsLocal(at: Date): string {
  const reference = new Date(at);
  reference.setUTCMinutes(0, 0, 0);
  const spans = PEAK_WINDOWS_UTC.map(([start, end]) => {
    const from = new Date(reference);
    from.setUTCHours(start);
    const to = new Date(reference);
    to.setUTCHours(end);
    const fmt = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    return `${fmt(from)}–${fmt(to)}`;
  });
  return spans.join(", ");
}
