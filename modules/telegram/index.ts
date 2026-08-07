/**
 * Public entrypoint for the Pi Hub Telegram module.
 *
 * Importers (instrumentation.ts, API routes, tests) go through here so the
 * internal file layout can evolve without churning call sites. Mirrors the
 * scheduler module's `index.ts` (AGENTS.local.md §3 — keep the domain boundary
 * clear).
 */

export {
  startTelegramRuntime,
  getTelegramRuntime,
  TelegramRuntime,
  type UpdateHandler,
  type RuntimeDeps,
} from "./telegram-runtime";

export { SqliteTelegramStore } from "./sqlite-telegram-store";
export { createDispatcher, issuePairingCode } from "./telegram-dispatcher";
export { OutboxWriter, OutboxWorker } from "./telegram-outbox";
export type { OutboxMessagePayload, InlineKeyboardRows, OutboxWorkerOptions, TerminalEntry } from "./telegram-outbox";
export { ActionService, ACTION_TTL_MS } from "./telegram-actions";
export type { ActionCreateInput, ResolvedAction, ConsumeResult } from "./telegram-actions";
export { TelegramTaskNotifier } from "./telegram-task-notifier";
export type { TelegramTaskNotifierOptions, StoreResolver } from "./telegram-task-notifier";
export { notifyManualRun } from "./telegram-manual-run-notifier";
export type { ManualRunNotifyInput, ManualRunNotifyResult } from "./telegram-manual-run-notifier";
export { esc as escapeTelegramHtml, fmtTime as formatTelegramTime, fmtDuration as formatTelegramDuration } from "./telegram-format";
export { routeCallbackQuery } from "./telegram-callback-router";
export type { CallbackDeps, CallbackInput, CallbackResult, SchedulerServiceResolver } from "./telegram-callback-router";
export { markdownToTelegramHtml, chunkPlainText } from "./telegram-html";
export type { ConvertedMessage, ConversionResult } from "./telegram-html";
export { TelegramStreamRenderer } from "./telegram-stream-renderer";
export type { RendererDeps } from "./telegram-stream-renderer";
export { TelegramConversationService, ConversationBusyError, sessionLabel } from "./telegram-conversation-service";
export type { EnsureConversationInput } from "./telegram-conversation-service";
export { TelegramPromptRunner, extractAssistantText } from "./telegram-prompt-runner";
export type { PromptRunnerDeps, RunPromptInput, RunResult, SessionOpener } from "./telegram-prompt-runner";
export {
  readTelePiConfig,
  previewTelePiImport,
  applyTelePiImport,
  defaultTelePiConfigPath,
} from "./telegram-telepi-import";
export type { TelePiConfig, ImportPreview, ApplyResult } from "./telegram-telepi-import";

// Config / pure helpers
export {
  DEFAULT_TELEGRAM_API_ROOT,
  normalizeApiRoot,
  isOfficialApiRoot,
  buildFileApiRoot,
  buildTelegramFileUrl,
  coerceBotApiConfig,
  normalizeLocalFileRoot,
  maskToken,
  scrubToken,
} from "./telegram-config";

export {
  resolveToken,
  resolveTokenSource,
  isTokenManagedByEnv,
  saveLocalToken,
  clearLocalToken,
  getSecretsPath,
} from "./telegram-secret-store";

export {
  resolveLocalFile,
  buildHttpFileUrl,
  shouldFetchOverHttp,
  DEFAULT_MAX_ATTACHMENT_BYTES,
} from "./telegram-files";

export {
  generatePairingCode,
  hashPairingCode,
  verifyPairingCode,
  PAIRING_CODE_TTL_MS,
} from "./telegram-pairing";

export {
  createBot,
  createApi,
  toBotIdentity,
  isValidBotTokenShape,
  classifyGrammyError,
  type BotIdentity,
} from "./telegram-bot-client";

export {
  TelegramTransport,
  toCallbackData,
  parseCallbackData,
} from "./telegram-transport";

export {
  logOutFromEndpoint,
  migrateToSelfHosted,
} from "./telegram-bot-api-migration";

export { authorize, RateLimiter, conversationKey } from "./telegram-auth";
export { strings, resolveLocale, commandList } from "./telegram-i18n";

export { TelegramError, TelegramErrorCode, telegramValidationError } from "./errors";

export {
  getHubHome,
  getDbPath,
  getDbPathDisplay,
  ensureHubHome,
} from "./telegram-paths";

export type {
  TelegramSettings,
  TelegramUser,
  TelegramChat,
  TelegramConversation,
  TelegramConversation as Conversation,
  TelegramPairingCode,
  TelegramAction,
  TelegramNotificationOutboxEntry,
  TelegramTaskSubscription,
  TelegramRuntimeLease,
  TelegramRuntimeInfo,
  TelegramRuntimeStatus,
  TelegramTokenSource,
  TelegramBotApiConfig,
  BotApiMode,
  TelegramRole,
  ToolVerbosity,
  ConversationState,
  OutboxStatus,
} from "./types";

export type {
  TelegramStore,
  SettingsUpdate,
  UpsertUserInput,
  UpsertChatInput,
  UpsertConversationInput,
  ConversationUpdate,
  CreatePairingCodeInput,
  CreateActionInput,
  CreateOutboxInput,
  OutboxUpdate,
} from "./telegram-store";
