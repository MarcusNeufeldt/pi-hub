/**
 * Pi Hub Telegram data-path resolution.
 *
 * Reuses the scheduler's `getHubHome()` so Telegram state lives alongside
 * scheduler state under `${PI_HUB_HOME:-~/.pi/hub}` (AGENTS.local.md §8). The
 * token lives in `secrets.json` (0600); everything else goes into `app.db`.
 */

export {
  getHubHome,
  getDbPath,
  getLogsDir,
  ensureHubHome,
  getDbPathDisplay,
} from "../scheduler/paths";
