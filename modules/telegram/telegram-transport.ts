/**
 * TelegramTransport — send/edit/callback/chat-action primitives.
 *
 * All network calls go through one configured Grammy `Api` so every request
 * uses the same `apiRoot` (no `api.telegram.org` hard-coding, open-source
 * Bot API Server design §5). Token is held internally and never logged; error
 * paths run through `classifyGrammyError` which scrubs it.
 */

import type { Api } from "grammy";
import { TelegramError, TelegramErrorCode } from "./errors";
import { classifyGrammyError } from "./telegram-bot-client";

/** Chat action strings Telegram accepts. */
export type ChatAction =
  | "typing"
  | "upload_photo"
  | "record_video"
  | "upload_video"
  | "record_voice"
  | "upload_voice"
  | "upload_document"
  | "find_location"
  | "record_video_note"
  | "upload_video_note";

export interface SendMessageInput {
  chatId: number;
  threadId?: number;
  text: string;
  parseMode?: "HTML" | "MarkdownV2" | undefined;
  replyToMessageId?: number;
  disablePreview?: boolean;
  /** Inline keyboard rows; each cell is `[text, callbackData]`. */
  inlineKeyboard?: ReadonlyArray<ReadonlyArray<{ text: string; callbackData: string }>>;
}

export interface SentMessage {
  messageId: number;
  chatId: number;
  date: number;
}

export interface EditMessageInput {
  chatId: number;
  messageId: number;
  text: string;
  parseMode?: "HTML" | "MarkdownV2" | undefined;
  inlineKeyboard?: SendMessageInput["inlineKeyboard"];
}

export interface TransportOptions {
  api: Api;
  token: string;
}

/**
 * Thin wrapper that owns the Grammy `Api` and converts Telegram errors into
 * `TelegramError` (with token scrubbed). Stateless beyond the held `Api`.
 */
export class TelegramTransport {
  private readonly api: Api;
  private readonly token: string;
  /** Timestamp of the last successful send — surfaced in runtime status (§25). */
  lastSuccessfulSendAt: number | null = null;

  constructor(options: TransportOptions) {
    this.api = options.api;
    this.token = options.token;
  }

  async sendMessage(input: SendMessageInput): Promise<SentMessage> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = (await (this.api as any).sendMessage(input.chatId, input.text, {
        ...(input.threadId ? { message_thread_id: input.threadId } : {}),
        ...(input.parseMode ? { parse_mode: input.parseMode } : {}),
        ...(input.replyToMessageId
          ? { reply_to_message_id: input.replyToMessageId }
          : {}),
        ...(input.disablePreview ? { link_preview_options: { is_disabled: true } } : {}),
        ...(input.inlineKeyboard
          ? { reply_markup: { inline_keyboard: toInlineKeyboard(input.inlineKeyboard) } }
          : {}),
      })) as { message_id: number; chat: { id: number }; date: number };
      this.lastSuccessfulSendAt = Date.now();
      return {
        messageId: res.message_id,
        chatId: res.chat.id,
        date: res.date,
      };
    } catch (error) {
      throw classifyGrammyError(error, this.token);
    }
  }

  async editMessageText(input: EditMessageInput): Promise<boolean> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (this.api as any).editMessageText(input.chatId, input.messageId, input.text, {
        ...(input.parseMode ? { parse_mode: input.parseMode } : {}),
        ...(input.inlineKeyboard
          ? { reply_markup: { inline_keyboard: toInlineKeyboard(input.inlineKeyboard) } }
          : {}),
      });
      this.lastSuccessfulSendAt = Date.now();
      return true;
    } catch (error) {
      // "message is not modified" is benign for debounced streaming edits.
      const msg = error instanceof Error ? error.message : String(error);
      if (/not modified/i.test(msg)) return false;
      throw classifyGrammyError(error, this.token);
    }
  }

  async editMessageReplyMarkup(
    chatId: number,
    messageId: number,
    inlineKeyboard: SendMessageInput["inlineKeyboard"],
  ): Promise<boolean> {
    if (!inlineKeyboard) {
      // Empty keyboard = remove buttons.
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (this.api as any).editMessageReplyMarkup(chatId, messageId, {
          reply_markup: { inline_keyboard: [] },
        });
        return true;
      } catch (error) {
        throw classifyGrammyError(error, this.token);
      }
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (this.api as any).editMessageReplyMarkup(chatId, messageId, {
        reply_markup: { inline_keyboard: toInlineKeyboard(inlineKeyboard) },
      });
      this.lastSuccessfulSendAt = Date.now();
      return true;
    } catch (error) {
      throw classifyGrammyError(error, this.token);
    }
  }

  async deleteMessage(chatId: number, messageId: number): Promise<boolean> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (this.api as any).deleteMessage(chatId, messageId);
      return true;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (/message to delete not found/i.test(msg)) return false;
      throw classifyGrammyError(error, this.token);
    }
  }

  async sendChatAction(chatId: number, action: ChatAction, threadId?: number): Promise<void> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (this.api as any).sendChatAction(chatId, action, {
        ...(threadId ? { message_thread_id: threadId } : {}),
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // Chat action failures are not fatal — ignore network blips.
      if (/chat not found|forbidden|bad request/i.test(msg)) return;
      throw classifyGrammyError(error, this.token);
    }
  }

  async answerCallbackQuery(
    callbackQueryId: string,
    text?: string,
    showAlert?: boolean,
  ): Promise<void> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (this.api as any).answerCallbackQuery(callbackQueryId, {
        ...(text ? { text } : {}),
        ...(showAlert ? { show_alert: true } : {}),
      });
    } catch (error) {
      throw classifyGrammyError(error, this.token);
    }
  }

  /** Sets the bot's command list (used for localized menus, §14.4). */
  async setMyCommands(
    commands: ReadonlyArray<{ command: string; description: string }>,
    options?: { languageCode?: string; scope?: string },
  ): Promise<void> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (this.api as any).setMyCommands(commands as never, {
        ...(options?.languageCode ? { language_code: options.languageCode } : {}),
        ...(options?.scope ? { scope: JSON.parse(options.scope) } : {}),
      });
    } catch (error) {
      throw classifyGrammyError(error, this.token);
    }
  }
}

/** Converts our keyboard shape into Grammy's `InlineKeyboardMarkup`. */
function toInlineKeyboard(
  rows: NonNullable<SendMessageInput["inlineKeyboard"]>,
): { text: string; callback_data: string }[][] {
  return rows.map((row) =>
    row.map((cell) => ({ text: cell.text, callback_data: cell.callbackData })),
  );
}

/** Convenience: builds a single callback_data string `a:<token>`. */
export function toCallbackData(token: string): string {
  return `a:${token}`;
}

/** Parses a callback_data string back into the action token (or null). */
export function parseCallbackData(data: string | undefined): string | null {
  if (!data || !data.startsWith("a:")) return null;
  return data.slice(2);
}

/** Guards that a callback_data payload stays under Telegram's 64-byte limit. */
export function assertCallbackDataLength(data: string): void {
  if (data.length > 64) {
    throw new TelegramError(
      TelegramErrorCode.VALIDATION_ERROR,
      "callback_data exceeds the 64-byte Telegram limit",
    );
  }
}
