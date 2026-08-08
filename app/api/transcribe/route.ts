import { NextRequest, NextResponse } from "next/server";
import { normalizeAudioToWav, transcribeWav, getSttProvider } from "@/lib/stt";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/transcribe — multipart form field "audio" (webm/opus from the
// browser MediaRecorder). Normalizes to 16 kHz mono wav and transcribes via
// the active provider. Returns { text, provider }.
export async function POST(req: NextRequest) {
  const provider = getSttProvider();

  const form = await req.formData();
  const file = form.get("audio");
  if (!(file instanceof Blob) || file.size === 0) {
    return NextResponse.json({ error: "audio file required" }, { status: 400 });
  }

  try {
    const wav = await normalizeAudioToWav(
      Buffer.from(await file.arrayBuffer()),
    );
    const text = await transcribeWav(wav);
    return NextResponse.json({ text, provider });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
