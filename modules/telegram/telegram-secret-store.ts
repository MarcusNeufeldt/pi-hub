/**
 * Telegram Bot Token secret store.
 *
 * Token sources, in priority order (design doc §10.3):
 *   1. environment variable `PI_HUB_TELEGRAM_BOT_TOKEN`
 *   2. `~/.pi/hub/secrets.json` (0600) under `telegram.botToken`
 *   3. unset
 *
 * The token is NEVER persisted in SQLite (`telegram_settings` has no column
 * for it) and is NEVER returned by any read API (§23.2). This module is the
 * single place that knows how to fetch/persist/clear it.
 *
 * `~/.pi/hub/` is owned by Pi Hub (AGENTS.local.md §8) — never `~/.pi-web/`.
 */

import { chmodSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getHubHome } from "./telegram-paths";
import { TELEGRAM_BOT_TOKEN_ENV } from "./telegram-config";

/** Where the token source came from. `null` = not configured. */
export type TelegramTokenSource = "environment" | "local" | null;

export interface ResolvedToken {
  token: string;
  source: TelegramTokenSource;
}

const SECRETS_FILE_MODE = 0o600;

interface SecretsFileShape {
  telegram?: {
    botToken?: string;
  };
}

export function getSecretsPath(): string {
  return join(getHubHome(), "secrets.json");
}

/**
 * Resolves the active token following the priority order. Environment wins
 * and is read-only from this module's perspective (Web cannot mutate it).
 */
export function resolveToken(): ResolvedToken {
  const env = process.env[TELEGRAM_BOT_TOKEN_ENV];
  if (env && env.trim()) {
    return { token: env.trim(), source: "environment" };
  }
  const local = readLocalToken();
  if (local) return { token: local, source: "local" };
  return { token: "", source: null };
}

/** Reads only the source (no token) — safe for status endpoints. */
export function resolveTokenSource(): TelegramTokenSource {
  return resolveToken().source;
}

/** True when the token is managed by the environment variable. */
export function isTokenManagedByEnv(): boolean {
  return resolveTokenSource() === "environment";
}

/**
 * Persists the token to `secrets.json` (0600). Throws if the env var is set —
 * the Web UI must not be able to overwrite an env-managed token
 * (§10.3, §23.2 → `TELEGRAM_TOKEN_MANAGED_BY_ENV`).
 */
export function saveLocalToken(token: string): void {
  if (isTokenManagedByEnv()) {
    throw new Error("TELEGRAM_TOKEN_MANAGED_BY_ENV: token is managed by environment");
  }
  const trimmed = (token ?? "").trim();
  if (!trimmed) {
    throw new Error("VALIDATION_ERROR: token must not be empty");
  }
  const path = getSecretsPath();
  const data = readSecretsFile();
  data.telegram = { ...(data.telegram ?? {}), botToken: trimmed };
  writeSecretsFile(path, data);
}

/** Removes the token from `secrets.json`. No-op if env-managed. */
export function clearLocalToken(): void {
  if (isTokenManagedByEnv()) return;
  const path = getSecretsPath();
  if (!existsSync(path)) return;
  const data = readSecretsFile();
  if (data.telegram?.botToken) {
    delete data.telegram.botToken;
    if (Object.keys(data.telegram).length === 0) delete data.telegram;
    writeSecretsFile(path, data);
  }
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function readLocalToken(): string | null {
  const path = getSecretsPath();
  if (!existsSync(path)) return null;
  try {
    const data = readSecretsFile();
    const tok = data.telegram?.botToken;
    return tok && tok.trim() ? tok.trim() : null;
  } catch {
    return null;
  }
}

function readSecretsFile(): SecretsFileShape {
  const path = getSecretsPath();
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, "utf8");
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw) as SecretsFileShape;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeSecretsFile(path: string, data: SecretsFileShape): void {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", {
    encoding: "utf8",
    mode: SECRETS_FILE_MODE,
  });
  // Re-assert mode in case the file pre-existed with looser permissions.
  try {
    chmodSync(path, SECRETS_FILE_MODE);
  } catch {
    // best-effort
  }
}
