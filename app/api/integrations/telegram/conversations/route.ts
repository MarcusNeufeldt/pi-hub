import { NextResponse } from "next/server";

import {
  getStoreOrError,
  telegramErrorResponse,
  conversationToDto,
} from "@/lib/telegram-dto";

/**
 * List Telegram conversations (chat + topic → session mappings). Deleting a
 * conversation mapping does NOT delete the underlying Pi Session file
 * (design doc §21.7).
 */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const access = getStoreOrError();
    if (!access.ok) return access.response;
    return NextResponse.json({
      items: access.store.listConversations().map(conversationToDto),
    });
  } catch (error) {
    return telegramErrorResponse(error);
  }
}
