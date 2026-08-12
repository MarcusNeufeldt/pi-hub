import { NextResponse } from "next/server";
import { destroyRpcSession, getRpcSession } from "@/lib/rpc-manager";

/**
 * POST /api/sessions/[id]/reset — force-drop a session's live agent process.
 *
 * The escape hatch for a wedged turn. `{ type: "abort" }` asks the run loop to
 * cancel itself and waits for an acknowledgement, so when the run loop is the
 * thing that is stuck, abort hangs too and there is nothing left to try short of
 * restarting the whole server — which drops every other session with it.
 *
 * This does not negotiate: it destroys the wrapper synchronously. The transcript
 * is already on disk, so the next request for this id starts a fresh session from
 * it and the only thing lost is the turn that had stopped progressing.
 *
 * Not wired to a keystroke on purpose — it belongs behind a deliberate click,
 * because a healthy long-running turn looks the same from here as a wedged one.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const existing = getRpcSession(id);
    if (!existing) {
      // Nothing live to reset. Not an error: the caller's goal — no stuck agent
      // for this session — already holds.
      return NextResponse.json({ reset: false, reason: "no_live_session" });
    }

    const wasRunning = existing.isRunning();
    const reset = destroyRpcSession(id);
    return NextResponse.json({ reset, wasRunning });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
