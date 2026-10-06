#!/usr/bin/env node
// Deterministic pre-flight gate for the "Rename unnamed sessions" task.
// Exit 0 = there is work (unnamed, non-subagent, non-running session with
// messages) → the scheduled run proceeds. Any other exit = skip the run
// without spawning a Pi session; the executor records the output as the
// run's result excerpt. Read-only: this never renames anything.

import { selectUnnamedSessions } from "./rename-unnamed-sessions.mjs";

const base = (
  process.argv[2] ||
  process.env.PI_HUB_BASE_URL ||
  "http://127.0.0.1:30141"
).replace(/\/$/, "");

// "New" means modified within this window. Old sessions whose title
// generation keeps failing (e.g. provider routing 404s) must not pin the
// gate open forever — the task exists to name NEW sessions.
const RECENCY_MS = 7 * 24 * 60 * 60_000;

try {
  const res = await fetch(`${base}/api/sessions`, {
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    console.error(`sessions API returned HTTP ${res.status}`);
    process.exit(2);
  }
  const body = await res.json();
  const cutoff = Date.now() - RECENCY_MS;
  const recent = (Array.isArray(body.sessions) ? body.sessions : []).filter(
    (session) => Number.isFinite(Date.parse(session?.modified || ""))
      && Date.parse(session.modified) > cutoff,
  );
  const count = selectUnnamedSessions(
    recent,
    Array.isArray(body.runningSessionIds) ? body.runningSessionIds : [],
    1,
  ).length;
  if (count > 0) {
    console.log(`work: ${count} unnamed session(s) to rename`);
    process.exit(0);
  }
  console.log("no unnamed sessions to rename");
  process.exit(1);
} catch (error) {
  console.error(String(error?.message ?? error));
  process.exit(2);
}
