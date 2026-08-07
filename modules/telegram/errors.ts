/**
 * Pi Hub Telegram error model.
 *
 * A single `TelegramError` carries a stable string `code` (design docs §24
 * and open-source-bot-api-server-design.zh-CN.md §17) plus an HTTP status
 * used by route handlers. Mirrors the scheduler error pattern
 * (`modules/scheduler/errors.ts`) so the two Pi Hub domains stay consistent.
 */

export const TelegramErrorCode = {
  // Integration / config
  TELEGRAM_DISABLED: "TELEGRAM_DISABLED",
  TELEGRAM_TOKEN_MISSING: "TELEGRAM_TOKEN_MISSING",
  TELEGRAM_TOKEN_INVALID: "TELEGRAM_TOKEN_INVALID",
  TELEGRAM_TOKEN_IN_USE: "TELEGRAM_TOKEN_IN_USE",
  TELEGRAM_TOKEN_MANAGED_BY_ENV: "TELEGRAM_TOKEN_MANAGED_BY_ENV",

  // Auth / pairing
  TELEGRAM_USER_NOT_ALLOWED: "TELEGRAM_USER_NOT_ALLOWED",
  TELEGRAM_CHAT_NOT_ALLOWED: "TELEGRAM_CHAT_NOT_ALLOWED",
  TELEGRAM_PRIVATE_ONLY: "TELEGRAM_PRIVATE_ONLY",
  TELEGRAM_PAIRING_INVALID: "TELEGRAM_PAIRING_INVALID",
  TELEGRAM_PAIRING_EXPIRED: "TELEGRAM_PAIRING_EXPIRED",
  TELEGRAM_RATE_LIMITED: "TELEGRAM_RATE_LIMITED",

  // Messaging / callbacks
  TELEGRAM_CALLBACK_EXPIRED: "TELEGRAM_CALLBACK_EXPIRED",
  TELEGRAM_SEND_FAILED: "TELEGRAM_SEND_FAILED",

  // Attachments / voice
  TELEGRAM_FILE_TOO_LARGE: "TELEGRAM_FILE_TOO_LARGE",
  TELEGRAM_UNSUPPORTED_ATTACHMENT: "TELEGRAM_UNSUPPORTED_ATTACHMENT",
  TELEGRAM_TRANSCRIPTION_UNAVAILABLE: "TELEGRAM_TRANSCRIPTION_UNAVAILABLE",
  TELEGRAM_TRANSCRIPTION_FAILED: "TELEGRAM_TRANSCRIPTION_FAILED",
  TELEGRAM_DIALOG_TIMEOUT: "TELEGRAM_DIALOG_TIMEOUT",

  // Conversation / sessions
  TELEGRAM_CONVERSATION_BUSY: "TELEGRAM_CONVERSATION_BUSY",
  TELEGRAM_SESSION_NOT_FOUND: "TELEGRAM_SESSION_NOT_FOUND",
  TELEGRAM_WORKSPACE_NOT_ALLOWED: "TELEGRAM_WORKSPACE_NOT_ALLOWED",
  TELEGRAM_PROJECT_NOT_TRUSTED: "TELEGRAM_PROJECT_NOT_TRUSTED",

  // Runtime
  TELEGRAM_RUNTIME_NOT_LEADER: "TELEGRAM_RUNTIME_NOT_LEADER",
  TELEGRAM_IMPORT_CONFLICT: "TELEGRAM_IMPORT_CONFLICT",

  // Bot API Server (open-source bot-api-server design §17)
  TELEGRAM_API_ROOT_INVALID: "TELEGRAM_API_ROOT_INVALID",
  TELEGRAM_API_ROOT_UNREACHABLE: "TELEGRAM_API_ROOT_UNREACHABLE",
  TELEGRAM_API_ROOT_AUTH_FAILED: "TELEGRAM_API_ROOT_AUTH_FAILED",
  TELEGRAM_API_ROOT_RESPONSE_INVALID: "TELEGRAM_API_ROOT_RESPONSE_INVALID",
  TELEGRAM_BOT_API_MIGRATION_REQUIRED: "TELEGRAM_BOT_API_MIGRATION_REQUIRED",
  TELEGRAM_BOT_API_LOGOUT_FAILED: "TELEGRAM_BOT_API_LOGOUT_FAILED",
  TELEGRAM_LOCAL_FILE_UNAVAILABLE: "TELEGRAM_LOCAL_FILE_UNAVAILABLE",
  TELEGRAM_LOCAL_FILE_OUTSIDE_ROOT: "TELEGRAM_LOCAL_FILE_OUTSIDE_ROOT",
  TELEGRAM_TLS_ERROR: "TELEGRAM_TLS_ERROR",

  // Shared agent execution coordination
  AGENT_SESSION_BUSY: "AGENT_SESSION_BUSY",
  AGENT_RUN_OWNED_BY_OTHER_CLIENT: "AGENT_RUN_OWNED_BY_OTHER_CLIENT",

  // Generic
  TELEGRAM_UNAVAILABLE: "TELEGRAM_UNAVAILABLE",
  VALIDATION_ERROR: "VALIDATION_ERROR",
} as const;

