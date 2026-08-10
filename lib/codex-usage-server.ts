/**
 * Live Codex plan-quota fetch. Server-only — reads a credential file.
 *
 * Source is the same endpoint the Codex desktop app itself uses,
 * `chatgpt.com/backend-api/wham/usage`, authenticated with the credential the
 * app already wrote to `$CODEX_HOME/auth.json`. Nothing here shells out to the
 * Codex CLI and nothing depends on a proxy being installed.
 *
 * Why not read Codex's local session rollouts instead: they carry the same
 * rate-limit payload without needing a token, but only as of the last request
 * Codex happened to make. Measured against this endpoint, the freshest local
 * snapshot for the account-level bucket read 35% while the account was actually
 * at 15% — the weekly window had rolled over days earlier and no local write had
 * happened since. A number that can be twice the truth is worse than no badge,
 * so the live reading is the only source and there is no local fallback.
 *
 * Two hard rules, because this is credential-adjacent:
 *   1. `auth.json` is read-only, and re-read per fetch so the desktop app's own
 *      token refreshes are picked up for free. Writing it back from here (an
 *      OAuth refresh, say) would race the app for the same file.
 *   2. Nothing is logged. The token is in scope throughout, and the upstream
 *      response body carries the account email and ids, so a debug log here
 *      would leak them into the server log.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import {
  type CodexUnavailableReason,
  type CodexUsage,
  type CodexUsageResult,
  parseCodexUsage,
  toNonEmptyString,
} from "./codex-usage";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const REQUEST_TIMEOUT_MS = 8_000;
/** Serve a cached reading this long before re-fetching. */
const FRESH_TTL_MS = 60_000;
/** On a failed refresh, keep serving the last good reading up to this age. */
const STALE_TOLERANCE_MS = 15 * 60_000;

function codexHome(): string {
  const override = process.env.CODEX_HOME?.trim();
  return override && override !== "" ? override : path.join(homedir(), ".codex");
}

async function readCredentials(): Promise<{ accessToken: string; accountId: string } | null> {
  try {
    const raw = await readFile(path.join(codexHome(), "auth.json"), "utf8");
    // Tolerate a leading BOM: this file belongs to another program, and a
    // byte-order mark would otherwise fail JSON.parse and look identical to
    // "not signed in", which is a miserable thing to debug from a hidden badge.
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, "")) as {
      tokens?: { access_token?: unknown; account_id?: unknown };
    };
    const accessToken = toNonEmptyString(parsed.tokens?.access_token);
    const accountId = toNonEmptyString(parsed.tokens?.account_id);
    if (accessToken === null || accountId === null) return null;
    return { accessToken, accountId };
  } catch {
    // Missing file, unreadable file, malformed JSON — all mean "no quota to
    // show", which is a hidden badge rather than an error.
    return null;
  }
}

let cachedUsage: CodexUsage | null = null;
let inFlight: Promise<CodexUsageResult> | null = null;

/**
 * A failed refresh keeps showing the last good reading for a short while rather
 * than blinking the badge out on one dropped request. Past that the badge goes
 * away entirely — quota is decorative, and a wrong number is worse than none.
 */
function unavailable(reason: CodexUnavailableReason): CodexUsageResult {
  if (cachedUsage && Date.now() - cachedUsage.fetchedAt < STALE_TOLERANCE_MS) {
    return { available: true, usage: cachedUsage };
  }
  return { available: false, reason };
}

async function fetchUsage(now: number): Promise<CodexUsageResult> {
  const credentials = await readCredentials();
  if (credentials === null) return unavailable("no-credentials");

  let response: Response;
  try {
    response = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        "ChatGPT-Account-Id": credentials.accountId,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    return unavailable("unreachable");
  }

  if (!response.ok) {
    // Release the socket without reading the body. Error bodies are never
    // inspected here, so that they can never be logged.
    void response.body?.cancel();
    return unavailable(
      response.status === 401 || response.status === 403 ? "unauthorized" : "unreachable",
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return unavailable("unrecognized");
  }

  const usage = parseCodexUsage(payload, now);
  if (usage === null) return unavailable("unrecognized");

  cachedUsage = usage;
  return { available: true, usage };
}

/**
 * Cached, de-duplicated quota reading. Concurrent callers — several browser tabs
 * polling at once — share one upstream request.
 */
export async function getCodexUsage(): Promise<CodexUsageResult> {
  const now = Date.now();
  if (cachedUsage && now - cachedUsage.fetchedAt < FRESH_TTL_MS) {
    return { available: true, usage: cachedUsage };
  }
  if (inFlight) return inFlight;
  inFlight = fetchUsage(now).finally(() => { inFlight = null; });
  return inFlight;
}
