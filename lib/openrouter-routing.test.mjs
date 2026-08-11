import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyRoutingToModelsJson,
  averagePricePerMTok,
  buildOpenRouterRouting,
  cacheRateApplies,
  crossoverTokens,
  DEFAULT_REPLY_TOKENS,
  isRoutableOpenRouterModel,
  parseOpenRouterEndpoints,
  predictedSeconds,
  priceExtremes,
  rankByPredictedSpeed,
  readRoutingFromModelsJson,
} from "./openrouter-routing.ts";

/** Shape of a real /models/{slug}/endpoints response for an authenticated call. */
const LIVE_PAYLOAD = {
  data: {
    id: "deepseek/deepseek-chat",
    endpoints: [
      {
        provider_name: "StreamLake",
        tag: "streamlake",
        quantization: "unknown",
        context_length: 128000,
        uptime_last_30m: 99.6,
        throughput_last_30m: { p50: 24, p75: 31, p90: 37, p99: 49 },
        latency_last_30m: { p50: 1625.5, p75: 1952, p90: 2481.9, p99: 5174.07 },
        pricing: { prompt: "0.0000004", completion: "0.0000012", input_cache_read: "0.00000008" },
      },
      {
        provider_name: "DeepInfra",
        tag: "deepinfra/fp4",
        quantization: "fp4",
        context_length: 163840,
        uptime_last_30m: 98.4,
        throughput_last_30m: { p50: 17 },
        latency_last_30m: { p50: 523 },
        // The only endpoint here that caches without breakpoints, so the only one
        // whose cache rate can actually be charged for a non-anthropic model.
        supports_implicit_caching: true,
        pricing: { prompt: "0.0000002", completion: "0.0000006", input_cache_read: "0.00000002" },
      },
    ],
  },
};

describe("parseOpenRouterEndpoints", () => {
  it("reads the fields the UI needs from a live payload", () => {
    const [streamlake, deepinfra] = parseOpenRouterEndpoints(LIVE_PAYLOAD);
    assert.equal(streamlake.providerName, "StreamLake");
    assert.equal(streamlake.tag, "streamlake");
    assert.equal(streamlake.throughputTps, 24);
    assert.equal(streamlake.ttftMs, 1625.5);
    assert.equal(streamlake.uptime30m, 99.6);
    assert.equal(deepinfra.quantization, "fp4");
    assert.equal(deepinfra.contextLength, 163840);
  });

  it("converts per-token pricing to per-million", () => {
    const [streamlake] = parseOpenRouterEndpoints(LIVE_PAYLOAD);
    assert.equal(streamlake.promptPricePerMTok, 0.4);
    assert.equal(streamlake.completionPricePerMTok, 1.2);
  });

  it("degrades to nulls when the stats block is absent", () => {
    // Exactly what an unauthenticated caller receives: uptime but no percentiles.
    const [only] = parseOpenRouterEndpoints({
      data: { endpoints: [{ provider_name: "Novita", tag: "novita/fp8", uptime_last_30m: 99.9 }] },
    });
    assert.equal(only.throughputTps, null);
    assert.equal(only.ttftMs, null);
    assert.equal(only.uptime30m, 99.9);
  });

  it("drops endpoints with no tag, since nothing can be routed to them", () => {
    const parsed = parseOpenRouterEndpoints({
      data: { endpoints: [{ provider_name: "Ghost" }, { provider_name: "Real", tag: "real" }] },
    });
    assert.deepEqual(parsed.map((e) => e.tag), ["real"]);
  });

  it("returns an empty list for malformed payloads rather than throwing", () => {
    for (const bad of [null, undefined, 42, "nope", {}, { data: {} }, { data: { endpoints: {} } }]) {
      assert.deepEqual(parseOpenRouterEndpoints(bad), []);
    }
  });

  it("converts the cache-read rate to per-million like the other prices", () => {
    const [streamlake, deepinfra] = parseOpenRouterEndpoints(LIVE_PAYLOAD);
    assert.equal(streamlake.cacheReadPricePerMTok, 0.08);
    assert.equal(deepinfra.cacheReadPricePerMTok, 0.02);
  });

  it("reads implicit caching, defaulting to false when the flag is absent", () => {
    // A quoted cache rate is not the same as one that applies: pi sends
    // cache_control only for openrouter:anthropic/*, so for everything else the
    // rate is charged only where the provider caches on its own.
    const [streamlake, deepinfra] = parseOpenRouterEndpoints(LIVE_PAYLOAD);
    assert.equal(deepinfra.supportsImplicitCaching, true);
    assert.equal(streamlake.supportsImplicitCaching, false);
  });

  it("treats a non-boolean implicit-caching flag as false", () => {
    const [only] = parseOpenRouterEndpoints({
      data: { endpoints: [{ tag: "odd", supports_implicit_caching: "yes" }] },
    });
    assert.equal(only.supportsImplicitCaching, false);
  });

  it("leaves the cache rate null when the endpoint quotes none", () => {
    const [only] = parseOpenRouterEndpoints({
      data: { endpoints: [{ tag: "mancer/fp8", pricing: { prompt: "0.000000175" } }] },
    });
    assert.equal(only.cacheReadPricePerMTok, null);
  });
});

