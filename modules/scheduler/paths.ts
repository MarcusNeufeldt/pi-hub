/**
 * Pi Hub scheduler data-path resolution.
 *
 * All Pi Hub automation state lives under `${PI_HUB_HOME:-~/.pi/hub}`.
 * This is deliberately separate from upstream pi-web / Pi agent data
 * (`~/.pi/agent`), per AGENTS.local.md §8 — we must never write Pi Hub
 * state under `~/.pi-web/` or modify Pi's own data layout.
 */

import { homedir } from "os";
import { join } from "path";
import { mkdirSync } from "fs";

/** Root directory for Pi Hub data. Honors the `PI_HUB_HOME` override. */
export function getHubHome(): string {
  const override = process.env.PI_HUB_HOME;
  if (override && override.trim()) return override;
  return join(homedir(), ".pi", "hub");
}

/** SQLite database path for the scheduler. */
export function getDbPath(): string {
  return join(getHubHome(), "app.db");
}

/** Logs directory (reserved for future structured logs). */
export function getLogsDir(): string {
  return join(getHubHome(), "logs");
}

/**
 * Ensures the Pi Hub home directory exists. Idempotent.
 * Called once at scheduler startup before opening the database.
 */
export function ensureHubHome(): string {
  const home = getHubHome();
  mkdirSync(home, { recursive: true });
  return home;
}

/**
 * Display-friendly database path for status endpoints. Replaces the home
 * directory prefix with `~` so absolute user paths are not leaked verbatim
 * (purely cosmetic; not a security boundary).
 */
export function getDbPathDisplay(): string {
  return getDbPath().replace(homedir(), "~");
}
