// Guards the remote model-catalog refresh.
//
// Provider catalogs live in ~/.pi/agent/models-store.json and only advance when
// something calls modelRuntime.refresh() with the network allowed. Nothing in
// pi-hub ever did: the sole existing call site passes allowNetwork: false as a
// cheap local re-read after a set_model miss. So the store only moved when the pi
// CLI happened to run, and a browser-only user sat days behind — x-ai/grok-4.6 was
// in pi's catalog and missing from the picker while checkedAt was 74 hours old.
//
// Source assertions: the route imports createAgentSessionServices, which starts a
// real agent session, so it cannot be exercised in-process.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
const rpcManager = readFileSync(new URL("../../../lib/rpc-manager.ts", import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

test("the models route refreshes the catalog over the network", () => {
  assert.match(code, /modelRuntime\.refresh\(\{/);
  assert.match(code, /allowNetwork: true/);
});

test("the refresh is bounded", () => {
  // The model list is on the UI's critical path. An unreachable catalog host must
  // degrade to the stored catalog, not hang the picker.
  assert.match(code, /const MODEL_CATALOG_REFRESH_TIMEOUT_MS = /);
  assert.match(code, /signal: AbortSignal\.timeout\(MODEL_CATALOG_REFRESH_TIMEOUT_MS\)/);
});

test("a refresh failure cannot break the model list", () => {
  // refresh() collects per-provider failures into a map instead of throwing, so
  // both the map and the surrounding throw have to be handled.
  const fn = code.slice(code.indexOf("modelRuntime.refresh({"));
  const region = fn.slice(0, 800);
  assert.match(region, /refreshed\.errors/);
  assert.match(code, /catch \(error\) \{[\s\S]{0,200}model catalog refresh failed/);
});

test("the refresh runs before the visible set is resolved", () => {
  // Otherwise newly fetched models would not appear until the *next* request.
  const refreshAt = code.indexOf("modelRuntime.refresh({");
  const resolveAt = code.indexOf("resolveVisibleModels(");
  assert.ok(refreshAt > 0 && resolveAt > 0, "expected both calls present");
  assert.ok(refreshAt < resolveAt, "refresh must precede resolveVisibleModels");
});

test("set_model keeps its deliberate offline re-read", () => {
  // That call is not a catalog refresh — it re-reads the local store after a miss,
  // so a model added to models.json is picked up without a network round trip.
  // Flipping it to allowNetwork: true would put a fetch on every model switch.
  assert.match(rpcManager, /modelRuntime\.refresh\(\{ allowNetwork: false \}\)/);
});
