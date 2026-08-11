import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyRoutingToModelsJson,
  buildOpenRouterRouting,
  crossoverTokens,
  DEFAULT_REPLY_TOKENS,
  isRoutableOpenRouterModel,
  parseOpenRouterEndpoints,
  predictedSeconds,
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
        pricing: { prompt: "0.0000004", completion: "0.0000012" },
      },
      {
        provider_name: "DeepInfra",
        tag: "deepinfra/fp4",
        quantization: "fp4",
        context_length: 163840,
        uptime_last_30m: 98.4,
        throughput_last_30m: { p50: 17 },
        latency_last_30m: { p50: 523 },
        pricing: { prompt: "0.0000002", completion: "0.0000006" },
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
