import { NextResponse } from "next/server";

import { getCodexUsage } from "@/lib/codex-usage-server";

/** Read live, never build-time — this is an upstream quota reading. */
export const dynamic = "force-dynamic";

/**
 * Codex plan quota for the top-bar badge.
 *
 * Always 200: a missing `auth.json`, an expired token, or an unreachable
 * upstream are all "nothing to show" rather than errors, and the UI hides the
 * badge on `available: false`.
 *
 * The response carries only usage percentages, window lengths and reset times.
 * The upstream payload also holds the account email, user id and credit balance;
 * `lib/codex-usage` whitelists those out before they reach here, which matters
 * because this route is reachable from any device that clears the host gate.
 */
export async function GET() {
  try {
    const result = await getCodexUsage();
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch {
    // Never surface a stack to the client, and never log the failure: the only
    // values in scope here are credential-adjacent.
    return NextResponse.json(
      { available: false, reason: "unreachable" },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}
