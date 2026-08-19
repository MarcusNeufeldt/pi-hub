# Incident: Context Ran to 119% Before Compacting, and the Workflow Results Went Missing

**Date:** 2026-08-18 · **Session:** `<redacted>` · **Model:** `gpt-5.6-sol` via the
built-in `openai-codex` provider · **Resolution:** none needed; the agent recovered its
own results from disk and the session continued.

A long agentic turn grew the context to 119% of the model's window without auto
compaction ever being evaluated. When it finally compacted, a workflow's results had
just landed, and the agent could not find them through any of its own lookups — it
ended up shelling out to `find` to recover its own subagent output.

Kept because the visible symptom ("compaction ignored the threshold, then the thread
collapsed") points at neither cause, and because the first diagnosis of the
pi-subagents half was wrong in a way worth recording.

## Impact

No data lost. One turn aborted mid-run. The agent spent five tool calls re-locating
results it had already been handed, and one of the two workflow children had produced
nothing at all. The session was still healthy afterwards and carried on working.

## Part 1 — pi-subagents: the results were delivered, and nothing said where they were

The workflow completed with two children while the parent turn was still running. Its
results were never lost; the agent just had no pointer to them.

### 1.1 The notify carries 1,000 characters of the return, and that is what the model sees

`src/runs/foreground/subagent-executor.ts:5224`:

```js
const returnPreview = formatWorkflowValue(workflow.value).slice(0, 1_000);
```

The `subagent-notify` message in the transcript is 1,108 characters and stops mid-word
inside the first child's report. The full output is persisted — `writeWorkflowResult`
records each child's `output`, and the artifact survived under
`sessions/<cwd>/subagent-artifacts/<runId>_s…` — but the *model* is handed the
truncated preview. An investigation report of several KB arrives as a cut-off
fragment, so the agent's only reasonable move is to go looking for the rest.

The cap is not the defect on its own. The defect is that the message says nothing
about having been truncated and gives no path to the full artifact, so the agent has
to discover both facts by trial and error.

### 1.2 The two lookups the agent tried were the wrong ones, and said so misleadingly

After the notify, the agent tried to find the full results twice and got nothing:

```text
subagent { action: "children.list" }   -> "No retained workflow children in the active parent session."
agent_message { action: "sessions" }   -> "No subagent sessions found for this coordinator."
```

Both answers were **correct**, and both read like statements about this conversation
when they are statements about a different concept.

Workflow children are recorded as *steps of the workflow parent run*, not as separate
async runs. The parent for this session is on disk and complete:

```text
run 3670810a  mode=workflow  state=complete  steps=2
  step: agent=scout  workflowKey='quote-allowance-path'  runId=1eb80e6f  status=completed
  step: agent=scout  workflowKey='prompt-provenance'     runId=7cdd232f  status=failed
```

`listRetainedChildren` (`src/runs/background/retained-children.ts:86`) requires
`run.parentWorkflowRunId` **and** `run.steps.length === 1` — it looks for retained
standalone children, which a workflow parent with two steps is not. So the empty
answer is the function working as designed, on a question the agent did not mean to
ask.

An earlier draft of this document claimed `parentWorkflowRunId` is never persisted and
therefore `children.list` is dead code. That was wrong and is recorded here so the
mistake is not repeated: the field is written into the status
(`async-status.ts:347`), the workflow passes it at launch (`workflowParentRunId` ->
`prepareWorkflowLaunchParams`), the installed build and upstream HEAD have identical
plumbing for it, and carrying it is what grants a run `workflow-reference` retention
protection (`async-retention.ts:293`). The 32 surviving run directories simply are not
standalone workflow children. `1eb80e6f` had no run directory because children of a
workflow never get one — not because one was deleted.

### 1.3 What the agent had to do instead

It recovered on its own, in five tool calls: `bash find` over the session's
`subagent-artifacts/`, then `read` on the artifact, which returned the full report.
Everything it needed was one lookup away the whole time; nothing told it where.

### 1.4 Separately: one child never ran

```text
Subagent run failed before producing output.
Error: Error: Failed to load extension "F:\explore\con…"
```

A broken extension path — the `context_mode_fork` extension — so one of the two
workflow children produced nothing. This one is local configuration, not upstream.

## Part 2 — pi: auto-compaction is only evaluated between agent runs

**This is upstream #6879**, open since 2026-07-20 and labelled `bug`, reported against
the same model and provider ("272k configured, ~373k enforced"). Four fix branches
exist; the blocker is that a naive mid-loop check fails the existing #7253 regression.
Nothing below is novel — it is recorded because the symptom is unrecognisable from the
cause, and because two of the conclusions in the first draft of this document were
wrong. Do not file a new issue.


`gpt-5.6-sol` declares `contextWindow: 272000` in pi's own catalogue
(`@earendil-works/pi-ai/dist/providers/data/openai-codex.json`). The session reached
**323,907** tokens — 119% — before compacting, with `tokensBefore: 324166` recorded on
the compaction entry.

pi's accounting is not at fault. `calculateContextTokens` prefers `usage.totalTokens`
and the numbers in the transcript are consistent. The trigger simply never runs during
a turn. `_checkCompaction` has exactly two callers, both outside the tool loop
(`dist/core/agent-session.js`):

```js
await this.agent.prompt(messages);
while (await this._handlePostAgentRun()) {   // _checkCompaction lives in here
    await this.agent.continue();
}
```

`agent.prompt()` runs the whole assistant → toolCall → toolResult cycle internally.
The other caller fires just before a new user prompt. Neither can interrupt a run in
progress, so the context grew unchecked across roughly eighteen consecutive
assistant/toolResult pairs:

| entry | context tokens | % of 272,000 |
|---|---|---|
| 347 | 294,552 | 108% |
| 370 | 312,604 | 115% |
| 382 | 323,907 | **119%** |
| 384 | — | `stopReason: error`, "This operation was aborted" |
| 386 | 324,166 | compaction runs |
| 388 | 53,474 | 20% |

The overshoot is unbounded in principle: it is however much context one turn's tool
calls happen to consume. Raising `reserveTokens` (default 16,384, so the threshold sat
at 255,616) cannot help, because the check it guards is not reached.

### Mid-turn compaction was removed on purpose; one blind spot remains

The first reading of the paragraph above — that a codebase this mature has no mid-turn
guard — is wrong. It had one and dropped it. pi 0.17.0:

> **Simplified compaction flow**: Removed proactive compaction (aborting mid-turn when
> threshold approached). Compaction now triggers in two cases only: (1) overflow error
> from LLM, which compacts and auto-retries, or (2) threshold crossed after a
> successful turn, which compacts without retry.

So the threshold not firing during a turn is the documented design. Case 1 is what
covers mid-turn growth, and it is reactive: the provider is expected to reject an
over-window request.

They anticipated providers that do not reject. `isContextOverflow`
(`@earendil-works/pi-ai/dist/utils/overflow.js:130`) has three detectors, the second
written for exactly that:

```js
// Case 2: Silent overflow (z.ai style) - successful but usage exceeds context
if (contextWindow && message.stopReason === "stop") {
    const inputTokens = message.usage.input + message.usage.cacheRead;
    if (inputTokens > contextWindow) return true;
}
```

The gate is `stopReason === "stop"`. Every assistant message inside a tool loop ends
with `stopReason: "toolUse"` — entries 380 and 382 both did. So for a silently
truncating provider inside a long tool loop, neither documented case can fire: case 1
waits for an error that never comes, and its silent-overflow substitute only inspects
the message that ends a turn, which is the thing taking too long.

That is the whole defect, and it is narrow: not "compaction ignores the threshold",
which is by design, but "silent context overflow is undetectable inside a tool loop".

Two details worth keeping:

- Nothing was truncated. `272000` is not this model's capability limit — pi's own
  `docs/models.md` says the GPT-5.6 family defaults to it "so requests remain within
  OpenAI's short-context pricing tier", and the catalogue carries a matching
  `inputTokensAbove: 272000` cost tier. So the requests at 380 and 382 were over pi's
  *configured* window, not the provider's, and were served in full. #6879's reporter
  measured the Codex backend enforcing ~373k; **that figure does not hold for this
  account** — see the recurrence below, which was served at 434,685. Served without an
  error is still not proof the provider did not truncate the input; that cannot be
  determined from a transcript.
- That also means the cost angle does not apply here: this machine reaches
  `openai-codex` over an OAuth subscription (`baseUrl: https://chatgpt.com/backend-api`),
  so the per-call costs pi records are notional catalogue figures, not charges. The
  tier pricing is why the 272,000 default exists for direct-API users.
- The compaction cut kept everything from entry 359, so the `subagent-notify` at 385
  survived it. Compaction did not lose the workflow results — the truncated notify did.
  The ordering made it look otherwise.

## What Was Verified, and How

- Model window: read from pi's bundled provider catalogue, not inferred.
- Token trajectory: `input + cacheRead` per assistant message from the session JSONL,
  cross-checked against `tokensBefore` on the compaction entry.
- Compaction call sites: `grep` of `dist/core/agent-session.js` — two callers, both
  shown above.
- `parentWorkflowRunId`: counted across all 32 live run directories, then checked
  against upstream HEAD and the workflow launch path before drawing a conclusion. The
  count alone supported the wrong one.
- Cut point: `firstKeptEntryId` resolved to its index and compared against the notify
  entry's index.

## Not Verified

- Why the turn aborted at entry 384. The message is "This operation was aborted",
  which is a client-side signal, and the subagent notification arrived immediately
  after. Whether the notify interrupted the run, or the run failed for another reason
  and the notify merely followed, is not established from the transcript.
- Why `1eb80e6f`'s run directory was removed while its artifact survived. Cleanup
  exists in pi-subagents; whether this was cleanup, or the record was never written,
  was not determined.

## Follow-Ups

1. **pi-subagents** — when the workflow return is truncated, say so and include the
   artifact path. The parent's `status.json` already holds `steps[].runId` and the
   artifacts sit at a known location, so the notify can name them instead of leaving
   the agent to guess that more exists. This is the only upstream change Part 1 needs.
2. **pi-subagents, smaller** — `children.list`'s empty message reads as a statement
   about the current conversation. Saying what it looked for would have stopped the
   agent chasing it.
3. **pi** — let the silent-overflow detector consider `stopReason: "toolUse"`, not
   only `"stop"`. It fires only when the window is already exceeded, so it does not
   reintroduce the proactive compaction 0.17.0 removed. Do not propose a per-round
   threshold check: that is asking them to re-add what they deliberately took out.
4. **local** — fix the `context_mode_fork` extension path that is failing subagent runs
   before they produce output.

## Mitigation Applied

`~/.pi/agent/models.json` now overrides the window for this model, and the compaction
reserve is raised to match how much a single turn here can add:

```json
"openai-codex": { "modelOverrides": { "gpt-5.6-sol": { "contextWindow": 350000 } } }
```

```json
"compaction": { "enabled": true, "reserveTokens": 40000 }
```

Threshold moves from 255,616 to 310,000. Measured from this session, 15 of 16 agent
runs grew by under 22k tokens, so the boundary check now absorbs the ordinary case; the
one run that added 139,963 tokens still would not fit any sane reserve. 350,000 rather
than the documented 1,050,000 because #6879 reports the subscription backend rejecting
around 373k — above that, pi would stop compacting only for requests to start failing
instead. Verified in the UI: the context readout reports 350k.

This mitigation did what it was designed to do and is not sufficient. It only moves the
boundary check; it cannot create a boundary. The recurrence below is the uncovered case
named in the sentence above, landing the same day.

Both files are global to this machine, and both have `.bak-20260818` copies beside them.

## Recurrence, Same Day: 124% of the Raised Window

A second session (started 17:27 local, cwd `F:\explore\upwork-gepa-prototype`, same model
and provider, session id redacted) peaked at **434,855 context tokens — 124% of the raised
350,000 window**. 154 assistant messages sat above the 310,000 threshold; 135 sat above the
window itself.

The threshold check behaved correctly at every boundary it actually reached:

| entry | time | boundary | context tokens | outcome |
|---|---|---|---|---|
| 261 | 18:29:56 | `stop` | 290,140 (82.9%) | under 310,000 — correctly no compaction |
| 262 | 18:31:38 | user prompt ("do all 5") | — | turn starts |
| 575 | 19:07:59 | assistant `stopReason: error`, 0 usage | — | did **not** end the turn; the loop continued |
| 587 | 19:10:09 | `stop` | 434,855 (124.2%) | compaction fires (entry 588, 19:13:03) |
| 590 | 19:13:09 | — | 69,512 (19.9%) | recovered |

Between entries 262 and 587 there was no boundary at all: one turn, 38 minutes, roughly 325
entries, about 145,000 tokens added. `reserveTokens: 40000` cannot absorb a turn that adds
3.6x the reserve.

What ended the overshoot was the user typing. The 19:10:00 request for a status update
created the boundary that let compaction run. Nothing in pi would have.

### Where the 145k came from — not subagent results

`toolResult` payload volume inside that single turn:

| tool | calls | result bytes |
|---|---|---|
| `read` | 39 | 291,344 |
| `bash` | 55 | 54,549 |
| `ctx_search` | 5 | 23,287 |
| `ctx_batch_execute` | 1 | 21,983 |
| `ctx_execute` | 12 | 16,091 |
| `edit` | 45 | 5,996 |
| `subagent` | 1 | 1,207 |
| `write` | 3 | 401 |
| `message_peer` | 1 | 78 |

414,936 bytes total, of which `read` is 70%. Two single reads of 54,024 and 53,231 bytes
(entries 306 and 308). One `subagent` call, 1,207 bytes.

The first guess — that workflow results drove the growth, as they did in Part 1 — was wrong.
Raw file reading did. Recorded so it is not re-derived: check the toolResult mix before
blaming subagents.

## The Fix That Is Actually Available: a `tool_call` Hook

pi's extension API already ships every primitive needed to bound this locally, without
waiting for #6879. Verified against the installed 0.84.1.

**Sensor.** `ExtensionContext` (`dist/core/extensions/types.d.ts:209-249`) is the second
argument to *every* hook handler, and carries:

```ts
getContextUsage(): ContextUsage | undefined;   // line 244
compact(options?: CompactOptions): void;       // line 246 - "Trigger compaction without awaiting completion."
abort(): void;                                 // line 238
```

`ContextUsage` (line 193) is `{ tokens: number | null; contextWindow: number; percent: number | null }`.
Its implementation (`dist/core/agent-session.js:2542`) reads `model.contextWindow`, so it
already reflects the 350,000 override rather than the catalogue value.

**Actuator.** The `tool_call` hook's result type:

```ts
export interface ToolCallEventResult {
    block?: boolean;
    reason?: string;
    terminate?: boolean;   // "the agent should stop after the current tool batch when this call is blocked"
}
```

And `tool_call` is dispatched from `agent.beforeToolCall`
(`dist/core/agent-session.js:224-241`) — once per tool call, **inside** the loop. That is
precisely the mid-turn seam `_checkCompaction` does not have.

### Recommended shape: manufacture the boundary, do not compact mid-flight

Two options exist and they are not equivalent.

- **Block and terminate (preferred).** When `getContextUsage()` crosses the threshold,
  return `{ block: true, terminate: true, reason: "..." }`. The agent stops after the
  current batch, the turn ends, and pi's *existing* `_handlePostAgentRun` ->
  `_checkCompaction` runs at a genuine boundary. The hook's whole job is to create the
  boundary pi is already waiting for. No new compaction path and no toolCall/toolResult
  adjacency risk.

  The type comment calls `terminate` a "hint", so the chain was traced rather than
  assumed. In `pi-agent-core/dist/agent-loop.js`: a blocked call carries `terminate`
  onto its error result (line 421), `shouldTerminateToolBatch` requires every finalized
  call in the batch to set it (line 378), and the result drives the loop's own
  continuation flag — `hasMoreToolCalls = !executedToolBatch.terminate;` (line 125).
  A terminated batch therefore exits the `while` loop, `agent.prompt()` returns, and the
  boundary check runs. It is the loop condition itself, not advisory.

  Corroborating evidence from Part 2 above: entry 384 ended that turn with
  `stopReason: error` and compaction still ran at entry 386. The boundary machinery
  fires on ugly turn endings, not only on clean `stop`s.
- **Call `ctx.compact()` directly.** It is available, but that is compaction while a tool
  loop is mid-flight — the same safety question that has upstream's four fix branches
  blocked on the #7253 regression. Not the first thing to reach for.

### Caveats that must be handled

1. `terminate` only takes effect if **every** finalized tool result in the batch sets it
   (`shouldTerminateToolBatch`, `agent-loop.js:378`). Block unconditionally while over
   threshold; do not cherry-pick one call out of a parallel batch, or the batch keeps
   going and the next round-trip happens at an even higher token count.
2. `getContextUsage()` returns `tokens: null` after a compaction until an assistant has
   responded post-compaction. Treat `null` as "unknown, do not block" — blocking on `null`
   would wedge the first tool call after every compaction.
3. The hook only fires when a tool call happens. A turn that grows through one enormous
   assistant message would slip past it. Not the failure mode here (39 reads, 55 bash
   calls), but it is not total coverage.
4. Where it loads matters. Subagent children no longer load context-mode (D-020 in
   `context_mode_fork`); a threshold hook would be a separate extension and would load in
   children unless deliberately guarded. Decide that explicitly.
5. It does not re-add the proactive compaction 0.17.0 removed, because it does not compact
   — it ends a turn. And being a local extension, it does not depend on #6879 landing.

### Non-fix: raising the window again

434,685 input tokens were served without a provider error, so there is no overflow error for
Case 1 to react to, and raising `contextWindow` past 350,000 only pushes the boundary check
further out. Until the hook exists, the only levers that work are reducing per-turn growth:
keep 50KB minified bundles out of `read`, and split a "do all 5" instruction into five
prompts so each one returns to a boundary where compaction can run.

## Built: `pi-context-guard`

The `tool_call` hook above now exists at `F:\explore\pi-context-guard` (plain ESM, no build
step, so no package update can revert it) and is registered in `~/.pi/agent/settings.json`
`packages`. Backup of that file: `settings.json.bak-pre-context-guard`.

It fires on pi's exact condition rather than a chosen percentage. Picking a percentage was
the trap: at a 350,000 window with `reserveTokens: 40000`, pi's threshold is 310,000
(88.57%), so a guard set to 87% would end the turn at 304,500, pi would decline to compact,
and every following tool call would be blocked with nothing to relieve it — an unrecoverable
stall, strictly worse than the overshoot. The guard therefore uses
`contextTokens > contextWindow - reserveTokens` on `calculateContextTokens` of the last
assistant usage: the same number and the same comparison pi will make at the boundary, so a
fire guarantees a compaction. It also self-calibrates if the window override or reserve
changes.

Note it reads that usage from `message_end` rather than from `ctx.getContextUsage()`, which
returns `estimateContextTokens` — real usage *plus* an estimate of trailing messages.
Reading higher than pi does is the direction that causes the stall.

Verified against pi 0.84.1 / `gpt-5.6-sol` / 350,000 window:

- Fires and blocks, threshold forced low:
  `block tool=bash tokens=6621 threshold=1000 window=350000 attempt=1`. The command did not
  execute, no second attempt followed, the turn ended.
- Silent under the real 40,000 reserve: guard loaded, tracked usage, blocked nothing.
- Loads cleanly in a full-discovery session alongside every other configured extension.
- **Not reproduced in the harness:** the compaction that follows. A ~6,000-token session has
  nothing for `prepareCompaction` to cut, and a control run with the guard removed also
  produced no compaction, which rules the guard out as the cause. That link rests on the code
  trace above plus the two real sessions in this document where compaction did fire at a
  boundary. To close it empirically, fork a session already past 310,000 tokens into a
  scratch `--session-dir` and send one prompt.

### Review round: three defects the first version had

An adversarial review against the pi source found three real problems, two of which the
initial testing could not have caught. Recorded because each is a trap anyone reimplementing
this would hit.

1. **Attempts were counted per tool call, not per turn.** On a three-wide parallel batch the
   third call hit the budget and failed open — and because `shouldTerminateToolBatch` requires
   *every* finalized call to carry `terminate`, the turn then did not end at all. No
   compaction, budget spent, guard silently dead for the rest of the session, in exactly the
   scenario it exists for. The first test used a single tool call, so it passed. Fixed: once
   the guard blocks any call in a run it blocks all of them, and the stand-down decision is
   taken only before a run's first block. Verified with a three-call batch: 3 issued, 3
   blocked, **0 executed**, one attempt counted, one assistant message — the loop exited.

2. **Nothing resumed the session after a guard-triggered compaction.** The threshold path
   returns `agent.hasQueuedMessages()`, and the only other queuer is pi-subagents, gated on
   active async work *and* `hasUI`. A plain long tool-calling turn — the case this guard is
   for — has neither, so it would compact and then sit idle mid-task. The earlier note in this
   document that the session "carries on" was wrong for that case. Fixed: the guard queues its
   own resume from `session_compact`.

3. **A stale flag could kill a user's typed prompt.** If the guard ended a turn and the
   following compaction *declined*, the "our block caused this" flag survived the run. The next
   compaction could then be the pre-prompt one at `agent-session.js:865`, which runs while no
   run is active — so queuing a resume there started a whole new run that raced the user's
   just-typed prompt for `activeRun`, and either could lose. Fixed by clearing the flag on
   `agent_settled`, which fires in `_runAgentPrompt`'s `finally` after the entire post-run loop:
   legitimate compactions still see it, runs that end without compacting clear it.

Also corrected: the guard is **off inside pi-subagents children** by default. A child runs
`pi -p` with no user and no async jobs, so a guard-ended child turn would exit 0 with partial
output that pi-subagents reports to the parent as a completed result — context pressure
silently becoming a truncated answer, which is worse than the overflow. Opt in with
`PI_CONTEXT_GUARD_IN_SUBAGENTS=1` once the resume is proven there.

The remaining unverified link is unchanged: the compaction that follows a block, and therefore
the resume. See `F:\explore\pi-context-guard\README.md` for the full design rationale, known
gaps, and the fork-a-large-session recipe that would close it.

### Production outcome (2026-08-19): the overshoot is bounded

The guard has now run in real sessions, which closed the one link the harness could not test.
Three sessions, 13 blocks, **every block followed by a compaction**, zero stand-downs.

The case that matters, in the same session class that produced the 434,855-token turn recorded
above:

| time | event | tokens |
|---|---|---|
| 04:19:39 | guard block | 310,679 (threshold 310,000) |
| 04:19:48 | assistant, `stop`, no tool calls | 311,092 |
| 04:21:16 | compaction | `tokensBefore=311092` |

**311,092 instead of 434,855.** One round-trip of overshoot rather than 124,855 tokens of it.

Two things worth recording from the diagnosis:

1. **An apparent "resume gap" was a counting error, not a defect.** Only one
   `context-guard-resume` appeared against 13 blocks, which looked broken. It is the wrong
   unit: ten of those blocks came from the pre-fix build (identifiable by its different reason
   text, and present because extensions reload live — the same session shows five pre-fix
   blocks then three post-fix ones), and the three post-fix blocks were a *single batch of
   three calls*, which correctly produced one turn-end, one compaction, one resume, and then an
   assistant message re-issuing three tool calls. Blocked calls are not turn-ends.
2. **`terminate` clearing `hasMoreToolCalls` is not sufficient by itself.** The inner loop
   condition is `hasMoreToolCalls || pendingMessages.length > 0` (`agent-loop.js:88`) and line
   160 re-polls `getSteeringMessages()` every iteration, so a message queued by any other
   extension during the blocked batch grants one more assistant response. With no other
   extensions loaded a terminated batch produces zero trailing messages; with the full set,
   every observed block was followed by exactly one `stop`/no-tool-call message before
   compaction, costing roughly 400 tokens. It converges in one round-trip because the guard
   blocks the next batch too, but the turn ends partly on the model reading the blocked reason
   rather than purely on `terminate`.