describe("averagePricePerMTok", () => {
  it("is the plain mean of input and output", () => {
    assert.equal(averagePricePerMTok({ promptPricePerMTok: 0.4, completionPricePerMTok: 1.2 }), 0.8);
  });

  it("rounds away float noise so equal rates cannot look like different prices", () => {
    // (0.14 + 0.28) / 2 is 0.21000000000000002 in binary floating point. Two
    // endpoints quoting the same rates must land on the same number, or one gets
    // highlighted as an extreme over the other for no reason.
    assert.equal(averagePricePerMTok({ promptPricePerMTok: 0.14, completionPricePerMTok: 0.28 }), 0.21);
  });

  it("is null when either side is unpriced", () => {
    assert.equal(averagePricePerMTok({ promptPricePerMTok: null, completionPricePerMTok: 1.2 }), null);
    assert.equal(averagePricePerMTok({ promptPricePerMTok: 0.4, completionPricePerMTok: null }), null);
  });
});

describe("cacheRateApplies", () => {
  const implicit = { supportsImplicitCaching: true };
  const noImplicit = { supportsImplicitCaching: false };

  it("applies where the provider caches on its own", () => {
    assert.equal(cacheRateApplies("deepseek/deepseek-v4-flash-0731", implicit), true);
  });

  it("does not apply on a provider that needs breakpoints pi will not send", () => {
    assert.equal(cacheRateApplies("deepseek/deepseek-v4-flash-0731", noImplicit), false);
  });

  it("applies to every anthropic endpoint, implicit caching or not", () => {
    // The SDK sets cacheControlFormat for provider "openrouter" + an anthropic/
    // model id, so pi marks these requests up and the rate is charged whether or
    // not the provider caches by itself. Keying on implicit caching alone would
    // dim a rate that is very much being billed.
    assert.equal(cacheRateApplies("anthropic/claude-sonnet-4.5", noImplicit), true);
    assert.equal(cacheRateApplies("anthropic/claude-opus-4.1", implicit), true);
  });

  it("does not treat a provider merely named like anthropic as anthropic", () => {
    assert.equal(cacheRateApplies("anthropic-community/some-tune", noImplicit), false);
  });
});

