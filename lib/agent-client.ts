// Client-side helper for POST /api/agent/[id].
//
// Every /api/agent/[id] route returns one of:
//   { success: true, data: <result> }
//   { error: string }              (non-2xx)
//
// Call sites previously repeated the same 5-line fetch block 13× in
// hooks/useAgentSession.ts. This helper collapses that down to one line.

/**
 * Thrown when a command exceeds its deadline. Distinguished from a transport error
 * so callers can say "the agent did not answer" rather than "the request failed",
 * which are different problems with different remedies.
 */
export class AgentCommandTimeoutError extends Error {
  constructor(public readonly commandType: string, public readonly timeoutMs: number) {
    super(`The agent did not respond to "${commandType}" within ${Math.round(timeoutMs / 1000)}s.`);
    this.name = "AgentCommandTimeoutError";
  }
}

export async function sendAgentCommand<T = unknown>(
  sessionId: string,
  command: Record<string, unknown>,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  // Commands are served by AgentSessionWrapper.send, which for some types waits on
  // the run loop. A wedged run loop makes that wait unbounded, and without a
  // deadline the fetch never settles — the caller's catch never runs, so the
  // failure is invisible rather than merely unsuccessful.
  const { timeoutMs } = options;
  const controller = timeoutMs ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;

  let res: Response;
  try {
    res = await fetch(`/api/agent/${encodeURIComponent(sessionId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(command),
      signal: controller?.signal,
    });
  } catch (error) {
    if (controller?.signal.aborted) {
      throw new AgentCommandTimeoutError(String(command.type ?? "command"), timeoutMs!);
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
  const body = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    data?: T;
    error?: string;
  };
  if (!res.ok || body.error) {
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return body.data as T;
}
