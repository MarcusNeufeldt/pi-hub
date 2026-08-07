import { NextResponse } from "next/server";

import {
  getTelegramRuntime,
  readTelePiConfig,
  previewTelePiImport,
  applyTelePiImport,
  defaultTelePiConfigPath,
  isTokenManagedByEnv,
  type TelePiConfig,
} from "@/modules/telegram";
import { getStoreOrError, telegramErrorResponse } from "@/lib/telegram-dto";

/**
 * TelePi → Pi Hub migration (design §22, API §21.8).
 *
 *   POST { dryRun: true }  → non-mutating preview of what would be imported;
 *   POST { confirm: true } → applies the import (users + settings + token).
 *
 * Guarantees:
 *   - never deletes the TelePi config (§22.5 rollback);
 *   - never overwrites an env-managed token (§10.3 / §22.1);
 *   - the bot token is never echoed in the response.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const storeResult = getStoreOrError();
  if (!storeResult.ok) return storeResult.response;
  const store = storeResult.store;

  let body: { dryRun?: boolean; confirm?: boolean; path?: string };
  try {
    body = (await request.json().catch(() => ({}))) as typeof body;
  } catch {
    body = {};
  }

  const configPath = body.path?.trim() || defaultTelePiConfigPath();
  const config: TelePiConfig = readTelePiConfig(configPath);

  if (!config.present) {
    return NextResponse.json(
      { error: "TelePi config not found", code: "TELEPI_CONFIG_NOT_FOUND", path: configPath },
      { status: 404 },
    );
  }

  const tokenManagedByEnv = isTokenManagedByEnv();

  // Dry-run / preview (default) — never mutates.
  if (!body.confirm) {
    const preview = previewTelePiImport(config, {
      existingUserCount: store.userCount(),
      tokenManagedByEnv,
    });
    return NextResponse.json({ preview, dryRun: true });
  }

  // Apply (confirm: true).
  try {
    const result = applyTelePiImport(store, config, { existingUserCount: store.userCount() });
    // Surface a runtime restart hint so the imported token/bot takes effect.
    return NextResponse.json({ applied: result, restartRecommended: result.setToken });
  } catch (error) {
    return telegramErrorResponse(error);
  }
}

// Unused import guard (kept for clarity of runtime access symmetry).
void getTelegramRuntime;
