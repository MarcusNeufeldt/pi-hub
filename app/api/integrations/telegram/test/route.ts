import { NextResponse } from "next/server";

import {
  resolveToken,
  resolveLocalFile,
  normalizeApiRoot,
  normalizeLocalFileRoot,
  createApi,
  toBotIdentity,
  classifyGrammyError,
  TelegramError,
  TelegramErrorCode,
} from "@/modules/telegram";
import { getStoreOrError, telegramErrorResponse } from "@/lib/telegram-dto";

/**
 * Connection test (design doc §21.4, open-source Bot API Server §9).
 *
 * Uses the CURRENTLY SAVED token against the provided apiRoot (or the saved
 * one) to call `getMe`. Validates endpoint reachability, HTTP status, response
 * shape, and bot identity. Never returns the token; error messages are
 * scrubbed by `classifyGrammyError`.
 *
 * When `localMode` is true, an optional localFileRoot capability probe runs
 * (path must exist and be readable), but no file upload is required.
 */
export const dynamic = "force-dynamic";

interface TestBody {
  apiRoot?: unknown;
  localMode?: unknown;
  localFileRoot?: unknown;
}

export async function POST(req: Request) {
  try {
    const access = getStoreOrError();
    if (!access.ok) return access.response;

    const resolved = resolveToken();
    if (!resolved.token) {
      return NextResponse.json(
        { error: "No bot token configured", code: TelegramErrorCode.TELEGRAM_TOKEN_MISSING },
        { status: 409 },
      );
    }

    const body = (await req.json().catch(() => ({}))) as TestBody;
    const settings = access.store.getSettings();
    let apiRoot: string;
    try {
      apiRoot =
        typeof body.apiRoot === "string" && body.apiRoot.trim()
          ? normalizeApiRoot(body.apiRoot)
          : settings.botApi.apiRoot;
    } catch (error) {
      if (error instanceof TelegramError) {
        return NextResponse.json(
          { error: error.message, code: error.code },
          { status: error.httpStatus },
        );
      }
      throw error;
    }

    const api = createApi({ token: resolved.token, apiRoot });
    let identity;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const me = (await (api as any).getMe()) as Parameters<typeof toBotIdentity>[0];
      if (!me || me.is_bot === false) {
        throw new TelegramError(
          TelegramErrorCode.TELEGRAM_API_ROOT_RESPONSE_INVALID,
          "endpoint did not return a valid bot identity",
        );
      }
      identity = toBotIdentity(me);
    } catch (error) {
      const e =
        error instanceof TelegramError
          ? error
          : classifyGrammyError(error, resolved.token);
      return NextResponse.json(
        { error: e.message, code: e.code },
        { status: e.httpStatus },
      );
    }

    // Optional local-mode capability probe (open-source Bot API Server §9).
    let localFileOk: boolean | null = null;
    const localMode =
      typeof body.localMode === "boolean" ? body.localMode : settings.botApi.localMode;
    if (localMode) {
      const root =
        typeof body.localFileRoot === "string"
          ? normalizeLocalFileRoot(body.localFileRoot)
          : normalizeLocalFileRoot(settings.botApi.localFileRoot);
      if (!root) {
        return NextResponse.json(
          {
            error: "localMode requires a localFileRoot",
            code: TelegramErrorCode.TELEGRAM_API_ROOT_INVALID,
          },
          { status: 400 },
        );
      }
      try {
        // Write a probe + read it back is overkill for a test; just confirm the
        // directory itself resolves and is accessible.
        resolveLocalFile(root, root);
        localFileOk = true;
      } catch (error) {
        return NextResponse.json(
          {
            error:
              error instanceof Error ? error.message : "localFileRoot not accessible",
            code:
              error instanceof TelegramError
                ? error.code
                : TelegramErrorCode.TELEGRAM_LOCAL_FILE_UNAVAILABLE,
          },
          { status: 400 },
        );
      }
    }

    return NextResponse.json({
      ok: true,
      bot: {
        id: identity.id,
        username: identity.username,
        firstName: identity.firstName,
      },
      apiRoot,
      mode: "Long Polling",
      localMode,
      ...(localFileOk !== null ? { localFileOk } : {}),
    });
  } catch (error) {
    return telegramErrorResponse(error);
  }
}
