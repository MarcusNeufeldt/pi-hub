import { randomUUID } from "crypto";
import { renameSync, unlinkSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";

/**
 * Renaming over an existing file fails on Windows whenever anything else holds a
 * handle to the target - an editor, a backup agent, Defender mid-scan - and the
 * failure is transient. One immediate attempt therefore turns an ordinary lock
 * into a failed request.
 *
 * Deliberately short and awaited rather than the nine-step ~7.9s ladder
 * pi-subagents uses: these callers are HTTP handlers, and a synchronous park on
 * the server's only thread stalls every other request behind it. That exact
 * pattern is what made this server unresponsive for ~8s at a time.
 */
const RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100, 200] as const;
const RETRYABLE_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);

function isRetryable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && RETRYABLE_CODES.has(code);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Replace a file atomically without exposing credentials through default
 * process permissions. The caller must create the parent directory first.
 */
export async function writePrivateFileAtomic(path: string, contents: string): Promise<void> {
  const dir = dirname(path);
  const tempPath = join(dir, `.${basename(path)}-${randomUUID()}.tmp`);
  let operationFailed = false;

  try {
    writeFileSync(tempPath, contents, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
      flush: true,
    });
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(tempPath, path);
        break;
      } catch (error) {
        const delayMs = RENAME_RETRY_DELAYS_MS[attempt];
        if (delayMs === undefined || !isRetryable(error)) throw error;
        await sleep(delayMs);
      }
    }
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    try {
      unlinkSync(tempPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !operationFailed) {
        throw error;
      }
    }
  }
}