export type TelegramErrorCodeValue =
  (typeof TelegramErrorCode)[keyof typeof TelegramErrorCode];

/** Default HTTP status per error code. */
const STATUS_BY_CODE: Record<TelegramErrorCodeValue, number> = {
  [TelegramErrorCode.TELEGRAM_DISABLED]: 409,
  [TelegramErrorCode.TELEGRAM_TOKEN_MISSING]: 409,
  [TelegramErrorCode.TELEGRAM_TOKEN_INVALID]: 400,
  [TelegramErrorCode.TELEGRAM_TOKEN_IN_USE]: 409,
  [TelegramErrorCode.TELEGRAM_TOKEN_MANAGED_BY_ENV]: 409,

  [TelegramErrorCode.TELEGRAM_USER_NOT_ALLOWED]: 403,
  [TelegramErrorCode.TELEGRAM_CHAT_NOT_ALLOWED]: 403,
  [TelegramErrorCode.TELEGRAM_PRIVATE_ONLY]: 403,
  [TelegramErrorCode.TELEGRAM_PAIRING_INVALID]: 400,
  [TelegramErrorCode.TELEGRAM_PAIRING_EXPIRED]: 400,
  [TelegramErrorCode.TELEGRAM_RATE_LIMITED]: 429,

  [TelegramErrorCode.TELEGRAM_CALLBACK_EXPIRED]: 410,
  [TelegramErrorCode.TELEGRAM_SEND_FAILED]: 502,

  [TelegramErrorCode.TELEGRAM_FILE_TOO_LARGE]: 413,
  [TelegramErrorCode.TELEGRAM_UNSUPPORTED_ATTACHMENT]: 415,
  [TelegramErrorCode.TELEGRAM_TRANSCRIPTION_UNAVAILABLE]: 501,
  [TelegramErrorCode.TELEGRAM_TRANSCRIPTION_FAILED]: 502,
  [TelegramErrorCode.TELEGRAM_DIALOG_TIMEOUT]: 408,

  [TelegramErrorCode.TELEGRAM_CONVERSATION_BUSY]: 409,
  [TelegramErrorCode.TELEGRAM_SESSION_NOT_FOUND]: 404,
  [TelegramErrorCode.TELEGRAM_WORKSPACE_NOT_ALLOWED]: 403,
  [TelegramErrorCode.TELEGRAM_PROJECT_NOT_TRUSTED]: 403,

  [TelegramErrorCode.TELEGRAM_RUNTIME_NOT_LEADER]: 503,
  [TelegramErrorCode.TELEGRAM_IMPORT_CONFLICT]: 409,

  [TelegramErrorCode.TELEGRAM_API_ROOT_INVALID]: 400,
  [TelegramErrorCode.TELEGRAM_API_ROOT_UNREACHABLE]: 502,
  [TelegramErrorCode.TELEGRAM_API_ROOT_AUTH_FAILED]: 401,
  [TelegramErrorCode.TELEGRAM_API_ROOT_RESPONSE_INVALID]: 502,
  [TelegramErrorCode.TELEGRAM_BOT_API_MIGRATION_REQUIRED]: 409,
  [TelegramErrorCode.TELEGRAM_BOT_API_LOGOUT_FAILED]: 502,
  [TelegramErrorCode.TELEGRAM_LOCAL_FILE_UNAVAILABLE]: 404,
  [TelegramErrorCode.TELEGRAM_LOCAL_FILE_OUTSIDE_ROOT]: 403,
  [TelegramErrorCode.TELEGRAM_TLS_ERROR]: 502,

  [TelegramErrorCode.AGENT_SESSION_BUSY]: 409,
  [TelegramErrorCode.AGENT_RUN_OWNED_BY_OTHER_CLIENT]: 409,

  [TelegramErrorCode.TELEGRAM_UNAVAILABLE]: 503,
  [TelegramErrorCode.VALIDATION_ERROR]: 400,
};

export class TelegramError extends Error {
  readonly code: TelegramErrorCodeValue;
  readonly httpStatus: number;

  constructor(
    code: TelegramErrorCodeValue,
    message?: string,
    { httpStatus }: { httpStatus?: number } = {},
  ) {
    super(message ?? code);
    this.name = "TelegramError";
    this.code = code;
    this.httpStatus = httpStatus ?? STATUS_BY_CODE[code] ?? 500;
  }

  /** True when this error code maps to a client-side problem (4xx). */
  isClientError(): boolean {
    return this.httpStatus >= 400 && this.httpStatus < 500;
  }
}

/** Convenience factory for validation failures (HTTP 400). */
export function telegramValidationError(message: string): TelegramError {
  return new TelegramError(TelegramErrorCode.VALIDATION_ERROR, message);
}
