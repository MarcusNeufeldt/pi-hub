import { NextRequest, NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, rm, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordTtsFeedback } from "@/lib/tts-feedback";

const execFileAsync = promisify(execFile);

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/tts { text } → audio
// 1) ElevenLabs TTS (eleven_flash_v2, default voice Rachel; fails gracefully
//    when the key is scoped without TTS access)
// 2) Windows SAPI fallback (offline, no key required)
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { text?: string } | null;
  const text = (body?.text ?? "").trim().slice(0, 4000);
  if (!text) {
    return NextResponse.json({ error: "text required" }, { status: 400 });
  }

  // 1) ElevenLabs
  const key = process.env.ELEVENLABS_API_KEY;
  if (key) {
    const voiceId = process.env.ELEVENLABS_TTS_VOICE_ID ?? "JBFqnCBsd6RMkjVDRZzb"; // Rachel
    try {
      const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: "POST",
        headers: { "xi-api-key": key, "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          model_id: process.env.ELEVENLABS_TTS_MODEL ?? "eleven_flash_v2",
          output_format: "mp3_44100_128",
        }),
      });
      if (res.ok) {
        const audio = Buffer.from(await res.arrayBuffer());
        // Feedback loop: re-transcribe what we spoke and log the WER.
        // Fire-and-forget — never blocks the audio response.
        void recordTtsFeedback({
          originalText: text,
          audio,
          provider: "elevenlabs",
          model: process.env.ELEVENLABS_TTS_MODEL ?? "eleven_flash_v2",
          voiceId,
        });
        return new NextResponse(new Uint8Array(audio), {
          headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" },
        });
      }
    } catch {
      // fall through to SAPI
    }
  }

  // 2) Windows SAPI fallback
  const dir = await mkdtemp(join(tmpdir(), "pi-tts-"));
  try {
    const txtPath = join(dir, "text.txt");
    const wavPath = join(dir, "out.wav");
    await writeFile(txtPath, text, "utf8");
    const ps = [
      "Add-Type -AssemblyName System.Speech",
      `$t = Get-Content -Raw -Encoding UTF8 '${txtPath.replace(/'/g, "''")}'`,
      "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
      "$s.Rate = 0",
      `$s.SetOutputToWaveFile('${wavPath.replace(/'/g, "''")}')`,
      "$s.Speak($t)",
      "$s.Dispose()",
    ].join("; ");
    await execFileAsync("powershell", ["-NoProfile", "-Command", ps], {
      timeout: 60000,
      windowsHide: true,
    });
    const wav = await readFile(wavPath);
    return new NextResponse(new Uint8Array(wav), {
      headers: { "Content-Type": "audio/wav", "Cache-Control": "no-store" },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
