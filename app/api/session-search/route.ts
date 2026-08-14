/**
 * Cross-session search.
 *
 * GET  ?q=…   local preselect. Returns ranked sessions with match snippets and
 *             enough SessionInfo for the client to open one. Milliseconds once
 *             the index is warm; the first call pays a ~2s corpus walk.
 * POST {q,ids} hands the candidates' full conversations to a cheap long-context
 *             model and returns which it thinks the user meant.
 *
 * The split exists because the two have very different costs: typing should feel
 * instant, and only an explicit request should spend tokens.
 */
import { NextResponse } from "next/server";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { listAllSessions } from "@/lib/session-reader";
import { buildPickPrompt, parsePicks, type PickCandidate } from "@/lib/search/pick";
import { scoreSessions } from "@/lib/search/score";
import { indexedSession, indexedSessions, refreshSearchIndex } from "@/lib/search/session-index";
import { join } from "path";

export const dynamic = "force-dynamic";

/**
 * Candidate width. Ten keeps the model call around 8s and a cent; 25 measured
 * 20s and 2.3c on this corpus while adding nothing, because the local scorer
 * already clusters the right sessions near the top.
 */
const DEFAULT_CANDIDATES = 10;
const MAX_CANDIDATES = 30;
const MAX_QUERY_LENGTH = 500;

const PICKER_PROVIDER = "openrouter";
const PICKER_MODEL = "deepseek/deepseek-v4-flash-0731";
const PICK_TIMEOUT_MS = 120_000;

/**
 * Picks the model itself doubts are noise. Asked to rank at most three, it will
 * pad the list with near-misses — one observed run returned a 0.10 entry whose
 * own stated reason was that it was probably the wrong session. Surfacing that
 * as a match would be worse than returning one result.
 */
const MIN_PICK_CONFIDENCE = 0.25;

/**
 * Why the model pass cannot run. Returned as a code rather than a sentence so
 * the client can render a localised explanation, and reported by GET so the
 * button is explained before it is clicked rather than after a wasted wait.
 */
export type PickerUnavailableReason = "no_model" | "no_credentials" | "runtime_error";

interface PickerStatus {
  available: boolean;
  reason?: PickerUnavailableReason;
  detail?: string;
}

declare global {
  var __piPickerStatus: { value: PickerStatus; ts: number } | undefined;
}

/**
 * Both checks are local file reads (models.json, auth.json), but GET runs on
 * every keystroke, so the answer is cached briefly. It cannot prove the provider
 * is reachable — only that it is configured; an unreachable host surfaces as a
 * POST error instead.
 */
const PICKER_STATUS_TTL_MS = 30_000;

async function pickerStatus(): Promise<PickerStatus> {
  const cached = globalThis.__piPickerStatus;
  if (cached && Date.now() - cached.ts < PICKER_STATUS_TTL_MS) return cached.value;

  let value: PickerStatus;
  try {
    const modelRuntime = await ModelRuntime.create({
      modelsPath: join(getAgentDir(), "models.json"),
    });
    const model = modelRuntime.getModel(PICKER_PROVIDER, PICKER_MODEL);
    if (!model) {
      value = { available: false, reason: "no_model" };
    } else {
      const resolved = await modelRuntime.getAuth(model);
      value = resolved?.auth.apiKey
        ? { available: true }
        : { available: false, reason: "no_credentials" };
    }
  } catch (error) {
    value = {
      available: false,
      reason: "runtime_error",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  globalThis.__piPickerStatus = { value, ts: Date.now() };
  return value;
}

/** An auth failure from the provider should read as "not connected", not as a 502. */
function isAuthFailure(message: string): boolean {
  return /\b(401|403)\b|unauthor|forbidden|invalid[ _-]?api[ _-]?key|no[ _-]?credit/i.test(message);
}

export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const url = new URL(req.url);
  const query = (url.searchParams.get("q") ?? "").slice(0, MAX_QUERY_LENGTH);
  const limit = Math.min(
    MAX_CANDIDATES,
    Math.max(1, Number(url.searchParams.get("limit")) || DEFAULT_CANDIDATES),
  );

  let stats;
  try {
    stats = await refreshSearchIndex();
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Index refresh failed" },
      { status: 500 },
    );
  }

  /*
   * An empty query returns nothing rather than the most recent sessions. The
   * scorer can fall back to recents, but the sidebar already lists those, so
   * opening this modal to a copy of it just hides the one thing it is for.
   */
  const scored = query.trim().length < 2
    ? []
    : scoreSessions(indexedSessions(), query, { limit });

  // Metadata comes from the session list rather than the index so a rename is
  // reflected even when the transcript itself has not changed.
  const sessions = await listAllSessions();
  const byId = new Map(sessions.map((session) => [session.id, session]));

  const results = scored.flatMap((hit) => {
    const session = byId.get(hit.id);
    if (!session) return [];
    return [{
      score: Number(hit.score.toFixed(4)),
      matchSource: hit.matchSource,
      snippets: hit.snippets,
      session,
    }];
  });

  return NextResponse.json({
    query,
    results,
    index: { sessions: stats.sessions, chars: stats.chars, ms: stats.ms },
    picker: await pickerStatus(),
  });
}

