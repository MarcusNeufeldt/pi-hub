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
