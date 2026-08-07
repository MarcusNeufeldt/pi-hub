import { NextResponse } from "next/server";

import { issuePairingCode, TelegramRole } from "@/modules/telegram";
import { getStoreOrError, telegramErrorResponse } from "@/lib/telegram-dto";

/**
 * Issue a one-time pairing code (design doc §21.5). The plaintext code is
 * returned exactly once; only its hash is persisted. Default role is
 * `operator` unless the first user is being onboarded (owner) or the caller
 * explicitly requests a role.
 */
export const dynamic = "force-dynamic";

const VALID_ROLES = new Set<TelegramRole>(["owner", "operator", "viewer"]);

interface CreateBody {
  role?: unknown;
  expiresInSeconds?: unknown;
}

export async function POST(req: Request) {
  try {
    const access = getStoreOrError();
    if (!access.ok) return access.response;
    const store = access.store;

    const body = (await req.json().catch(() => ({}))) as CreateBody;

    // First user bootstraps as owner regardless of requested role (§9.2).
    const isFirst = store.userCount() === 0;
    const role: TelegramRole = isFirst
      ? "owner"
      : typeof body.role === "string" && VALID_ROLES.has(body.role as TelegramRole)
        ? (body.role as TelegramRole)
        : "operator";

    let ttlMs = 10 * 60 * 1000;
    if (
      typeof body.expiresInSeconds === "number" &&
      Number.isFinite(body.expiresInSeconds) &&
      body.expiresInSeconds >= 30 &&
      body.expiresInSeconds <= 3600
    ) {
      ttlMs = body.expiresInSeconds * 1000;
    }

    const issued = issuePairingCode(store, role, ttlMs);
    return NextResponse.json(
      {
        code: issued.plaintext,
        role: issued.role,
        expiresAt: new Date(issued.expiresAt).toISOString(),
        isFirstUser: isFirst,
      },
      { status: 201 },
    );
  } catch (error) {
    return telegramErrorResponse(error);
  }
}
