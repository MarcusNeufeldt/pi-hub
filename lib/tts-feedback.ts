import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { getHubHome } from "@/modules/scheduler/paths";
import { normalizeAudioToWav, transcribeWav } from "@/lib/stt";

/**
 * TTS → STT feedback loop: after we speak a reply, re-transcribe the audio
 * and compare it to the original text. Word error rate + mismatch samples are
 * appended to a JSONL log so voice/model choices can be tuned with data.
 */

export interface TtsFeedbackRecord {
  ts: string; // ISO
  provider: "elevenlabs" | "sapi" | "unknown";
  model?: string;
  voiceId?: string;
  wer: number; // 0..1 (lower is better)
  refWords: number;
  hypWords: number;
  sample: string; // first ~120 chars of the original text
}

function feedbackPath(): string {
  return join(getHubHome(), "tts-feedback.jsonl");
}

/** Word error rate between reference and hypothesis (0 = perfect). */
export function wordErrorRate(reference: string, hypothesis: string): number {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter(Boolean);
  const ref = norm(reference);
  const hyp = norm(hypothesis);
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
  // Levenshtein distance over word arrays
  const dp: number[][] = Array.from({ length: ref.length + 1 }, () =>
    new Array<number>(hyp.length + 1).fill(0),
  );
  for (let i = 0; i <= ref.length; i++) dp[i][0] = i;
  for (let j = 0; j <= hyp.length; j++) dp[0][j] = j;
  for (let i = 1; i <= ref.length; i++) {
    for (let j = 1; j <= hyp.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[ref.length][hyp.length] / ref.length;
}

/** Fire-and-forget: transcribe `audio` (already the exact bytes we spoke) and
 *  log the WER against `originalText`. Never throws. */
export async function recordTtsFeedback(opts: {
  originalText: string;
  audio: Buffer;
  provider: "elevenlabs" | "sapi" | "unknown";
  model?: string;
  voiceId?: string;
}): Promise<TtsFeedbackRecord | null> {
  if (process.env.TTS_FEEDBACK === "0") return null;
  try {
    const wav = await normalizeAudioToWav(opts.audio);
    const hyp = await transcribeWav(wav);
    const wer = wordErrorRate(opts.originalText, hyp);
    const record: TtsFeedbackRecord = {
      ts: new Date().toISOString(),
      provider: opts.provider,
      model: opts.model,
      voiceId: opts.voiceId,
      wer,
      refWords: opts.originalText.split(/\s+/).filter(Boolean).length,
      hypWords: hyp.split(/\s+/).filter(Boolean).length,
      sample: opts.originalText.slice(0, 120),
    };
    await mkdir(join(getHubHome()), { recursive: true });
    await appendFile(feedbackPath(), JSON.stringify(record) + "\n", "utf8");
    console.log(`[tts-feedback] wer=${(wer * 100).toFixed(1)}% provider=${opts.provider} ref=${record.refWords}w`);
    return record;
  } catch (err) {
    console.error("[tts-feedback] failed:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

export interface TtsFeedbackStats {
  count: number;
  avgWer: number;
  byProvider: Record<string, { count: number; avgWer: number }>;
  recent: Array<{ ts: string; provider: string; wer: number; sample: string }>;
}

/** Aggregate stats from the feedback log. */
export async function readTtsFeedbackStats(): Promise<TtsFeedbackStats> {
  const empty: TtsFeedbackStats = { count: 0, avgWer: 0, byProvider: {}, recent: [] };
  try {
    const raw = await readFile(feedbackPath(), "utf8");
    const records = raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as TtsFeedbackRecord;
        } catch {
          return null;
        }
      })
      .filter((r): r is TtsFeedbackRecord => r !== null);
    if (records.length === 0) return empty;
    const total = records.reduce((sum, r) => sum + r.wer, 0);
    const byProvider: TtsFeedbackStats["byProvider"] = {};
    for (const r of records) {
      const b = (byProvider[r.provider] ??= { count: 0, avgWer: 0 });
      b.count += 1;
      b.avgWer += r.wer;
    }
    for (const b of Object.values(byProvider)) b.avgWer /= b.count;
    return {
      count: records.length,
      avgWer: total / records.length,
      byProvider,
      recent: records
        .slice(-20)
        .reverse()
        .map((r) => ({ ts: r.ts, provider: r.provider, wer: r.wer, sample: r.sample })),
    };
  } catch {
    return empty;
  }
}
