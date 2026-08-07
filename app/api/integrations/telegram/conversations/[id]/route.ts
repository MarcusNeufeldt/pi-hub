import { NextResponse } from "next/server";

import { getStoreOrError, telegramErrorResponse } from "@/lib/telegram-dto";

/**
 * Delete a conversation mapping (design doc §21.7). The Pi Session file is
 * untouched — only the chat/topic → session binding is removed.
 *
 * The `[id]` segment is the composite `chatId::threadId` key.
 */
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

function parseConversationId(id: string): { chatId: number; threadId: number } | null {
  const parts = id.split("::");
  if (parts.length !== 2) return null;
  const chatId = Number(parts[0]);
  const threadId = Number(parts[1]);
  if (!Number.isInteger(chatId) || !Number.isInteger(threadId)) return null;
  return { chatId, threadId };
}

export async function DELETE(_req: Request, { params }: Params) {
  try {
    const access = getStoreOrError();
    if (!access.ok) return access.response;
    const { id } = await params;
    const parsed = parseConversationId(id);
    if (!parsed) {
      return NextResponse.json(
        { error: "invalid conversation id (expected chatId::threadId)", code: "VALIDATION_ERROR" },
        { status: 400 },
      );
    }
    const deleted = access.store.deleteConversation(parsed.chatId, parsed.threadId);
    return NextResponse.json({ ok: true, deleted });
  } catch (error) {
    return telegramErrorResponse(error);
  }
}
