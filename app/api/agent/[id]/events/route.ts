import { getRpcSession, subscribeRpcSessionAvailability } from "@/lib/rpc-manager";
import { toClientAgentEvent } from "@/lib/agent-event-wire";

export const dynamic = "force-dynamic";

// GET /api/agent/[id]/events - SSE stream of agent events
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  let cleanup = () => {};

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      let unsubscribe: (() => void) | null = null;
      let unsubscribeAvailability: (() => void) | null = null;
      let unsubscribeDestroy: (() => void) | null = null;
      const encode = (data: unknown) => {
        if (closed) return;
        const text = `data: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(encoder.encode(text));
      };

      const attachSession = () => {
        const attach = (session: NonNullable<ReturnType<typeof getRpcSession>>) => {
          if (closed) return;
          unsubscribe = session.onEvent((event) => {
            const clientEvent = toClientAgentEvent(event);
            if (clientEvent) encode(clientEvent);
          });
          // A destroyed wrapper can no longer deliver events. Close this SSE
          // stream so EventSource reconnects and binds to its replacement.
          unsubscribeDestroy = session.onDestroy(() => cleanup());
        };

        const session = getRpcSession(id);
        if (session?.isAlive()) {
          attach(session);
          return;
        }

        // An idle EventSource is transport only. It waits for POST /api/agent
        // to create the wrapper instead of starting every extension itself.
        unsubscribeAvailability = subscribeRpcSessionAvailability(id, attach);
      };

      // Heartbeat every 30s to prevent server/proxy timeout (Next.js default ~120-150s)
      const heartbeat = setInterval(() => {
        try {
          if (!closed) controller.enqueue(encoder.encode(":\n\n"));
        } catch {
          cleanup();
        }
      }, 30_000);

      cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        req.signal?.removeEventListener("abort", cleanup);
        unsubscribe?.();
        unsubscribeAvailability?.();
        unsubscribeDestroy?.();
        unsubscribe = null;
        unsubscribeAvailability = null;
        unsubscribeDestroy = null;
        try {
          controller.close();
        } catch {
          // controller already closed
        }
      };

      req.signal?.addEventListener("abort", cleanup, { once: true });
      if (req.signal?.aborted) {
        cleanup();
        return;
      }

      // Register the event/availability consumer before declaring application
      // readiness. A prompt may emit its first event immediately after the
      // connected frame, and a destroyed wrapper must close this stream.
      attachSession();
      if (closed) return;

      // Next/proxies may buffer a tiny first SSE frame. A comment prelude over
      // the common 2 KiB threshold forces headers and the connected event out
      // immediately without producing a client-visible message.
      controller.enqueue(encoder.encode(`:${" ".repeat(2048)}\n\n`));
      encode({ type: "connected", sessionId: id });
    },
    cancel() { cleanup(); },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    },
  });
}
