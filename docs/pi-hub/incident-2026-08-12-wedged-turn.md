# Incident: A Turn Wedged for 90 Minutes on an Unanswered MCP Call

**Date:** 2026-08-12 · **Session:** `<redacted>` ·
**Duration:** ~90 min from stall to recovery · **Resolution:** full server restart

A turn stopped making progress and could not be recovered from inside the app. The
Stop button did nothing, the UI reported the wrong reason, and the only fix was
restarting the always-on server. No data was lost.

Kept because the diagnosis was slow and non-obvious, and because three of the
contributing defects are ours.

## Impact

One session became permanently unresponsive mid-turn. The transcript was intact
throughout (34 entries, 215 KB) and survived the restart — the only loss was the
in-flight turn, which had already stopped doing anything.

At the time of recovery, 1 of 94 sessions had a live RPC session, so the restart
cost nothing beyond the already-dead turn. Any other user mid-run would have been
interrupted, because there is no way to reset one session.

## What Happened

The agent (`gpt-5.6-sol` via the built-in `openai-codex` provider, cwd
`F:\explore\upwork\gepa-prototype`, 69,527 tokens / 25.6% of context) called
`ctx_batch_execute` with 8 commands, `concurrency: 5` and `timeout: 120000`. Each
command shelled out to a PowerShell GitHub broker script, e.g.

```
powershell -NoProfile -ExecutionPolicy Bypass -File ...\pr-broker.ps1 \
  file --repo <org>/<repo> --path src/features/... --ref main
```

The MCP server never replied. pi waited indefinitely.

## Timeline (UTC)

| Time | Event |
|---|---|
| 16:13:24 | The context-mode MCP server (a `bun` child of the pi-hub server) starts. |
| 16:28:59 | Last line written to `hub-server.log`: repeated `EPERM` rename failures raised as `uncaughtException` from pi's subagent status writer, plus two memory auto-consolidation subprocess timeouts (180 s). **Correlated, not proven causal.** |
| 16:31:46 | Last write to context-mode's content store for this project. |
| 16:32:24 | Assistant message persisted: thinking + `toolCall(ctx_batch_execute)`. **Last transcript write.** |
| ~16:46 | First diagnosis. `isPromptRunning: true`, no tool result, MCP server idle. |
| 17:56 | Still frozen — 84 minutes, transcript mtime unchanged. |
| ~18:0x | `POST {type:"abort"}` issued directly to the API: hung >3 min, never returned. |
| ~18:1x | Killed the MCP server process. **Did not release the turn.** |
| ~18:2x | Restarted the pi-hub server. `isPromptRunning: false`, transcript intact. |

## Evidence

**The commands never ran.** Three independent signals:

- context-mode's content store for the project was last written at `16:31:46Z`,
  38 seconds *before* the call was dispatched. Nothing was indexed afterwards.
- The MCP server process had **no child processes** — no PowerShell, nothing.
- It burned **0.00 s of CPU across a 4-second sample**: alive, idle, not working.

**No model request was in flight.** The pi-hub server process had *zero* outbound
TCP connections; all six established sockets were inbound to `:30141` (browser tabs
and SSE clients). MCP uses stdio over a child process, not TCP, which is why a tool
wait shows no socket — and why the absence of sockets initially looked like "nothing
is running" rather than "waiting on a pipe".

**The RPC channel was healthy; only the turn was dead.** `GET /api/agent/<id>`
(which sends `get_state`) answered instantly and correctly. `POST` with
`{type:"abort"}` on the same channel hung for over three minutes and never
returned.

**pi does not treat stdio EOF as a request failure.** Killing the MCP server —
the process that owed the reply — left `isPromptRunning: true`. The pending request
was not failed when its transport died.

## Root Cause and Attribution

| Layer | Verdict |
|---|---|
| **context-mode MCP server** (local fork) | **Trigger.** Received the request, never dispatched the commands, never replied. |
| **pi** (upstream SDK) | **Why it was fatal.** No client-side MCP request deadline, and an abort that waits on the wedged turn to acknowledge. |
| **pi-hub** (this repo) | **Why it was unrecoverable by the user.** Wrong phase label, no feedback on Stop, no per-session reset. |
| **opencodex / OpenAI** | **Not involved.** The model had already delivered the tool call and gone idle. |

The framing that matters: a misbehaving MCP server is a normal, expected fault —
servers crash and pipes break. A correct client caps the wait, injects an error tool
result, and lets the model retry. pi does neither, so a routine fault became a dead
session. The `timeout: 120000` in the call was no protection: that is
context-mode's *per-command* execution timeout, and it never fires if the server
never dispatches the commands. There is no timeout on the MCP request itself.