describe("priceExtremes", () => {
  const at = (tag, value) => ({ tag, value });
  const byValue = (endpoint) => endpoint.value;

  it("finds the cheapest and the dearest", () => {
    const result = priceExtremes([at("a", 0.4), at("b", 0.1), at("c", 0.9)], byValue);
    assert.deepEqual(result, { cheapestTag: "b", dearestTag: "c" });
  });

  it("highlights nothing when every endpoint charges the same", () => {
    // Painting one of a set of identical prices green asserts a difference that
    // is not there — kimi-k2-thinking's two endpoints are priced identically.
    assert.deepEqual(
      priceExtremes([at("a", 0.5), at("b", 0.5)], byValue),
      { cheapestTag: null, dearestTag: null },
    );
  });

  it("highlights nothing when only one endpoint is priced", () => {
    // Otherwise the same row is both best and worst.
    assert.deepEqual(
      priceExtremes([at("a", 0.5), at("b", null)], byValue),
      { cheapestTag: null, dearestTag: null },
    );
  });

  it("highlights nothing for an empty list", () => {
    assert.deepEqual(priceExtremes([], byValue), { cheapestTag: null, dearestTag: null });
  });

  it("skips unpriced endpoints rather than treating them as free", () => {
    const result = priceExtremes([at("a", null), at("b", 0.3), at("c", 0.7)], byValue);
    assert.deepEqual(result, { cheapestTag: "b", dearestTag: "c" });
  });

  it("keeps the first endpoint on a tie, so the caller's sort decides", () => {
    const result = priceExtremes([at("fast", 0.1), at("slow", 0.1), at("dear", 0.9)], byValue);
    assert.equal(result.cheapestTag, "fast");
  });

  it("works on real parsed endpoints for both price columns", () => {
    const endpoints = parseOpenRouterEndpoints(LIVE_PAYLOAD);
    assert.deepEqual(
      priceExtremes(endpoints, averagePricePerMTok),
      { cheapestTag: "deepinfra/fp4", dearestTag: "streamlake" },
    );
    assert.deepEqual(
      priceExtremes(endpoints, (endpoint) => endpoint.cacheReadPricePerMTok),
      { cheapestTag: "deepinfra/fp4", dearestTag: "streamlake" },
    );
  });
});

describe("predictedSeconds", () => {
  it("is time-to-first-token plus streaming time", () => {
    // 1625.5ms + 500/24 tokens = 1.6255 + 20.8333
    assert.equal(
      predictedSeconds({ throughputTps: 24, ttftMs: 1625.5 }, 500).toFixed(3),
      "22.459",
    );
  });

  it("treats a missing time-to-first-token as zero rather than unknown", () => {
    assert.equal(predictedSeconds({ throughputTps: 10, ttftMs: null }, 100), 10);
  });

  it("is null without a throughput measurement", () => {
    assert.equal(predictedSeconds({ throughputTps: null, ttftMs: 500 }, 100), null);
    assert.equal(predictedSeconds({ throughputTps: 0, ttftMs: 500 }, 100), null);
  });

  it("rejects nonsense reply lengths", () => {
    assert.equal(predictedSeconds({ throughputTps: 10, ttftMs: 0 }, -1), null);
    assert.equal(predictedSeconds({ throughputTps: 10, ttftMs: 0 }, Number.NaN), null);
  });
});

describe("rankByPredictedSpeed", () => {
  const endpoints = parseOpenRouterEndpoints(LIVE_PAYLOAD);

  it("puts the fast-starting provider first for a short reply", () => {
    // 30 tokens: DeepInfra 0.523+1.76=2.29s beats StreamLake 1.63+1.25=2.88s
    assert.equal(rankByPredictedSpeed(endpoints, 30)[0].tag, "deepinfra/fp4");
  });

  it("puts the high-throughput provider first for a long reply", () => {
    // 500 tokens: StreamLake 22.46s beats DeepInfra 29.93s
    assert.equal(rankByPredictedSpeed(endpoints, 500)[0].tag, "streamlake");
  });

  it("sorts unmeasured endpoints last without dropping them", () => {
    const withUnknown = [
      ...endpoints,
      { providerName: "Mystery", tag: "mystery", quantization: null, contextLength: null, uptime30m: null, throughputTps: null, ttftMs: null, promptPricePerMTok: null, completionPricePerMTok: null },
    ];
    const ranked = rankByPredictedSpeed(withUnknown, DEFAULT_REPLY_TOKENS);
    assert.equal(ranked.length, 3);
    assert.equal(ranked[2].tag, "mystery");
  });

  it("does not mutate its input", () => {
    const before = endpoints.map((e) => e.tag);
    rankByPredictedSpeed(endpoints, 30);
    assert.deepEqual(endpoints.map((e) => e.tag), before);
  });
});

