/**
 * Heuristic rate-limit / quota error detection.
 *
 * Provider rate-limit messages vary widely across vendors, so this is a
 * best-effort regex match. It is used ONLY to decide whether a failed run
 * should be auto-rescheduled (design doc resume §11) — never as the sole
 * signal for side-effecting logic. It is deliberately permissive toward false
 * negatives (unrecognised → the run just fails normally) and bounded by
 * `maxAttempts` for any false positives.
 */

const RATE_LIMIT_PATTERNS = [
  /rate[\s_-]?limit/i,
  /quota/i,
  /\b5h\b/, // 5-hour rolling window (common provider limit)
  /too many requests/i,
  /\b429\b/,
  /overload/i,
  /capacity/i,
];

/** True when `message` looks like a provider rate-limit / quota error. */
export function isRateLimitError(
  message: string | null | undefined,
): boolean {
  if (!message) return false;
  return RATE_LIMIT_PATTERNS.some((p) => p.test(message));
}
