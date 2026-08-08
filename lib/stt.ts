import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const execFileAsync = promisify(execFile);

// Shared STT: converts a webm/audio blob to 16 kHz mono wav and transcribes
// via the active provider. Used by /api/transcribe and the TTS feedback loop.
//
// Providers:
// - elevenlabs (default when ELEVENLABS_API_KEY is set): Scribe v2 — best
//   accuracy per the AA-WER v2 leaderboard (2.2%). Override with
//   TRANSCRIBE_MODEL; optional TRANSCRIBE_LANGUAGE (e.g. "en").
// - openrouter: Gemini 3.6 Flash (or TRANSCRIBE_MODEL override) — fallback.

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const ELEVENLABS_URL = "https://api.elevenlabs.io/v1/speech-to-text";

export type SttProvider = "elevenlabs" | "openrouter";

export function getSttProvider(): SttProvider {
  const forced = process.env.TRANSCRIBE_PROVIDER;
  if (forced === "elevenlabs" || forced === "openrouter") return forced;
  return process.env.ELEVENLABS_API_KEY ? "elevenlabs" : "openrouter";
}

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

export async function transcribeWithElevenLabs(wav: Buffer): Promise<string> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) {
    throw new Error("ELEVENLABS_API_KEY is not set");
  }
  const form = new FormData();
  form.append("model_id", process.env.TRANSCRIBE_MODEL ?? "scribe_v2");
  form.append("file", new Blob([wav], { type: "audio/wav" }), "audio.wav");
  const language = process.env.TRANSCRIBE_LANGUAGE;
  if (language) form.append("language_code", language);
  const res = await fetch(ELEVENLABS_URL, {
    method: "POST",
    headers: { "xi-api-key": key },
    body: form,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ElevenLabs ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as { text?: string };
  return (data.text ?? "").trim();
}

export async function transcribeWithOpenRouter(wav: Buffer): Promise<string> {
  const key = getOpenRouterKey();
  if (!key) {
    throw new Error("No OpenRouter key found");
  }
  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.TRANSCRIBE_MODEL ?? "google/gemini-3.6-flash",
      temperature: 0,
      messages: [
        {
          role: "system",
          content:
            "You are a verbatim speech transcription engine. Transcribe the user's speech exactly as spoken. Output ONLY the transcription text. Never add greetings, suggestions, commentary, or responses to the content.",
        },
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
    throw new Error(`OpenRouter ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return (data?.choices?.[0]?.message?.content ?? "").trim();
}

/** Normalizes an uploaded audio blob (webm/opus from MediaRecorder, or any
 *  ffmpeg-readable format) to 16 kHz mono wav. Returns the wav buffer. */
export async function normalizeAudioToWav(audio: Buffer): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "pi-stt-"));
  try {
    const rawPath = join(dir, "input.webm");
    const wavPath = join(dir, "input.wav");
    await writeFile(rawPath, audio);
    await execFileAsync(
      "ffmpeg",
      ["-y", "-i", rawPath, "-ar", "16000", "-ac", "1", wavPath],
      { timeout: 30000, windowsHide: true },
    );
    return await readFile(wavPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Transcribes a wav buffer with the active provider. */
export async function transcribeWav(wav: Buffer): Promise<string> {
  return getSttProvider() === "elevenlabs"
    ? await transcribeWithElevenLabs(wav)
    : await transcribeWithOpenRouter(wav);
}
