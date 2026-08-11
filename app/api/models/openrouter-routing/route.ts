import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";

import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { NextResponse } from "next/server";

import { writePrivateFileAtomicSync } from "@/lib/atomic-file";
import { invalidateModelsCache } from "@/lib/models-cache";
import {
  applyRoutingToModelsJson,
  isRoutableOpenRouterModel,
  type OpenRouterRoutingValue,
  readRoutingFromModelsJson,
} from "@/lib/openrouter-routing";

export const dynamic = "force-dynamic";

function getModelsPath(): string {
  return join(getAgentDir(), "models.json");
}

function readModelsJson(): Record<string, unknown> {
  const path = getModelsPath();
  if (!existsSync(path)) return { providers: {} };
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return { providers: {} };
  }
}

function writeModelsJson(data: Record<string, unknown>): void {
  const path = getModelsPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writePrivateFileAtomicSync(path, JSON.stringify(data, null, 2));
}

/**
 * Whether the id is actually served by OpenRouter.
 *
 * `isRoutableOpenRouterModel` cannot answer this: it is given the literal
 * provider "openrouter", so it only screens out the `~` aliases. Without a
 * catalogue check, a model belonging to another provider — say a Codex model id —
 * is happily written under `providers.openrouter.modelOverrides`, leaving junk
 * that applies to nothing.
 */
async function existsInOpenRouterCatalog(modelId: string): Promise<boolean> {
  try {
    const runtime = await ModelRuntime.create({ modelsPath: getModelsPath() });
    if (runtime.getError()) return false;
    return Boolean(runtime.getModel("openrouter", modelId));
  } catch {
    return false;
  }
}

/** Accepts only the routing fields, so a client cannot post arbitrary compat. */
function parseRoutingBody(value: unknown): OpenRouterRoutingValue | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const routing: OpenRouterRoutingValue = {};
  if (Array.isArray(source.only)) {
    const only = source.only
      .filter((tag): tag is string => typeof tag === "string")
      .map((tag) => tag.trim())
      .filter((tag) => tag !== "");
    // An empty `only` would permit no providers and fail every request, so it is
    // dropped rather than written.
    if (only.length > 0) routing.only = [...new Set(only)];
  }
  if (typeof source.sort === "string" && source.sort.trim() !== "") routing.sort = source.sort.trim();
  if (typeof source.allow_fallbacks === "boolean") routing.allow_fallbacks = source.allow_fallbacks;
  return Object.keys(routing).length > 0 ? routing : null;
}

/** Current routing for one model. */
export async function GET(request: Request) {
  const modelId = new URL(request.url).searchParams.get("model")?.trim() ?? "";
  if (!isRoutableOpenRouterModel("openrouter", modelId)) {
    return NextResponse.json({ routing: null }, { headers: { "Cache-Control": "no-store" } });
  }
  return NextResponse.json(
    { routing: readRoutingFromModelsJson(readModelsJson(), modelId) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * Stores (or clears) provider routing for one model.
 *
 * Read-modify-write happens here rather than in the browser so the client never
 * round-trips the whole models.json — which would let a stale copy clobber
 * whatever the Models config wrote in between.
 *
 * A null or empty routing clears the setting and prunes the containers it
 * empties; see `applyRoutingToModelsJson` for why that pruning is load-bearing.
 */
export async function PUT(request: Request) {
  try {
    const body = await request.json() as { model?: unknown; routing?: unknown };
    const modelId = typeof body.model === "string" ? body.model.trim() : "";
    if (!isRoutableOpenRouterModel("openrouter", modelId)) {
      return NextResponse.json({ error: "Not a routable OpenRouter model" }, { status: 400 });
    }
    // Clearing is allowed for an id no longer in the catalogue, so a stale entry
    // stays removable after the model is withdrawn upstream.
    const routing = parseRoutingBody(body.routing);
    if (routing !== null && !(await existsInOpenRouterCatalog(modelId))) {
      return NextResponse.json({ error: "Unknown OpenRouter model" }, { status: 400 });
    }
    writeModelsJson(applyRoutingToModelsJson(readModelsJson(), modelId, routing));
    // Without this the composed provider keeps serving the previous routing.
    invalidateModelsCache();
    return NextResponse.json({ success: true, routing });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
