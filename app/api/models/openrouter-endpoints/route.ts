import { join } from "path";

import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { NextResponse } from "next/server";

import {
  isRoutableOpenRouterModel,
  type OpenRouterEndpoint,
  parseOpenRouterEndpoints,
} from "@/lib/openrouter-routing";

export const dynamic = "force-dynamic";

const ENDPOINTS_URL = "https://openrouter.ai/api/v1/models";
const REQUEST_TIMEOUT_MS = 10_000;
/**
 * Upstream publishes 30-minute rolling stats, so re-fetching faster than this
 * cannot show the user anything new — it only adds requests.
 */
const CACHE_TTL_MS = 10 * 60_000;

const cache = new Map<string, { endpoints: OpenRouterEndpoint[]; fetchedAt: number }>();

/**
 * Resolves the OpenRouter API key through the SDK rather than reading a
 * credential file here. That keeps this route out of the business of knowing
 * where keys live (env var, stored credential, OAuth) and picks up whatever the
 * user has configured.
 *
 * The outcome is discriminated rather than a nullable string: an unknown model id
 * and an unconfigured key are different problems, and collapsing them reports
 * "no credentials" for a model that simply is not in the catalogue.
 */
type KeyLookup =
  | { ok: true; apiKey: string }
  | { ok: false; reason: "unknown-model" | "no-credentials" };

async function resolveOpenRouterKey(modelId: string): Promise<KeyLookup> {
  try {
    const runtime = await ModelRuntime.create({ modelsPath: join(getAgentDir(), "models.json") });
    if (runtime.getError()) return { ok: false, reason: "no-credentials" };
    const model = runtime.getModel("openrouter", modelId);
    if (!model) return { ok: false, reason: "unknown-model" };
    const resolved = await runtime.getAuth(model);
    const apiKey = resolved?.auth?.apiKey;
    if (typeof apiKey !== "string" || apiKey === "") return { ok: false, reason: "no-credentials" };
    return { ok: true, apiKey };
  } catch {
    return { ok: false, reason: "no-credentials" };
  }
}

/**
 * Upstream providers serving one OpenRouter model, with speed figures.
 *
 * Authenticated: the throughput and latency percentiles are omitted for
 * anonymous callers, and those are the whole point, so the key is resolved
 * server-side and never sent to the browser. Only the whitelisted fields from
 * `parseOpenRouterEndpoints` are returned.
 *
 * Always 200 with `available: false` on failure — this decorates a model picker,
 * so an unreachable upstream or an unconfigured key should hide the affordance
 * rather than surface an error.
 */
export async function GET(request: Request) {
  const modelId = new URL(request.url).searchParams.get("model")?.trim() ?? "";
  if (!isRoutableOpenRouterModel("openrouter", modelId)) {
    return NextResponse.json(
      { available: false, reason: "not-routable" },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const cached = cache.get(modelId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return NextResponse.json(
      { available: true, endpoints: cached.endpoints, fetchedAt: cached.fetchedAt },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const lookup = await resolveOpenRouterKey(modelId);
  if (!lookup.ok) {
    return NextResponse.json(
      { available: false, reason: lookup.reason },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  let response: Response;
  try {
    // The slug contains a slash (author/model) which must survive unescaped.
    response = await fetch(`${ENDPOINTS_URL}/${modelId}/endpoints`, {
      headers: { Authorization: `Bearer ${lookup.apiKey}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    return NextResponse.json(
      { available: false, reason: "unreachable" },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  if (!response.ok) {
    // Release the socket without reading the body, so an error body carrying the
    // request echo can never be logged.
    void response.body?.cancel();
    return NextResponse.json(
      { available: false, reason: response.status === 404 ? "unknown-model" : "unreachable" },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  let endpoints: OpenRouterEndpoint[];
  try {
    endpoints = parseOpenRouterEndpoints(await response.json());
  } catch {
    return NextResponse.json(
      { available: false, reason: "unrecognized" },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  // A model served by a single provider has nothing to choose between.
  if (endpoints.length === 0) {
    return NextResponse.json(
      { available: false, reason: "no-endpoints" },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const fetchedAt = Date.now();
  cache.set(modelId, { endpoints, fetchedAt });
  return NextResponse.json(
    { available: true, endpoints, fetchedAt },
    { headers: { "Cache-Control": "no-store" } },
  );
}
