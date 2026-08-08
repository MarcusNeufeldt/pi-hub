import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { getHubHome } from "@/modules/scheduler/paths";

/**
 * Disk cache for generated TTS audio, keyed by
 * sha256(provider|voiceId|model|text). Re-clicking "Read aloud" on the same
 * message serves the cached audio — no re-payment, no re-generation, and the
 * STT feedback loop only runs on cache misses.
 */

function cacheDir(): string {
  return join(getHubHome(), "tts-cache");
}

export function ttsCacheKey(
  text: string,
  voiceId: string,
  model: string,
  provider: string,
): string {
  return createHash("sha256")
    .update(`${provider}|${voiceId}|${model}|${text}`)
    .digest("hex")
    .slice(0, 20);
}

export async function readTtsCache(
  key: string,
): Promise<{ buffer: Buffer; ext: "mp3" | "wav" } | null> {
  for (const ext of ["mp3", "wav"] as const) {
    try {
      const buffer = await readFile(join(cacheDir(), `${key}.${ext}`));
      return { buffer, ext };
    } catch {
      // try next extension
    }
  }
  return null;
}

export async function writeTtsCache(
  key: string,
  buffer: Buffer,
  ext: "mp3" | "wav",
): Promise<void> {
  await mkdir(cacheDir(), { recursive: true });
  await writeFile(join(cacheDir(), `${key}.${ext}`), buffer);
  await pruneTtsCache();
}

const CACHE_MAX_BYTES = 200 * 1024 * 1024; // 200 MB of spoken audio ≈ hours

/** Best-effort: drop oldest files while above the cap. */
async function pruneTtsCache(): Promise<void> {
  try {
    const dir = cacheDir();
    const entries = await readdir(dir);
    const files: Array<{ path: string; size: number; mtimeMs: number }> = [];
    for (const name of entries) {
      const p = join(dir, name);
      try {
        const s = await stat(p);
        if (s.isFile()) files.push({ path: p, size: s.size, mtimeMs: s.mtimeMs });
      } catch {
        // ignore
      }
    }
    const total = files.reduce((sum, f) => sum + f.size, 0);
    if (total <= CACHE_MAX_BYTES) return;
    files.sort((a, b) => a.mtimeMs - b.mtimeMs);
    let freed = 0;
    for (const f of files) {
      if (total - freed <= CACHE_MAX_BYTES) break;
      await unlink(f.path).catch(() => {});
      freed += f.size;
    }
  } catch {
    // best effort
  }
}
