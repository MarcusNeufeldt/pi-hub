/**
 * OpenRouter provider routing: endpoint parsing, ranking, and the routing value
 * written into models.json.
 *
 * OpenRouter serves most models from several upstream providers with materially
 * different speed, quantization and price. This module turns the endpoint list
 * into a ranking the user can act on, and builds the `openRouterRouting` value
 * that pins the request to the providers they picked.
 *
 * Pure and Node-free so the composer can import it; the authenticated fetch
 * lives in the API route.
 */

/** One upstream provider serving a model, whitelisted from the upstream payload. */
export interface OpenRouterEndpoint {
  /** Display name, e.g. "DeepInfra". */
  providerName: string;
  /** Routing slug used by `only` / `order` / `ignore`, e.g. "deepinfra/fp4". */
  tag: string;
  /** e.g. "fp8", "fp4", "unknown" — a quality tier, not just a speed knob. */
  quantization: string | null;
  contextLength: number | null;
  /** Percent uptime over the last 30 minutes. */
  uptime30m: number | null;
  /** p50 output tokens per second over the last 30 minutes. */
  throughputTps: number | null;
  /** p50 time to first token, milliseconds. */
  ttftMs: number | null;
  /** USD per million prompt / completion tokens. */
  promptPricePerMTok: number | null;
  completionPricePerMTok: number | null;
  /**
   * USD per million tokens read back from the provider's prompt cache.
   *
   * Null when the endpoint quotes no cache rate at all, which is not the same as
   * a cache rate that never applies — see `supportsImplicitCaching`.
   */
  cacheReadPricePerMTok: number | null;
  /**
   * Whether the provider caches repeated context on its own, with no
   * `cache_control` breakpoints in the request.
   *
   * This decides whether `cacheReadPricePerMTok` is a rate you can actually be
   * billed. pi only sends breakpoints for `openrouter:anthropic/*` models
   * (`cacheControlFormat` in the SDK's openai-completions adapter is set for
   * nothing else), so for every other model the quoted cache rate applies only
   * where the provider caches implicitly.
   */
  supportsImplicitCaching: boolean;
}

/** What gets written to `compat.openRouterRouting`. */
export interface OpenRouterRoutingValue {
  only?: string[];
  sort?: string;
  allow_fallbacks?: boolean;
}

/**
 * A reply length in output tokens. The ranking depends on it: below the
 * crossover the provider that starts fastest wins, above it the one that streams
 * fastest does, and for real models those are often different providers.
 */
export const DEFAULT_REPLY_TOKENS = 500;

