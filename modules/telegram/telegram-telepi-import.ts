/**
 * TelePi → Pi Hub migration (design §22).
 *
 * Reads a TelePi `config.env` (dotenv-style) and maps its fields into Pi Hub's
 * Telegram settings + user whitelist. The migration is:
 *   - non-destructive (§22.5: never deletes the TelePi config);
 *   - previewable (§21.8: dry-run returns what would change before writing);
 *   - token-safe: never overwrites a token managed by the environment
 *     (§10.3 / §22.1 — an env-managed token stays authoritative).
 *
 * TelePi sessions live in the same `~/.pi/agent/sessions/` tree, so no session
 * content is migrated — Pi Hub re-scans and shows the existing history (§22.3).
 */

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

import type { TelegramStore } from "./telegram-store";
import type { ToolVerbosity } from "./types";
import { isTokenManagedByEnv, saveLocalToken } from "./telegram-secret-store";
import { isValidBotTokenShape } from "./telegram-bot-client";

/** Default TelePi config location (§22.2). */
export function defaultTelePiConfigPath(): string {
  return join(homedir(), ".config", "telepi", "config.env");
}

export interface TelePiConfig {
  /** Raw bot token (never logged). Null when absent. */
  botToken: string | null;
  /** Numeric Telegram user ids allowed by TelePi. */
  allowedUserIds: number[];
  /** TelePi workspace cwd. */
  workspace: string | null;
  /** TelePi tool verbosity. */
  toolVerbosity: ToolVerbosity | null;
  /** True when the config file was found and parsed. */
  present: boolean;
}

/** Parses a TelePi config.env into a typed view. Returns present:false if missing. */
export function readTelePiConfig(path: string = defaultTelePiConfigPath()): TelePiConfig {
  if (!existsSync(path)) {
    return { botToken: null, allowedUserIds: [], workspace: null, toolVerbosity: null, present: false };
  }
  const text = readFileSync(path, "utf8");
  const map = parseDotenv(text);
  const allowed = (map.TELEGRAM_ALLOWED_USER_IDS ?? "")
    .split(/[\s,]+/)
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  const verbosity = normalizeVerbosity(map.TOOL_VERBOSITY);
  return {
    botToken: map.TELEGRAM_BOT_TOKEN ?? null,
    allowedUserIds: allowed,
    workspace: map.TELEPI_WORKSPACE ?? null,
    toolVerbosity: verbosity,
    present: true,
  };
}

export interface ImportPreview {
  present: boolean;
  hasToken: boolean;
  /** True when a present token looks well-formed. */
  tokenValid: boolean;
  /** True when the token is env-managed and will NOT be overwritten. */
  tokenManagedByEnv: boolean;
  allowedUserIds: number[];
  workspace: string | null;
  toolVerbosity: ToolVerbosity | null;
  /** The role each imported user would get. */
  userRole: "owner" | "operator";
}

/** Builds a non-mutating preview of what an import would change (§21.8). */
export function previewTelePiImport(
  config: TelePiConfig,
  options: { existingUserCount: number; tokenManagedByEnv: boolean },
): ImportPreview {
  const isFirst = options.existingUserCount === 0;
  return {
    present: config.present,
    hasToken: Boolean(config.botToken),
    tokenValid: config.botToken ? isValidBotTokenShape(config.botToken) : false,
    tokenManagedByEnv: options.tokenManagedByEnv,
    allowedUserIds: config.allowedUserIds,
    workspace: config.workspace,
    toolVerbosity: config.toolVerbosity,
    userRole: isFirst && config.allowedUserIds.length > 0 ? "owner" : "operator",
  };
}

export interface ApplyResult {
  importedUsers: number;
  setWorkspace: boolean;
  setVerbosity: boolean;
  setToken: boolean;
  /** Why the token was skipped (env-managed or invalid). */
  tokenSkipped: "env_managed" | "invalid" | "absent" | null;
}

/** Applies a TelePi config to the store + secret store (idempotent). */
export function applyTelePiImport(
  store: TelegramStore,
  config: TelePiConfig,
  options: { existingUserCount: number },
): ApplyResult {
  const result: ApplyResult = {
    importedUsers: 0,
    setWorkspace: false,
    setVerbosity: false,
    setToken: false,
    tokenSkipped: null,
  };

  // Users.
  const isFirst = options.existingUserCount === 0;
  for (let i = 0; i < config.allowedUserIds.length; i++) {
    const userId = config.allowedUserIds[i];
    const role = isFirst && i === 0 ? "owner" : "operator";
    store.upsertUser({ telegramUserId: userId, role, enabled: true });
    result.importedUsers++;
  }

  // Settings (workspace + verbosity only — never secrets in settings).
  const patch: { defaultWorkspace?: string | null; toolVerbosity?: ToolVerbosity } = {};
  if (config.workspace) {
    patch.defaultWorkspace = config.workspace;
    result.setWorkspace = true;
  }
  if (config.toolVerbosity) {
    patch.toolVerbosity = config.toolVerbosity;
    result.setVerbosity = true;
  }
  if (Object.keys(patch).length > 0) {
    store.upsertSettings(patch as never);
  }

  // Token — only when not env-managed and valid.
  if (!config.botToken) {
    result.tokenSkipped = "absent";
  } else if (isTokenManagedByEnv()) {
    result.tokenSkipped = "env_managed";
  } else if (!isValidBotTokenShape(config.botToken)) {
    result.tokenSkipped = "invalid";
  } else {
    saveLocalToken(config.botToken);
    result.setToken = true;
  }

  return result;
}

// ---------------------------------------------------------------------------
// dotenv parser (minimal — TelePi config.env is simple KEY=VALUE)
// ---------------------------------------------------------------------------

function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // strip matching surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

function normalizeVerbosity(value: string | undefined): ToolVerbosity | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (v === "all" || v === "summary" || v === "errors-only" || v === "none") return v;
  return null;
}
