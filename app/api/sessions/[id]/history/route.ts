import { NextResponse } from "next/server";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { buildSessionHistory, resolveSessionPath } from "@/lib/session-reader";

/**
 * GET /api/sessions/[id]/history
 *
 * The messages a compaction dropped from the model's context but not from the
 * session file. Served separately from /api/sessions/[id] on purpose: the main
 * route returns the model context and stays small, while a long session's full
 * history can be the whole file. Fetching it on its own keeps first paint off
 * the critical path.
 *
 * Returns the portion BEFORE the context by default, since the caller already
 * has the context. `?full=1` returns the entire chain for callers that want one
 * consistent array.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const { searchParams } = new URL(req.url);
    const full = searchParams.has("full");
    const deferThinking = searchParams.has("deferThinking");
    const deferToolResultImages = searchParams.has("deferMedia");

    const manager = SessionManager.open(filePath);
    const entries = manager.getEntries() as never;
    // Fall back to the session's own leaf rather than passing null through. The
    // chain walk tolerates a missing leaf, but the SDK's context builder does
    // not resolve one, so the two would disagree and every message would look
    // like dropped history.
    const leafId = searchParams.get("leafId") ?? manager.getLeafId();
    const history = buildSessionHistory(entries, leafId, { deferThinking, deferToolResultImages });

    // contextStartIndex === -1 means nothing on this chain is in context, so
    // there is no "earlier" portion to split off — return the chain as-is.
    const cut = full || history.contextStartIndex < 0 ? history.messages.length : history.contextStartIndex;

    return NextResponse.json({
      messages: full ? history.messages : history.messages.slice(0, cut),
      entryIds: full ? history.entryIds : history.entryIds.slice(0, cut),
      droppedCount: history.droppedCount,
      contextStartIndex: history.contextStartIndex,
      totalMessages: history.messages.length,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
