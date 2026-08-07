import { NextResponse } from "next/server";

import { getTelegramRuntime } from "@/modules/telegram";

/**
 * Restart the Telegram Runtime after a config/token change or after resolving
 * a 409 conflict (design doc §7.6 "重新启动"). Idempotent; restarts only this
 * process's instance (V1 is single-process, §7.4).
 */
export const dynamic = "force-dynamic";

export async function POST() {
  const runtime = getTelegramRuntime();
  if (!runtime) {
    return NextResponse.json(
      { error: "Telegram module not started", code: "TELEGRAM_UNAVAILABLE" },
      { status: 503 },
    );
  }
  try {
    await runtime.restart();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500 },
    );
  }
}
