import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const source = readFileSync(new URL("./OpenRouterRoutingMenu.tsx", import.meta.url), "utf8");

describe("the provider menu cannot deadlock its own load", () => {
  it("never puts loadState in a dependency array", () => {
    // The bug this guards: loadState was a dependency of the effect that set it,
    // so setting "loading" re-ran the effect, and the re-run's cleanup cancelled
    // the fetch the first run had started. Both requests returned 200 and every
    // result was discarded, leaving "Loading providers…" on screen permanently.
    const depArrays = source.match(/\}, \[[^\]]*\]\)/g) ?? [];
    assert.ok(depArrays.length > 0, "expected to find dependency arrays");
    for (const deps of depArrays) {
      assert.doesNotMatch(deps, /loadState/, `loadState must not be a dependency: ${deps}`);
    }
  });

  it("loads imperatively from the trigger rather than from an effect", () => {
    assert.match(source, /const loadProviders = useCallback\(/);
    assert.match(source, /if \(next\) void loadProviders\(modelId\)/);
  });

  it("guards duplicate loads with a ref, not with state", () => {
    // State-based guards are what dragged loadState into the dependency array.
    assert.match(source, /const requestedModelRef = useRef<string \| null>\(null\)/);
    assert.match(source, /if \(requestedModelRef\.current === id\) return/);
  });

  it("discards a result only when the model changed, never when the menu closed", () => {
    // Cancelling on close would leave the state saying "loading", so reopening
    // would show the stuck message again — the same symptom by another route.
    assert.match(source, /if \(requestedModelRef\.current !== id\) return/);
    assert.doesNotMatch(source, /let cancelled = false/);
  });

  it("allows a retry after a failure", () => {
    const block = source.slice(source.indexOf("} catch {"), source.indexOf("if (!routable) return null"));
    assert.match(block, /requestedModelRef\.current = null/);
  });

  it("resets the guard when the model changes", () => {
    const block = source.slice(
      source.indexOf("// Switching model invalidates"),
      source.indexOf("}, [provider, modelId]);"),
    );
    assert.match(block, /requestedModelRef\.current = null/);
  });
});

describe("the price columns do not mislead", () => {
  it("dims a cache rate that is published but never charged", () => {
    // Showing all 27 at full strength would read as "every one of these gets
    // cache pricing", which is false for 26 of them on a deepseek model.
    // Delegated to cacheRateApplies rather than tested against
    // supportsImplicitCaching directly: pi does send cache_control for
    // openrouter:anthropic/*, where the rate applies to every endpoint, so
    // implicit caching alone is the wrong question to ask.
    assert.match(source, /cacheRateApplies\(modelId, endpoint\)/);
    assert.match(source, /opacity: cacheCharged \? 1 : 0\.5/);
    assert.doesNotMatch(
      source,
      /opacity: endpoint\.supportsImplicitCaching/,
      "implicit caching alone would wrongly dim every anthropic/* endpoint",
    );
    assert.ok(source.includes("route.cacheNotApplied"));
    assert.ok(source.includes("route.cacheApplied"));
  });

  it("names the extreme in a tooltip rather than relying on colour alone", () => {
    assert.match(source, /priceTitle\(endpoint\.tag, avgExtremes\)/);
    assert.match(source, /priceTitle\(endpoint\.tag, cacheExtremes\)/);
    assert.ok(source.includes("route.cheapest") && source.includes("route.dearest"));
  });

  it("uses the success and danger tokens, not hardcoded colours", () => {
    assert.match(source, /"var\(--success\)"/);
    assert.match(source, /"var\(--danger\)"/);
  });

  it("shares one set of column widths between the header and the rows", () => {
    // Duplicated widths drift, and the header sits above every row, so a drift
    // would be permanently visible rather than a one-row glitch.
    assert.match(source, /const COLUMN: Record</);
    for (const column of ["check", "provider", "time", "tps", "start", "avgPrice", "cachePrice"]) {
      assert.ok(source.includes(`COLUMN.${column}`), `header and rows should both use COLUMN.${column}`);
    }
  });

  it("keeps the header inside the scroll container so a scrollbar cannot skew it", () => {
    // Outside it, the rows lose width to the scrollbar and the header does not.
    const scrollStart = source.indexOf('overflowY: "auto"');
    const headerStart = source.indexOf('position: "sticky"');
    assert.ok(scrollStart > 0 && headerStart > scrollStart, "sticky header must render inside the scroll container");
  });
});

describe("the provider menu only offers what it can route", () => {
  it("renders nothing for models it cannot route", () => {
    assert.match(source, /if \(!routable\) return null/);
    assert.match(source, /isRoutableOpenRouterModel\(provider, modelId\)/);
  });

  it("never writes an empty pin list", () => {
    // Routing is always built through the helper, which refuses `only: []` —
    // that would permit no providers at all and fail every request.
    assert.match(source, /buildOpenRouterRouting\(next, sort \? \{ sort \} : \{\}\)/);
    assert.doesNotMatch(source, /only: \[\]/);
  });

  it("distinguishes the failure states instead of showing an empty list", () => {
    for (const key of ["route.loading", "route.error", "route.none"]) {
      assert.ok(source.includes(key), `expected a distinct state for ${key}`);
    }
  });
});