describe("crossoverTokens", () => {
  it("finds where the ranking flips", () => {
    const [streamlake, deepinfra] = parseOpenRouterEndpoints(LIVE_PAYLOAD);
    // Verified against the real figures: 64 output tokens.
    assert.equal(Math.round(crossoverTokens(deepinfra, streamlake)), 64);
  });

  it("agrees with predictedSeconds at the crossover", () => {
    const [streamlake, deepinfra] = parseOpenRouterEndpoints(LIVE_PAYLOAD);
    const n = crossoverTokens(deepinfra, streamlake);
    assert.ok(Math.abs(predictedSeconds(deepinfra, n) - predictedSeconds(streamlake, n)) < 1e-9);
  });

  it("is null when one endpoint wins on both axes", () => {
    const fast = { throughputTps: 50, ttftMs: 100 };
    const slow = { throughputTps: 10, ttftMs: 900 };
    assert.equal(crossoverTokens(fast, slow), null);
  });

  it("is null when a measurement is missing", () => {
    assert.equal(crossoverTokens({ throughputTps: null, ttftMs: 1 }, { throughputTps: 10, ttftMs: 2 }), null);
  });
});

describe("isRoutableOpenRouterModel", () => {
  it("accepts real OpenRouter slugs", () => {
    assert.equal(isRoutableOpenRouterModel("openrouter", "deepseek/deepseek-chat"), true);
  });

  it("rejects pi alias ids, which OpenRouter does not know", () => {
    assert.equal(isRoutableOpenRouterModel("openrouter", "~anthropic/claude-opus-latest"), false);
  });

  it("rejects other providers", () => {
    assert.equal(isRoutableOpenRouterModel("opencode-go", "deepseek/deepseek-chat"), false);
    assert.equal(isRoutableOpenRouterModel("openai-codex", "gpt-5.6"), false);
  });
});

describe("buildOpenRouterRouting", () => {
  it("restricts to the selected tags and delegates ordering", () => {
    assert.deepEqual(
      buildOpenRouterRouting(["streamlake", "novita/fp8"], { sort: "throughput" }),
      { only: ["streamlake", "novita/fp8"], sort: "throughput" },
    );
  });

  it("never writes an empty only list", () => {
    // `only: []` would permit no providers and fail every request; the setting
    // must be cleared instead.
    assert.equal(buildOpenRouterRouting([]), null);
    assert.equal(buildOpenRouterRouting(["", "  "]), null);
  });

  it("keeps sort alone when nothing is pinned", () => {
    assert.deepEqual(buildOpenRouterRouting([], { sort: "throughput" }), { sort: "throughput" });
  });

  it("deduplicates and trims tags", () => {
    assert.deepEqual(
      buildOpenRouterRouting([" streamlake ", "streamlake"]),
      { only: ["streamlake"] },
    );
  });

  it("carries allow_fallbacks only when set", () => {
    assert.deepEqual(buildOpenRouterRouting(["a"], { allowFallbacks: false }), { only: ["a"], allow_fallbacks: false });
    assert.equal("allow_fallbacks" in buildOpenRouterRouting(["a"]), false);
  });
});

