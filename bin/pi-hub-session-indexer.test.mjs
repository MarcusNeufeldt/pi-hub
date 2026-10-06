import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildSessionIndex,
  FIRST_MESSAGE_MAX_CHARS,
  parseSessionInfo,
  SESSION_INDEX_VERSION,
} from "./pi-hub-session-indexer.mjs";

function lines(...entries) {
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

test("parseSessionInfo extracts only bounded catalogue metadata", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-hub-indexer-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "session.jsonl");
  const longPrompt = "x".repeat(FIRST_MESSAGE_MAX_CHARS + 500);
  await writeFile(file, lines(
    { type: "session", id: "session-1", cwd: "C:\\work", timestamp: "2026-01-01T00:00:00.000Z" },
    { type: "message", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: longPrompt } },
    { type: "message", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } },
    { type: "session_info", name: "Latest name" },
  ));

  const info = await parseSessionInfo(file);
  assert.equal(info.id, "session-1");
  assert.equal(info.name, "Latest name");
  assert.equal(info.messageCount, 2);
  assert.equal(info.firstMessage.length, FIRST_MESSAGE_MAX_CHARS);
  assert.equal(info.modified, "2026-01-01T00:00:02.000Z");
});

test("buildSessionIndex reuses unchanged files and refreshes changed files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-hub-indexer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessions = join(root, "sessions");
  const project = join(sessions, "project");
  const cache = join(root, "index.json");
  const file = join(project, "session.jsonl");
  await mkdir(project, { recursive: true });
  await writeFile(file, lines(
    { type: "session", id: "session-1", cwd: "C:\\work", timestamp: "2026-01-01T00:00:00.000Z" },
    { type: "message", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "first" } },
  ));

  const first = await buildSessionIndex(sessions, cache);
  assert.deepEqual({ total: first.total, parsed: first.parsed, reused: first.reused }, { total: 1, parsed: 1, reused: 0 });

  const second = await buildSessionIndex(sessions, cache);
  assert.deepEqual({ total: second.total, parsed: second.parsed, reused: second.reused }, { total: 1, parsed: 0, reused: 1 });

  const before = await stat(file);
  await writeFile(file, lines(
    { type: "session", id: "session-1", cwd: "C:\\work", timestamp: "2026-01-01T00:00:00.000Z" },
    { type: "message", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "first" } },
    { type: "message", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: "second" } },
  ));
  const after = await stat(file);
  assert.ok(after.size !== before.size || after.mtimeMs !== before.mtimeMs);

  const third = await buildSessionIndex(sessions, cache);
  assert.deepEqual({ total: third.total, parsed: third.parsed, reused: third.reused }, { total: 1, parsed: 1, reused: 0 });
  assert.equal(third.sessions[0].messageCount, 2);

  const persisted = JSON.parse(await readFile(cache, "utf8"));
  assert.equal(persisted.version, SESSION_INDEX_VERSION);
  assert.equal(Object.keys(persisted.files).length, 1);
});
