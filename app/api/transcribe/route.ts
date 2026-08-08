import { NextRequest, NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const execFileAsync = promisify(execFile);

// STT via OpenRouter → Mistral Voxtral Small (speech transcription).
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = process.env.TRANSCRIBE_MODEL ?? "mistralai/voxtral-small-24b-2507";

function getOpenRouterKey(): string | null {
  const env = process.env.OPENROUTER_API_KEY;
  if (env) return env;
  try {
    const auth = JSON.parse(
      readFileSync(join(homedir(), ".pi", "agent", "auth.json"), "utf8"),
    ) as { openrouter?: { key?: string } };
    return auth?.openrouter?.key ?? null;
  } catch {
    return null;
  }
}

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/transcribe — multipart form field "audio" (webm/opus from the
// browser MediaRecorder). Normalizes to 16 kHz mono wav and transcribes via
// OpenRouter. Returns { text }.
export async function POST(req: NextRequest) {
  const key = getOpenRouterKey();
  if (!key) {
    return NextResponse.json({ error: "No OpenRouter key found" }, { status: 500 });
  }

  const form = await req.formData();
  const file = form.get("audio");
  if (!(file instanceof Blob) || file.size === 0) {
    return NextResponse.json({ error: "audio file required" }, { status: 400 });
  }

  const dir = await mkdtemp(join(tmpdir(), "pi-transcribe-"));
  try {
    const rawPath = join(dir, "input.webm");
    const wavPath = join(dir, "input.wav");
    await writeFile(rawPath, Buffer.from(await file.arrayBuffer()));

    // MediaRecorder produces webm/opus; normalize for STT.
    await execFileAsync(
      "ffmpeg",
      ["-y", "-i", rawPath, "-ar", "16000", "-ac", "1", wavPath],
      { timeout: 30000, windowsHide: true },
    );
    const wav = await readFile(wavPath);

    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "input_audio",
                input_audio: { data: wav.toString("base64"), format: "wav" },
              },
            ],
          },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return NextResponse.json(
        { error: `OpenRouter ${res.status}: ${body.slice(0, 300)}` },
        { status: 502 },
      );
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text: string = data?.choices?.[0]?.message?.content ?? "";
    return NextResponse.json({ text: text.trim() });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
