#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_BASE_URL = "http://127.0.0.1:30141";
const DEFAULT_LIMIT = 10;

export function isSubagentSession(session) {
  const name = typeof session?.name === "string" ? session.name.trim() : "";
  const filePath = typeof session?.path === "string" ? session.path : "";
  const firstMessage = typeof session?.firstMessage === "string" ? session.firstMessage.trim() : "";
  return /^subagent[-_]/i.test(name)
    || /[\\/]subagents[\\/]/i.test(filePath)
    || /^Parent agent:\s/i.test(firstMessage);
}

export function selectUnnamedSessions(sessions, runningSessionIds = [], limit = DEFAULT_LIMIT) {
  const running = new Set(runningSessionIds);
  return sessions
    .filter((session) => (
      session
      && !session.name
      && Number(session.messageCount) > 0
      && !running.has(session.id)
      && !isSubagentSession(session)
    ))
    .sort((left, right) => Date.parse(right.modified || "") - Date.parse(left.modified || ""))
    .slice(0, limit);
}

function parseArgs(argv) {
  const options = { baseUrl: DEFAULT_BASE_URL, limit: DEFAULT_LIMIT };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === "--base-url" && argv[index + 1]) options.baseUrl = argv[++index];
    else if (value === "--limit" && argv[index + 1]) options.limit = Number(argv[++index]);
    else if (value === "--help") options.help = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 50) {
    throw new Error("--limit must be an integer from 1 to 50");
  }
  options.baseUrl = options.baseUrl.replace(/\/$/, "");
  return options;
}

async function readJson(response) {
  return response.json().catch(() => ({}));
}

export async function renameUnnamedSessions({
  baseUrl = DEFAULT_BASE_URL,
  limit = DEFAULT_LIMIT,
  fetchImpl = fetch,
} = {}) {
  const listResponse = await fetchImpl(`${baseUrl}/api/sessions`);
  const listBody = await readJson(listResponse);
  if (!listResponse.ok || !Array.isArray(listBody.sessions)) {
    throw new Error(listBody.error || `Unable to list sessions (HTTP ${listResponse.status})`);
  }

  const candidates = selectUnnamedSessions(
    listBody.sessions,
    listBody.runningSessionIds,
    limit,
  );
  const renamed = [];
  const skipped = [];
  const failed = [];

  for (const session of candidates) {
    try {
      const response = await fetchImpl(
        `${baseUrl}/api/sessions/${encodeURIComponent(session.id)}/auto-name?onlyUnnamed=1`,
        { method: "POST" },
      );
      const body = await readJson(response);
      if (!response.ok || typeof body.title !== "string") {
        throw new Error(body.error || `HTTP ${response.status}`);
      }
      if (body.skipped === "already_named") {
        skipped.push({ id: session.id, reason: body.skipped, title: body.title });
      } else {
        renamed.push({ id: session.id, title: body.title });
      }
    } catch (error) {
      failed.push({
        id: session.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    scanned: listBody.sessions.length,
    eligible: candidates.length,
    renamed,
    skipped,
    failed,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node scripts/rename-unnamed-sessions.mjs [--base-url URL] [--limit 1-50]");
    return;
  }
  const result = await renameUnnamedSessions(options);
  console.log(JSON.stringify(result, null, 2));
  if (result.failed.length > 0) process.exitCode = 1;
}

const isMain = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
