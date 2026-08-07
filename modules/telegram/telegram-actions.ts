/**
 * Telegram Action Tokens — short-lived, single-use callback payloads
 * (design doc §8.7, §18.4/§18.5 inline buttons).
 *
 * Inline-keyboard buttons must carry ≤64-byte `callback_data`, so they cannot
 * embed a full action payload. Instead a button carries `a:<token>` and this
 * service resolves the token to its action (`task_run`, `session_open`, …)
 * plus its bound `userId`/`chatId`, enforcing:
 *   - expiry (short TTL);
 *   - single-use (atomic consume);
 *   - caller identity (the Telegram user pressing the button must match the
 *     token's bound user, or be the Pi Hub owner).
 *
 * Only the leader creates/consumes tokens (it owns the store). HTTP API
 * routes that render buttons (e.g. the notification outbox payload built by
 * `TelegramTaskNotifier`) create tokens through `ActionService`.
 */

import { randomBytes } from "crypto";

import type { TelegramStore } from "./telegram-store";
import type { TelegramActionType } from "./types";

/** How long a token stays valid. Notifications buttons expire with the message usefulness. */
export const ACTION_TTL_MS = 10 * 60 * 1_000; // 10 minutes

export interface ActionCreateInput {
  actionType: TelegramActionType;
  /** JSON-serializable action payload (taskId, sessionId, …). */
  payload: Record<string, unknown>;
  /** Bound caller; null = any authorized user may use it. */
  userId: number | null;
  chatId: number;
  threadId: number;
  ttlMs?: number;
}

export interface ResolvedAction {
  actionType: TelegramActionType;
  payload: Record<string, unknown>;
  userId: number | null;
  chatId: number;
  threadId: number;
}

export interface ConsumeResult {
  ok: boolean;
  action?: ResolvedAction;
  reason?: "not_found" | "expired" | "used" | "forbidden";
}

export class ActionService {
  constructor(private readonly store: TelegramStore) {}

  create(input: ActionCreateInput): { token: string; callbackData: string } {
    const token = newToken();
    const expiresAt = Date.now() + (input.ttlMs ?? ACTION_TTL_MS);
    this.store.createAction({
      token,
      actionType: input.actionType,
      payloadJson: JSON.stringify(input.payload),
      userId: input.userId,
      chatId: input.chatId,
      threadId: input.threadId,
      expiresAt,
    });
    return { token, callbackData: `a:${token}` };
  }

  /**
   * Validates + atomically consumes a token for the given caller. Returns
   * `forbidden` when the caller's Telegram id does not match the token's bound
   * user (and the caller is not a Pi Hub owner — callers may pass
   * `bypassUserCheck` for owner-forced actions).
   */
  consume(
    token: string,
    callerUserId: number,
    options?: { bypassUserCheck?: boolean },
  ): ConsumeResult {
    const now = Date.now();
    const action = this.store.getAction(token);
    if (!action) return { ok: false, reason: "not_found" };
    if (action.usedAt !== null) return { ok: false, reason: "used" };
    if (action.expiresAt < now) return { ok: false, reason: "expired" };
    if (
      !options?.bypassUserCheck &&
      action.userId !== null &&
      action.userId !== callerUserId
    ) {
      return { ok: false, reason: "forbidden" };
    }
    const consumed = this.store.consumeAction(token, now);
    if (!consumed) return { ok: false, reason: "used" };
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(consumed.payloadJson) as Record<string, unknown>;
    } catch {
      // ignore — empty payload
    }
    return {
      ok: true,
      action: {
        actionType: consumed.actionType,
        payload,
        userId: consumed.userId,
        chatId: consumed.chatId,
        threadId: consumed.threadId,
      },
    };
  }

  /** Periodic cleanup of expired tokens. */
  purge(now: number = Date.now()): number {
    return this.store.purgeExpiredActions(now);
  }
}

/** 24 URL-safe chars (~144 bits) — well under the 64-byte callback_data limit. */
function newToken(): string {
  return randomBytes(18).toString("base64url");
}
