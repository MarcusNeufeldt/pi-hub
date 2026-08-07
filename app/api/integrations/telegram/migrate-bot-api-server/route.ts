import { NextResponse } from "next/server";

import {
  resolveToken,
  createApi,
  normalizeApiRoot,
  DEFAULT_TELEGRAM_API_ROOT,
  migrateToSelfHosted,
  TelegramError,
  TelegramErrorCode,
} from "@/modules/telegram";
import { getStoreOrError, telegramErrorResponse } from "@/lib/telegram-dto";

/**
 * Migrate a Bot from the official Telegram cloud (or another self-hosted
 * server) to a self-hosted Bot API Server by calling `logOut` on the *old*
 * endpoint then `getMe` on the new one (open-source Bot API Server §10, §14.3).
 *
 * This is an explicit, Owner-only action — it is never invoked by normal
 * polling or connection tests (§16). On success the new apiRoot is persisted
 * and the runtime restarts against it.
 */
export const dynamic = "force-dynamic";

interface MigrateBody {
  toApiRoot?: unknown;
}

export async function POST(req: Request) {
  try {
    const access = getStoreOrError();
    if (!access.ok) return access.response;
    const store = access.store;

    const resolved = resolveToken();
    if (!resolved.token) {
      return NextResponse.json(
        { error: "No bot token configured", code: TelegramErrorCode.TELEGRAM_TOKEN_MISSING },
        { status: 409 },
      );
    }

    const body = (await req.json().catch(() => ({}))) as MigrateBody;
    if (typeof body.toApiRoot !== "string" || !body.toApiRoot.trim()) {
      return NextResponse.json(
        {
          error: "toApiRoot is required",
          code: TelegramErrorCode.TELEGRAM_API_ROOT_INVALID,
        },
        { status: 400 },
      );
    }

    let newApiRoot: string;
    try {
      newApiRoot = normalizeApiRoot(body.toApiRoot);
    } catch (error) {
      if (error instanceof TelegramError) {
        return NextResponse.json(
          { error: error.message, code: error.code },
          { status: error.httpStatus },
        );
      }
      throw error;
    }
    if (newApiRoot === DEFAULT_TELEGRAM_API_ROOT) {
      return NextResponse.json(
        {
          error: "toApiRoot must be a self-hosted endpoint, not the official cloud",
          code: TelegramErrorCode.TELEGRAM_API_ROOT_INVALID,
        },
        { status: 400 },
      );
    }

    const officialApi = createApi({
      token: resolved.token,
      apiRoot: DEFAULT_TELEGRAM_API_ROOT,
    });
    const newApi = createApi({ token: resolved.token, apiRoot: newApiRoot });

    const result = await migrateToSelfHosted({
      officialApi,
      newApi,
      token: resolved.token,
    });

    // Persist the new apiRoot + switch to self-hosted mode.
    store.upsertSettings({
      botApiMode: "self-hosted",
      apiRoot: newApiRoot,
      botId: result.identity.id,
      botUsername: result.identity.username,
    });

    // Restart against the new endpoint.
    const { getTelegramRuntime } = await import("@/modules/telegram");
    void getTelegramRuntime()?.restart();

    return NextResponse.json({
      ok: true,
      from: DEFAULT_TELEGRAM_API_ROOT,
      to: newApiRoot,
      bot: result.identity,
    });
  } catch (error) {
    return telegramErrorResponse(error);
  }
}
