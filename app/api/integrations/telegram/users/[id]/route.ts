import { NextResponse } from "next/server";

import { TelegramRole } from "@/modules/telegram";
import {
  getStoreOrError,
  telegramErrorResponse,
  userToDto,
} from "@/lib/telegram-dto";

/**
 * Update or remove a paired Telegram user (design doc §21.6).
 */
export const dynamic = "force-dynamic";

const VALID_ROLES = new Set<TelegramRole>(["owner", "operator", "viewer"]);

interface Params {
  params: Promise<{ id: string }>;
}

function parseUserId(id: string): number | null {
  const n = Number(id);
  return Number.isInteger(n) && n > 0 ? n : null;
}

interface PatchBody {
  role?: unknown;
  enabled?: unknown;
  displayName?: unknown;
}

export async function PATCH(req: Request, { params }: Params) {
  try {
    const access = getStoreOrError();
    if (!access.ok) return access.response;
    const { id } = await params;
    const userId = parseUserId(id);
    if (userId == null) {
      return NextResponse.json(
        { error: "invalid user id", code: "VALIDATION_ERROR" },
        { status: 400 },
      );
    }
    const current = access.store.getUser(userId);
    if (!current) {
      return NextResponse.json(
        { error: "user not found", code: "TELEGRAM_USER_NOT_ALLOWED" },
        { status: 404 },
      );
    }

    const body = (await req.json().catch(() => ({}))) as PatchBody;
    const role =
      typeof body.role === "string" && VALID_ROLES.has(body.role as TelegramRole)
        ? (body.role as TelegramRole)
        : current.role;
    const enabled =
      typeof body.enabled === "boolean" ? body.enabled : current.enabled;
    const displayName =
      typeof body.displayName === "string"
        ? body.displayName.trim() || null
        : current.displayName;

    // Guard against demoting the last owner to a non-owner role (no admin left).
    if (current.role === "owner" && role !== "owner") {
      const owners = access.store
        .listUsers()
        .filter((u) => u.role === "owner" && u.enabled);
      if (owners.length <= 1) {
        return NextResponse.json(
          {
            error: "cannot demote the last enabled owner",
            code: "VALIDATION_ERROR",
          },
          { status: 409 },
        );
      }
    }

    const updated = access.store.updateUser(userId, { role, enabled, displayName });
    return NextResponse.json(userToDto(updated!));
  } catch (error) {
    return telegramErrorResponse(error);
  }
}

export async function DELETE(_req: Request, { params }: Params) {
  try {
    const access = getStoreOrError();
    if (!access.ok) return access.response;
    const { id } = await params;
    const userId = parseUserId(id);
    if (userId == null) {
      return NextResponse.json(
        { error: "invalid user id", code: "VALIDATION_ERROR" },
        { status: 400 },
      );
    }
    const current = access.store.getUser(userId);
    if (!current) {
      return NextResponse.json(
        { error: "user not found", code: "TELEGRAM_USER_NOT_ALLOWED" },
        { status: 404 },
      );
    }
    if (current.role === "owner") {
      const owners = access.store
        .listUsers()
        .filter((u) => u.role === "owner" && u.enabled && u.telegramUserId !== userId);
      if (owners.length === 0) {
        return NextResponse.json(
          {
            error: "cannot delete the last enabled owner",
            code: "VALIDATION_ERROR",
          },
          { status: 409 },
        );
      }
    }
    const deleted = access.store.deleteUser(userId);
    return NextResponse.json({ ok: true, deleted });
  } catch (error) {
    return telegramErrorResponse(error);
  }
}
