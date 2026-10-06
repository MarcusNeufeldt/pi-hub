import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const SESSION_INDEX_VERSION = 1;
export const FIRST_MESSAGE_MAX_CHARS = 2048;
const MAX_CONCURRENT_READS = 4;

function messageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join(" ");
}

function messageActivityTime(entry) {
  const role = entry?.message?.role;
  if (role !== "user" && role !== "assistant") return undefined;
  const messageTimestamp = entry.message.timestamp;
  if (typeof messageTimestamp === "number" && Number.isFinite(messageTimestamp)) return messageTimestamp;
  const entryTimestamp = Date.parse(entry.timestamp);
  return Number.isNaN(entryTimestamp) ? undefined : entryTimestamp;
}

export async function parseSessionInfo(filePath, fileStats) {
  fileStats ??= await stat(filePath);
  let header;
  let name;
  let messageCount = 0;
  let firstMessage = "";
  let lastActivityTime;

  const lines = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (!header) {
      if (entry?.type !== "session") return null;
      header = entry;
      continue;
    }

    if (entry.type === "session_info") name = entry.name?.trim() || undefined;
    if (entry.type !== "message") continue;

    messageCount++;
    const activityTime = messageActivityTime(entry);
    if (typeof activityTime === "number") {
      lastActivityTime = Math.max(lastActivityTime ?? 0, activityTime);
    }
    if (!firstMessage && entry.message?.role === "user") {
      firstMessage = messageText(entry.message).slice(0, FIRST_MESSAGE_MAX_CHARS);
    }
  }

  if (!header || typeof header.id !== "string") return null;
  const headerTime = Date.parse(header.timestamp);
  const modifiedTime = lastActivityTime
    ?? (Number.isNaN(headerTime) ? fileStats.mtimeMs : headerTime);

  return {
    path: filePath,
    id: header.id,
    cwd: typeof header.cwd === "string" ? header.cwd : "",
    ...(name ? { name } : {}),
    ...(typeof header.parentSession === "string" ? { parentSessionPath: header.parentSession } : {}),
    created: Number.isNaN(headerTime) ? new Date(fileStats.birthtimeMs).toISOString() : new Date(headerTime).toISOString(),
    modified: new Date(modifiedTime).toISOString(),
    messageCount,
    firstMessage: firstMessage || "(no messages)",
  };
}

async function listSessionFiles(sessionDir) {
  const files = [];
  let projectDirs = [];
  try {
    projectDirs = await readdir(sessionDir, { withFileTypes: true });
  } catch {
    return files;
  }

  await Promise.all(projectDirs
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map(async (entry) => {
      const projectDir = join(sessionDir, entry.name);
      try {
        const names = await readdir(projectDir);
        for (const name of names) {
          if (name.endsWith(".jsonl")) files.push(join(projectDir, name));
        }
      } catch {
        // A concurrently removed project directory is safe to skip.
      }
    }));

  return files;
}

async function readExistingIndex(cachePath) {
  try {
    const parsed = JSON.parse(await readFile(cachePath, "utf8"));
    return parsed?.version === SESSION_INDEX_VERSION && parsed.files && typeof parsed.files === "object"
      ? parsed.files
      : {};
  } catch {
    return {};
  }
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

export async function buildSessionIndex(sessionDir, cachePath) {
  const existing = await readExistingIndex(cachePath);
  const paths = await listSessionFiles(sessionDir);
  let reused = 0;
  let parsed = 0;

  const records = await mapWithConcurrency(paths, MAX_CONCURRENT_READS, async (filePath) => {
    try {
      const fileStats = await stat(filePath);
      const old = existing[filePath];
      if (old && old.size === fileStats.size && old.mtimeMs === fileStats.mtimeMs) {
        reused++;
        return [filePath, old];
      }
      parsed++;
      const session = await parseSessionInfo(filePath, fileStats);
      return [filePath, { size: fileStats.size, mtimeMs: fileStats.mtimeMs, session }];
    } catch {
      return null;
    }
  });

  const files = Object.fromEntries(records.filter(Boolean));
  const payload = {
    version: SESSION_INDEX_VERSION,
    generatedAt: new Date().toISOString(),
    files,
  };

  await mkdir(dirname(cachePath), { recursive: true });
  const tempPath = `${cachePath}.${process.pid}.tmp`;
  await writeFile(tempPath, JSON.stringify(payload), "utf8");
  try {
    await rename(tempPath, cachePath);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }

  return {
    sessions: Object.values(files).map((record) => record.session).filter(Boolean),
    total: paths.length,
    parsed,
    reused,
  };
}

async function main() {
  const sessionDir = process.argv[2];
  const cachePath = process.argv[3];
  if (!sessionDir || !cachePath) throw new Error("Usage: pi-hub-session-indexer <session-dir> <cache-path>");
  const result = await buildSessionIndex(resolve(sessionDir), resolve(cachePath));
  process.stdout.write(JSON.stringify({ total: result.total, parsed: result.parsed, reused: result.reused }));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(String(error?.stack || error));
    process.exitCode = 1;
  });
}