## Why Recovery Failed

1. **Stop / Esc** — sends `{type:"abort"}`, which hangs forever. The button has no
   pending state, so it is indistinguishable from a no-op. The HTTP request has no
   timeout either, so it leaks a blocked handler.
2. **Killing the MCP server** — targeted and safe (idle, no children, respawns on
   demand), but pi ignored the resulting EOF.
3. **Restarting the server** — worked, and was the only lever. It destroys every
   session's RPC state, because the only code path that destroys RPC sessions is
   `app/api/project-trust/route.ts`, which does it as a side effect of a trust
   change. There is no force-reset for a single session.

## What We Still Do Not Know

- **Why context-mode did not reply.** It writes no log files, so there is no way to
  distinguish "the request never reached the handler" from "the handler accepted it
  and died silently". This is the one open question and it blocks a real fix.
- **Whether the 16:28:59 `uncaughtException` storm contributed.** An uncaught
  exception in the process hosting the MCP client is a plausible way to orphan a
  pending request, but 3.5 minutes of separation is not evidence.

## Action Items

**pi-hub (ours)** — done in `4f8661d`, except where noted

- **Done.** `POST /api/sessions/[id]/reset` destroys the RPC session for one session
  id, so a wedged turn no longer requires restarting every session. Uses `destroy()`
  rather than `shutdown()`, which would block on the wedged turn.
- **Done.** `sendAgentCommand` takes an optional deadline and abort uses it, so a
  hanging abort surfaces as an error naming Force reset instead of vanishing. Stop
  has a pending state and cannot be double-fired.
- **Done.** A running tool row shows live elapsed time, accent past a minute.
  Anchored on the message's `endedAt`, which is when tools began. This is the change
  that would have made the incident self-evident: the row would have read `79m`.
- **Not done — the original item was based on a wrong premise.** It said "fix the
  phase label", on the assumption that the label was wrong. Reading the transitions
  shows it was not: the phase becomes `running_tools` on `tool_execution_start` and
  returns to `waiting_model` on `tool_execution_end`. "Waiting for model" was
  therefore *stale, not mislabelled* — pi never emitted `tool_execution_start`,
  because it never dispatched the call. The correct fix is a **staleness detector**:
  when a turn is running and no agent event has arrived for some minutes, say so
  rather than displaying a confident phase from before the stall. Relabelling would
  have hidden a real signal.

That last point also sharpens the attribution below: the absence of a
`tool_execution_start` event is independent evidence that the wedge happened
*before* dispatch, which weakens the case against context-mode and strengthens the
case that pi never issued the request. It is not conclusive — the UI could have
missed the event — but it is the one signal that distinguishes the two.

**pi (upstream)**

- Give MCP requests a deadline, and inject an error tool result when it expires.
- Make abort independent of the wedged turn's cooperation.
- Fix the atomic-rename pattern in the subagent status writer: it assumes POSIX
  semantics and throws `EPERM` on NTFS, as an `uncaughtException`.

**context-mode fork (local)**

- Log requests and responses. Without it this class of failure is undiagnosable.

## Runbook: Diagnosing a Stuck Turn

The sequence that worked, in order. Steps 1-2 identify the class of stall in under
a minute.

1. **Is the server still running the turn?**
   `GET /api/agent/<id>` → check `isPromptRunning`, `isStreaming`, `isBashRunning`.
2. **What is it waiting on?** Tail the session `.jsonl` under
   `~/.pi/agent/sessions/`. If the last entry is an assistant message containing a
   `toolCall` with no matching `toolResult`, it is a tool wait — regardless of what
   the UI's phase label says. Check the file's mtime: frozen means no progress.
3. **Find the MCP server.** It is a child of the pi-hub server process:
   `Get-CimInstance Win32_Process -Filter "ParentProcessId = <serverPid>"`.
4. **Working or hung?** Sample its CPU twice a few seconds apart, and list *its*
   children. Children present and CPU moving means a slow command; no children and
   flat CPU means it owes a reply it will never send.
5. **Rule out the model.** List the server's non-listening TCP connections. No
   outbound socket means no model request is in flight. Do not read that as "nothing
   is running" — MCP is stdio.
6. **Ask whether the tool did anything.** For context-mode, compare its content
   store mtime against the tool call's timestamp.
7. **Confirm the turn is dead.** `GET` answers instantly but `POST {type:"abort"}`
   hangs → the run loop is gone and only a restart will clear it.
8. **Before restarting, count what you would interrupt.** Iterate the session list
   and `GET /api/agent/<id>` for each; only sessions reporting `running: true` have
   anything to lose.