export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Expected application/json" }, { status: 415 });
  }

  let body: { q?: unknown; ids?: unknown };
  try {
    body = await req.json() as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const query = typeof body.q === "string" ? body.q.slice(0, MAX_QUERY_LENGTH) : "";
  const ids = Array.isArray(body.ids)
    ? body.ids.filter((id): id is string => typeof id === "string").slice(0, MAX_CANDIDATES)
    : [];
  if (!query.trim() || !ids.length) {
    return NextResponse.json({ error: "q and ids are required" }, { status: 400 });
  }

  const sessions = await listAllSessions();
  const byId = new Map(sessions.map((session) => [session.id, session]));

  const candidates: PickCandidate[] = [];
  for (const id of ids) {
    const indexed = indexedSession(id);
    if (!indexed) continue;
    const info = byId.get(id);
    candidates.push({
      id,
      name: info?.name,
      modified: info?.modified,
      cwd: info?.cwd,
      messages: indexed.messages,
    });
  }
  if (!candidates.length) {
    return NextResponse.json({ error: "No indexed candidates for those ids" }, { status: 404 });
  }

  const { prompt, tokens, truncatedIds } = buildPickPrompt(query, candidates);

  const modelRuntime = await ModelRuntime.create({
    modelsPath: join(getAgentDir(), "models.json"),
  });
  const model = modelRuntime.getModel(PICKER_PROVIDER, PICKER_MODEL);
  if (!model) {
    return NextResponse.json(
      { reason: "no_model", provider: PICKER_PROVIDER, model: PICKER_MODEL },
      { status: 503 },
    );
  }
  const resolved = await modelRuntime.getAuth(model);
  if (!resolved?.auth.apiKey) {
    return NextResponse.json(
      { reason: "no_credentials", provider: PICKER_PROVIDER },
      { status: 503 },
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PICK_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const message = await completeSimple(model, {
      messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
    }, {
      apiKey: resolved.auth.apiKey,
      headers: resolved.auth.headers,
      // Picking a conversation from its transcript is a reading task, not a
      // reasoning one, and reasoning tokens would dominate a 100k-token prompt.
      reasoning: "off",
      maxTokens: 600,
      timeoutMs: PICK_TIMEOUT_MS,
      maxRetries: 0,
      cacheRetention: "none",
      signal: controller.signal,
    });

    if (message.stopReason === "error" || message.stopReason === "aborted") {
      const detail = message.errorMessage
        ?? (controller.signal.aborted ? "Picker timed out" : "Picker returned an error");
      // A rejected key means "not connected", which the client explains rather
      // than showing a provider error string.
      if (isAuthFailure(detail)) {
        globalThis.__piPickerStatus = undefined;
        return NextResponse.json(
          { reason: "no_credentials", provider: PICKER_PROVIDER, detail },
          { status: 503 },
        );
      }
      return NextResponse.json({ error: detail }, { status: 502 });
    }

    const text = (message.content ?? [])
      .filter((part): part is { type: "text"; text: string } => part?.type === "text")
      .map((part) => part.text)
      .join("");

    const picks = parsePicks(text, candidates.map((candidate) => candidate.id))
      .filter((pick) => pick.confidence >= MIN_PICK_CONFIDENCE);

    return NextResponse.json({
      picks,
      usage: {
        promptTokens: tokens,
        inputTokens: message.usage?.input ?? null,
        costTotal: message.usage?.cost?.total ?? null,
        ms: Date.now() - startedAt,
      },
      truncatedIds,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Picker failed";
    if (isAuthFailure(detail)) {
      globalThis.__piPickerStatus = undefined;
      return NextResponse.json(
        { reason: "no_credentials", provider: PICKER_PROVIDER, detail },
        { status: 503 },
      );
    }
    return NextResponse.json({ error: detail }, { status: 502 });
  } finally {
    clearTimeout(timer);
  }
}
