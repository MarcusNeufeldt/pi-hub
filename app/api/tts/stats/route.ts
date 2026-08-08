import { NextResponse } from "next/server";
import { readTtsFeedbackStats } from "@/lib/tts-feedback";

export const dynamic = "force-dynamic";

// GET /api/tts/stats — aggregate TTS→STT feedback (WER per provider/voice).
export async function GET() {
  const stats = await readTtsFeedbackStats();
  return NextResponse.json(stats);
}