describe("models.json placement", () => {
  const MODEL = "deepseek/deepseek-chat";
  const ROUTING = { only: ["streamlake"], sort: "throughput" };

  it("writes under modelOverrides, never under models[]", () => {
    // models[] would rebuild the model from scratch and drop its built-in
    // reasoning config, cost, context window and compat.
    const next = applyRoutingToModelsJson({}, MODEL, ROUTING);
    assert.deepEqual(
      next.providers.openrouter.modelOverrides[MODEL].compat.openRouterRouting,
      ROUTING,
    );
    assert.equal("models" in next.providers.openrouter, false);
  });

  it("round-trips through the reader", () => {
    const next = applyRoutingToModelsJson({}, MODEL, ROUTING);
    assert.deepEqual(readRoutingFromModelsJson(next, MODEL), ROUTING);
  });

  it("reads null when nothing is stored", () => {
    assert.equal(readRoutingFromModelsJson({}, MODEL), null);
    assert.equal(readRoutingFromModelsJson({ providers: {} }, MODEL), null);
    assert.equal(readRoutingFromModelsJson(null, MODEL), null);
    assert.equal(readRoutingFromModelsJson(applyRoutingToModelsJson({}, MODEL, ROUTING), "other/model"), null);
  });

  it("prunes every container it empties when clearing", () => {
    // Leaving `modelOverrides: {}` behind would make the provider entry specify
    // nothing, which the SDK rejects — taking every model down, not just this one.
    const withRouting = applyRoutingToModelsJson({}, MODEL, ROUTING);
    const cleared = applyRoutingToModelsJson(withRouting, MODEL, null);
    assert.deepEqual(cleared, { providers: {} });
  });

  it("keeps sibling models when clearing one", () => {
    let config = applyRoutingToModelsJson({}, MODEL, ROUTING);
    config = applyRoutingToModelsJson(config, "qwen/qwen3", { sort: "latency" });
    const cleared = applyRoutingToModelsJson(config, MODEL, null);
    assert.equal(MODEL in cleared.providers.openrouter.modelOverrides, false);
    assert.deepEqual(
      cleared.providers.openrouter.modelOverrides["qwen/qwen3"].compat.openRouterRouting,
      { sort: "latency" },
    );
  });

  it("preserves unrelated keys at every level", () => {
    const before = {
      providers: {
        openrouter: {
          headers: { "X-Title": "pi" },
          modelOverrides: { [MODEL]: { contextWindow: 163840, compat: { thinkingFormat: "openrouter" } } },
        },
        anthropic: { baseUrl: "https://example.invalid" },
      },
    };
    const next = applyRoutingToModelsJson(before, MODEL, ROUTING);
    assert.deepEqual(next.providers.anthropic, { baseUrl: "https://example.invalid" });
    assert.deepEqual(next.providers.openrouter.headers, { "X-Title": "pi" });
    const override = next.providers.openrouter.modelOverrides[MODEL];
    assert.equal(override.contextWindow, 163840);
    // An existing compat key must survive alongside the routing we add.
    assert.equal(override.compat.thinkingFormat, "openrouter");
    assert.deepEqual(override.compat.openRouterRouting, ROUTING);
  });

  it("clearing leaves a co-located compat key intact", () => {
    const before = {
      providers: { openrouter: { modelOverrides: { [MODEL]: { compat: { thinkingFormat: "openrouter" } } } } },
    };
    const withRouting = applyRoutingToModelsJson(before, MODEL, ROUTING);
    const cleared = applyRoutingToModelsJson(withRouting, MODEL, null);
    assert.deepEqual(
      cleared.providers.openrouter.modelOverrides[MODEL].compat,
      { thinkingFormat: "openrouter" },
    );
  });

  it("does not mutate the input config", () => {
    const before = { providers: { openrouter: { modelOverrides: {} } } };
    const snapshot = JSON.stringify(before);
    applyRoutingToModelsJson(before, MODEL, ROUTING);
    assert.equal(JSON.stringify(before), snapshot);
  });
});
