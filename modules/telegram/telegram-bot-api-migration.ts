/**
 * Telegram Bot API Server migration helpers.
 *
 * Telegram requires a Bot to call `logOut` on its *current* server before it
 * will deliver updates to a different server (open-source Bot API Server
 * design §10, §11). This module performs that explicit, opt-in migration only
 * — it is never invoked by normal polling or connection tests (§16).
 */

import type { Api } from "grammy";
import { TelegramError, TelegramErrorCode } from "./errors";
import { classifyGrammyError } from "./telegram-bot-client";
import { DEFAULT_TELEGRAM_API_ROOT } from "./telegram-config";

export interface MigrationResult {
  /** Whether logOut returned ok on the old endpoint. */
  loggedOut: boolean;
  /** The endpoint logOut was called against. */
  fromApiRoot: string;
}

/**
 * Calls `logOut` on the given apiRoot (defaults to official cloud). Used when
 * moving a Bot from the official cloud (or one self-hosted server) to another
 * self-hosted server. Token is the *same* bot token throughout — Telegram
 * just needs to be told to stop serving it from the old endpoint.
 */
export async function logOutFromEndpoint(
  api: Api,
  token: string,
  fromApiRoot: string = DEFAULT_TELEGRAM_API_ROOT,
): Promise<MigrationResult> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = (await (api as any).logOut()) as { ok?: boolean };
    return { loggedOut: Boolean(res?.ok), fromApiRoot };
  } catch (error) {
    throw classifyGrammyError(error, token);
  }
}

/**
 * Full migration flow (open-source Bot API Server §10.1):
 *   1. logOut on the official endpoint
 *   2. (caller saves the new apiRoot)
 *   3. getMe on the new endpoint to confirm
 *
 * This helper performs step 1 + step 3 against provided pre-configured Api
 * instances; persistence + runtime restart remain the caller's job so the
 * migration stays explicit and reversible on failure.
 */
export async function migrateToSelfHosted(
  args: {
    officialApi: Api;
    newApi: Api;
    token: string;
    officialApiRoot?: string;
  },
): Promise<{ identity: { id: number; username: string }; loggedOut: boolean }> {
  const logout = await logOutFromEndpoint(
    args.officialApi,
    args.token,
    args.officialApiRoot ?? DEFAULT_TELEGRAM_API_ROOT,
  );
  if (!logout.loggedOut) {
    throw new TelegramError(
      TelegramErrorCode.TELEGRAM_BOT_API_LOGOUT_FAILED,
      "logOut did not return ok on the official endpoint",
    );
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const me = (await (args.newApi as any).getMe()) as {
      id: number;
      username?: string;
      is_bot?: boolean;
    };
    if (!me || me.is_bot === false) {
      throw new TelegramError(
        TelegramErrorCode.TELEGRAM_API_ROOT_RESPONSE_INVALID,
        "new endpoint did not return a valid bot identity",
      );
    }
    return {
      identity: { id: me.id, username: me.username ?? "" },
      loggedOut: true,
    };
  } catch (error) {
    if (error instanceof TelegramError) throw error;
    throw classifyGrammyError(error, args.token);
  }
}