/** Offered in the UI; a coding turn usually lands in the hundreds. */
export const REPLY_TOKEN_CHOICES = [50, 200, 500, 1000, 2000] as const;

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Percentile bags arrive as `{p50,p75,p90,p99}`; anonymous callers get nothing. */
function p50(value: unknown): number | null {
  if (typeof value === "number") return finiteNumber(value);
  if (!value || typeof value !== "object") return null;
  const bag = value as Record<string, unknown>;
  return finiteNumber(bag.p50) ?? finiteNumber(bag.median) ?? null;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Pricing is quoted per token as a string; the UI wants per million. Rounded
 * because the multiplication is not exact in binary floating point — 4e-7 scales
 * to 0.39999999999999997, which would render as a nonsense price.
 */
function perMillion(value: unknown): number | null {
  const numeric = typeof value === "string" ? Number(value) : finiteNumber(value);
  if (numeric === null || !Number.isFinite(numeric) || numeric < 0) return null;
  return Math.round(numeric * 1_000_000 * 1e6) / 1e6;
}

/**
 * Whitelisting parser for `/models/{slug}/endpoints`. Built field by field so a
 * payload gaining new keys cannot widen what reaches the browser, and so a
 * response missing the stats block degrades to nulls rather than throwing.
 *
 * An endpoint with no `tag` is dropped: the tag is the only thing that can be
 * routed to, so a row without one is unselectable.
 */
export function parseOpenRouterEndpoints(payload: unknown): OpenRouterEndpoint[] {
  if (!payload || typeof payload !== "object") return [];
  const data = (payload as Record<string, unknown>).data;
  if (!data || typeof data !== "object") return [];
  const raw = (data as Record<string, unknown>).endpoints;
  if (!Array.isArray(raw)) return [];

  const endpoints: OpenRouterEndpoint[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const source = entry as Record<string, unknown>;
    const tag = nonEmptyString(source.tag);
    if (tag === null) continue;
    const pricing = (source.pricing && typeof source.pricing === "object"
      ? source.pricing
      : {}) as Record<string, unknown>;
    endpoints.push({
      providerName: nonEmptyString(source.provider_name) ?? tag,
      tag,
      quantization: nonEmptyString(source.quantization),
      contextLength: finiteNumber(source.context_length),
      uptime30m: finiteNumber(source.uptime_last_30m),
      throughputTps: p50(source.throughput_last_30m),
      ttftMs: p50(source.latency_last_30m),
      promptPricePerMTok: perMillion(pricing.prompt),
      completionPricePerMTok: perMillion(pricing.completion),
      cacheReadPricePerMTok: perMillion(pricing.input_cache_read),
      supportsImplicitCaching: source.supports_implicit_caching === true,
    });
  }
  return endpoints;
}

/**
 * The plain mean of the input and output rate, as one number to compare
 * endpoints on.
 *
 * Deliberately unweighted, which is worth knowing when reading it: a real coding
 * turn is heavily input-skewed (tens of thousands in, hundreds out), so the mean
 * gives output far more weight than the bill does. It is still a fair comparator
 * for this catalogue because most endpoints price output at exactly twice input,
 * which makes the mean monotonic in the input rate — but it does reorder the few
 * that break that ratio, so it is a headline figure rather than a cost estimate.
 *
 * Rounded like `perMillion` so two endpoints quoting the same rates cannot
 * differ by float noise and appear as separate extremes.
 */
export function averagePricePerMTok(
  endpoint: Pick<OpenRouterEndpoint, "promptPricePerMTok" | "completionPricePerMTok">,
): number | null {
  const { promptPricePerMTok, completionPricePerMTok } = endpoint;
  if (promptPricePerMTok === null || completionPricePerMTok === null) return null;
  return Math.round(((promptPricePerMTok + completionPricePerMTok) / 2) * 1e6) / 1e6;
}

/**
 * Whether an endpoint's quoted cache-read rate is actually charged for this
 * model's requests.
 *
 * Two ways to get cache pricing, and a quoted rate needs one of them:
 *  - the request carries `cache_control` breakpoints. The SDK's openai-completions
 *    adapter sets `cacheControlFormat` only for `provider === "openrouter" &&
 *    model.id.startsWith("anthropic/")`, so that is the only family pi marks up.
 *  - the provider caches on its own, with no breakpoints — `supports_implicit_caching`.
 *
 * Without either, the endpoint's cache rate is a published number that pi can
 * never be billed at, which is worth showing differently from one that bites.
 */
export function cacheRateApplies(
  modelId: string,
  endpoint: Pick<OpenRouterEndpoint, "supportsImplicitCaching">,
): boolean {
  return modelId.startsWith("anthropic/") || endpoint.supportsImplicitCaching;
}

/**
 * The cheapest and dearest endpoint by some price, for highlighting a column.
 *
 * Both are null when fewer than two distinct prices exist — one priced endpoint,
 * or a catalogue where every endpoint charges the same. Marking the single row as
 * both best and worst, or painting one of a set of identical prices green, would
 * assert a difference that is not there.
 *
 * Ties keep the first endpoint in the given order, so the caller's sort decides
 * which of several equally cheap endpoints is labelled.
 */
export function priceExtremes(
  endpoints: readonly OpenRouterEndpoint[],
  valueOf: (endpoint: OpenRouterEndpoint) => number | null,
): { cheapestTag: string | null; dearestTag: string | null } {
  let cheapest: { tag: string; value: number } | null = null;
  let dearest: { tag: string; value: number } | null = null;
  for (const endpoint of endpoints) {
    const value = valueOf(endpoint);
    if (value === null) continue;
    if (cheapest === null || value < cheapest.value) cheapest = { tag: endpoint.tag, value };
    if (dearest === null || value > dearest.value) dearest = { tag: endpoint.tag, value };
  }
  if (cheapest === null || dearest === null || cheapest.value === dearest.value) {
    return { cheapestTag: null, dearestTag: null };
  }
  return { cheapestTag: cheapest.tag, dearestTag: dearest.tag };
}

/**
 * Predicted wall clock for one turn: time to first token plus the time to stream
 * `outputTokens` at the measured rate.
 *
 * This is deliberately a time estimate rather than a weighted score. A composite
 * score cannot be explained to the person reading it; seconds can, and it makes
 * the reply-length dependency visible instead of burying it in coefficients.
 *
 * Null when either measurement is missing — which is what anonymous callers get,
 * so the caller must handle it rather than rank on a fabricated zero.
 */
export function predictedSeconds(
  endpoint: Pick<OpenRouterEndpoint, "throughputTps" | "ttftMs">,
  outputTokens: number,
): number | null {
  const { throughputTps, ttftMs } = endpoint;
  if (throughputTps === null || throughputTps <= 0) return null;
  if (!Number.isFinite(outputTokens) || outputTokens < 0) return null;
  return (ttftMs ?? 0) / 1000 + outputTokens / throughputTps;
}

/**
 * Fastest predicted first. Endpoints with no measurements sort last rather than
 * being dropped — they are still selectable, just unranked.
 */
export function rankByPredictedSpeed(
  endpoints: readonly OpenRouterEndpoint[],
  outputTokens: number,
): OpenRouterEndpoint[] {
  return [...endpoints].sort((a, b) => {
    const left = predictedSeconds(a, outputTokens);
    const right = predictedSeconds(b, outputTokens);
    if (left === null && right === null) return a.providerName.localeCompare(b.providerName);
    if (left === null) return 1;
    if (right === null) return -1;
    return left - right;
  });
}

/**
 * The reply length at which two endpoints take equally long, i.e. where the
 * ranking between them flips. Null when they never cross (one is faster on both
 * axes) or a measurement is missing.
 */
export function crossoverTokens(
  a: Pick<OpenRouterEndpoint, "throughputTps" | "ttftMs">,
  b: Pick<OpenRouterEndpoint, "throughputTps" | "ttftMs">,
): number | null {
  if (!a.throughputTps || !b.throughputTps) return null;
  const rateGap = 1 / b.throughputTps - 1 / a.throughputTps;
  if (rateGap === 0) return null;
  const startGap = ((a.ttftMs ?? 0) - (b.ttftMs ?? 0)) / 1000;
  const tokens = startGap / rateGap;
  return Number.isFinite(tokens) && tokens > 0 ? tokens : null;
}

/**
 * Only OpenRouter models can be routed, and only by their real slug. Eleven of
 * the catalogue's ids are pi aliases (`~anthropic/claude-opus-latest`) which
 * OpenRouter does not know, so they get no routing affordance rather than a
 * submenu that 404s.
 */
export function isRoutableOpenRouterModel(provider: string, modelId: string): boolean {
  return provider === "openrouter" && modelId.trim() !== "" && !modelId.startsWith("~");
}

/**
 * Builds the value for `compat.openRouterRouting`, or null when the selection
 * says nothing — an empty selection must clear the setting rather than write
 * `only: []`, which would allow no providers at all and fail every request.
 *
 * `only` plus `sort` rather than a frozen `order`: our ranking is computed from
 * 30-minute-old stats and depends on the assumed reply length, so pinning an
 * order bakes in one guess. Restricting the set and letting OpenRouter sort
 * inside it keeps the user's trust boundary while adapting to live conditions.
 */
export function buildOpenRouterRouting(
  selectedTags: readonly string[],
  options: { sort?: string; allowFallbacks?: boolean } = {},
): OpenRouterRoutingValue | null {
  const only = [...new Set(selectedTags.map((tag) => tag.trim()).filter((tag) => tag !== ""))];
  const value: OpenRouterRoutingValue = {};
  if (only.length > 0) value.only = only;
  if (options.sort) value.sort = options.sort;
  if (options.allowFallbacks !== undefined) value.allow_fallbacks = options.allowFallbacks;
  return Object.keys(value).length > 0 ? value : null;
}

// ---------------------------------------------------------------------------
// models.json placement
// ---------------------------------------------------------------------------

/**
 * Routing is stored under `providers.openrouter.modelOverrides[id].compat`.
 *
 * NOT under `providers.openrouter.models[]`, which is the intuitive place and is
 * wrong: `modelFromJson` in the SDK rebuilds the model from scratch and inherits
 * only `api` and `baseUrl` from the built-in entry, so an entry there silently
 * resets `reasoning` to false, `cost` to zero, `contextWindow` to 128000,
 * `maxTokens` to 16384, drops `thinkingLevelMap`, and discards the built-in
 * compat — including the `thinkingFormat: "openrouter"` that reasoning depends
 * on. `modelOverrides` is applied by `applyModelOverride`, which spreads the
 * existing model and replaces only what is supplied.
 */
const PROVIDER_ID = "openrouter";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Current routing for a model, or null when none is stored. */
export function readRoutingFromModelsJson(
  config: unknown,
  modelId: string,
): OpenRouterRoutingValue | null {
  const providers = asRecord(asRecord(config)?.providers);
  const overrides = asRecord(asRecord(providers?.[PROVIDER_ID])?.modelOverrides);
  const compat = asRecord(asRecord(overrides?.[modelId])?.compat);
  const routing = asRecord(compat?.openRouterRouting);
  if (!routing) return null;
  const value: OpenRouterRoutingValue = {};
  if (Array.isArray(routing.only)) {
    const only = routing.only.filter((tag): tag is string => typeof tag === "string");
    if (only.length > 0) value.only = only;
  }
  if (typeof routing.sort === "string") value.sort = routing.sort;
  if (typeof routing.allow_fallbacks === "boolean") value.allow_fallbacks = routing.allow_fallbacks;
  return Object.keys(value).length > 0 ? value : null;
}

/**
 * Returns a new models.json with `routing` stored for `modelId`, or with the
 * setting removed when `routing` is null.
 *
 * Removal prunes every container it empties. This is not tidiness: the SDK
 * rejects a provider entry that specifies none of baseUrl/headers/compat/
 * modelOverrides/models, so leaving `modelOverrides: {}` behind after clearing
 * the last selection would make the whole file invalid and take every model down
 * with it.
 *
 * Other keys at every level are preserved, so this composes with whatever the
 * Models config wrote.
 */
export function applyRoutingToModelsJson(
  config: unknown,
  modelId: string,
  routing: OpenRouterRoutingValue | null,
): Record<string, unknown> {
  const root = { ...(asRecord(config) ?? {}) };
  const providers = { ...(asRecord(root.providers) ?? {}) };
  const provider = { ...(asRecord(providers[PROVIDER_ID]) ?? {}) };
  const overrides = { ...(asRecord(provider.modelOverrides) ?? {}) };
  const override = { ...(asRecord(overrides[modelId]) ?? {}) };
  const compat = { ...(asRecord(override.compat) ?? {}) };

  if (routing === null) delete compat.openRouterRouting;
  else compat.openRouterRouting = routing;

  if (Object.keys(compat).length > 0) override.compat = compat;
  else delete override.compat;

  if (Object.keys(override).length > 0) overrides[modelId] = override;
  else delete overrides[modelId];

  if (Object.keys(overrides).length > 0) provider.modelOverrides = overrides;
  else delete provider.modelOverrides;

  if (Object.keys(provider).length > 0) providers[PROVIDER_ID] = provider;
  else delete providers[PROVIDER_ID];

  root.providers = providers;
  return root;
}
