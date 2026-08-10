/**
 * Codex plan-quota types, parsing and display helpers.
 *
 * Deliberately free of Node imports: `AppShell` is a client component and needs
 * the formatters, so anything touching `node:fs` lives in `codex-usage-server.ts`
 * instead. Keep this module pure.
 *
 * The upstream payload is parsed by `parseCodexUsage`, which whitelists by
 * construction — it builds its result field by field, so the `email`, `user_id`,
 * `account_id`, `credits.balance` and `spend_control` values that also travel in
 * that payload cannot reach the API route, the browser, or a log.
 */

/** One rate-limit window: a usage reading over a fixed period. */
export interface CodexUsageWindow {
  /** 0..100. */
  usedPercent: number;
  /** Period length in seconds, when upstream states one. */
  windowSeconds: number | null;
  /** Epoch seconds at which this window rolls over. */
  resetAt: number | null;
}

/** A named quota bucket that is not the account-level plan quota. */
export interface CodexUsageBucket {
  /** Stable list key — the metered feature id when upstream sends one. */
  key: string;
  /** Human-facing name, e.g. "GPT-5.3-Codex-Spark". */
  label: string | null;
  windows: CodexUsageWindow[];
}

export interface CodexUsage {
  /** Plan slug, e.g. "pro". */
  plan: string | null;
  /** Account-level windows — what gates ordinary Codex use. */
  windows: CodexUsageWindow[];
  /** Per-model / per-feature buckets from `additional_rate_limits`. */
  extras: CodexUsageBucket[];
  /** Rate-limit reset credits available, when upstream reports a count. */
  resetCredits: number | null;
  /** Epoch ms this reading was fetched, so the UI can show its age. */
  fetchedAt: number;
}

export type CodexUnavailableReason =
  /** No `auth.json`, or it holds no usable ChatGPT token. */
  | "no-credentials"
  /** Token rejected — the user needs to sign in again via Codex. */
  | "unauthorized"
  /** Network failure, timeout, or a non-OK upstream status. */
  | "unreachable"
  /** Reachable but the payload held no reading we recognise. */
  | "unrecognized";

export type CodexUsageResult =
  | { available: true; usage: CodexUsage }
  | { available: false; reason: CodexUnavailableReason };

function toPercent(value: unknown): number | null {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() !== ""
      ? Number(value)
      : Number.NaN;
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return Math.min(100, numeric);
}

function toPositiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value);
}

export function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function parseWindow(raw: unknown): CodexUsageWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  // A window with no percentage carries no reading — upstream sends explicit
  // nulls for windows that do not apply to the plan, and an all-null payload
  // must never render as 0%.
  const usedPercent = toPercent(source.used_percent);
  if (usedPercent === null) return null;
  return {
    usedPercent,
    windowSeconds: toPositiveInt(source.limit_window_seconds),
    resetAt: toPositiveInt(source.reset_at),
  };
}

/**
 * Windows are read by the slot upstream puts them in, never assumed. The same
 * account has been observed reporting a 5h primary + weekly secondary pair and,
 * later, a weekly primary with no secondary at all — so anything that hardcodes
 * "primary means 5h" eventually mislabels a window.
 */
function parseWindows(rateLimit: unknown): CodexUsageWindow[] {
  if (!rateLimit || typeof rateLimit !== "object") return [];
  const source = rateLimit as Record<string, unknown>;
  const windows: CodexUsageWindow[] = [];
  for (const slot of ["primary_window", "secondary_window", "tertiary_window"]) {
    const parsed = parseWindow(source[slot]);
    if (parsed) windows.push(parsed);
  }
  return windows;
}

/**
 * Whitelisting parser: the returned object is built field by field, so an
 * upstream payload growing new keys can never widen what this module exposes.
 * Returns null when there is nothing renderable.
 */
export function parseCodexUsage(payload: unknown, now: number = Date.now()): CodexUsage | null {
  if (!payload || typeof payload !== "object") return null;
  const source = payload as Record<string, unknown>;

  const windows = parseWindows(source.rate_limit);

  const extras: CodexUsageBucket[] = [];
  if (Array.isArray(source.additional_rate_limits)) {
    source.additional_rate_limits.forEach((entry, index) => {
      if (!entry || typeof entry !== "object") return;
      const bucket = entry as Record<string, unknown>;
      const bucketWindows = parseWindows(bucket.rate_limit);
      if (bucketWindows.length === 0) return;
      const label = toNonEmptyString(bucket.limit_name);
      const feature = toNonEmptyString(bucket.metered_feature);
      extras.push({ key: feature ?? label ?? `extra-${index}`, label, windows: bucketWindows });
    });
  }

  if (windows.length === 0 && extras.length === 0) return null;

  const resetCreditsSource = source.rate_limit_reset_credits;
  const resetCreditsRaw = resetCreditsSource && typeof resetCreditsSource === "object"
    ? (resetCreditsSource as Record<string, unknown>).available_count
    : undefined;

  return {
    plan: toNonEmptyString(source.plan_type),
    windows,
    extras,
    resetCredits: typeof resetCreditsRaw === "number" && Number.isFinite(resetCreditsRaw)
      ? resetCreditsRaw
      : null,
    fetchedAt: now,
  };
}

/**
 * The window that will gate the account first: the highest reading, not
 * whichever slot upstream called "primary". With a 5h window at 80% and a weekly
 * at 20%, the 5h one is what the user is about to hit.
 */
export function governingWindow(usage: CodexUsage): CodexUsageWindow | null {
  if (usage.windows.length === 0) return null;
  return usage.windows.reduce((worst, candidate) => (
    candidate.usedPercent > worst.usedPercent ? candidate : worst
  ));
}

/** Compact, locale-neutral period label: "5h", "7d", "30d". */
export function formatWindowLabel(windowSeconds: number | null): string | null {
  if (windowSeconds === null) return null;
  if (windowSeconds % 86_400 === 0) return `${windowSeconds / 86_400}d`;
  if (windowSeconds % 3_600 === 0) return `${windowSeconds / 3_600}h`;
  return `${Math.max(1, Math.round(windowSeconds / 60))}min`;
}

/**
 * Short badge label for the plan. Plan slugs are an open set upstream
 * (`pro`, `team`, `edu_plus`, `self_serve_business_usage_based`, …), so anything
 * that would not fit a top-bar chip falls back to the product name.
 */
export function formatPlanLabel(plan: string | null): string {
  if (plan === null) return "Codex";
  const cleaned = plan.replace(/_/g, " ").trim();
  if (cleaned === "" || cleaned.length > 12) return "Codex";
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}
