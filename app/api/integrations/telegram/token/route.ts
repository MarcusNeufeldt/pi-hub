import { NextResponse } from "next/server";

import {
  saveLocalToken,
  clearLocalToken,
  isTokenManagedByEnv,
  TelegramErrorCode,
  TelegramError,
} from "@/modules/telegram";
import { getTelegramRuntime } from "@/modules/telegram";

/**
 * Bot Token write/delete (design doc §21.3). The token is write-only from the
 * API — there is no GET. Env-managed tokens reject mutations with 409.
 *
 * Saving/clearing triggers a runtime restart so polling reflects the change.
 */
export const dynamic = "force-dynamic";

interface PutBody {
  token?: unknown;
}

export async function PUT(req: Request) {
  try {
    if (isTokenManagedByEnv()) {
      return NextResponse.json(
        {
          error: "Bot token is managed by the PI_HUB_TELEGRAM_BOT_TOKEN environment variable",
          code: TelegramErrorCode.TELEGRAM_TOKEN_MANAGED_BY_ENV,
        },
        { status: 409 },
      );
    }
    const body = (await req.json().catch(() => ({}))) as PutBody;
    const token = typeof body.token === "string" ? body.token.trim() : "";
    if (!token) {
      return NextResponse.json(
        { error: "token is required", code: "VALIDATION_ERROR" },
        { status: 400 },
      );
    }
    saveLocalToken(token);
    const runtime = getTelegramRuntime();
    void runtime?.restart();
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof TelegramError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.httpStatus },
      );
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    if (isTokenManagedByEnv()) {
      return NextResponse.json(
        {
          error: "Bot token is managed by the PI_HUB_TELEGRAM_BOT_TOKEN environment variable",
          code: TelegramErrorCode.TELEGRAM_TOKEN_MANAGED_BY_ENV,
        },
        { status: 409 },
      );
    }
    clearLocalToken();
    const runtime = getTelegramRuntime();
    void runtime?.restart();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
