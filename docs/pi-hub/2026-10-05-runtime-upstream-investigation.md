# Pi Hub runtime and upstream investigation

Date: 2026-10-05. Workspace: `F:\explore\pi-hub`.

Status: investigation complete. This is a source- and test-backed decision report, not certification that an upgraded runtime has passed live workflows.

## Executive conclusion

Keep your product fork, pause feature work, and run an isolated embedded-Pi 1.0.3 modernization pilot using current pi-web as the runtime reference. Do not blindly merge both upstreams or promote the terminal experiment.

The strongest findings are concrete:

- Current pi-web is already on Pi 1.0.0 with code-mode-aware event handling. Current upstream pi-hub remains on 0.85.1.
- A dependency bump alone will not load the CLI's built-in code-mode/MCP factories in Hub's SDK sessions.
- The all-tools-off implementation writes a system-prompt field that becomes getter-only in Pi 1.0.3. That is a real upgrade break requiring a code change.
- Hub reconstructs displayed context from raw entries, while newer Pi can edit model context through persisted `context_edit` entries. The UI/context provenance contract needs updating.
- Canonical-path tests are 854 passed, 7 failed, 3 skipped. Most of the earlier 24 failures were invocation artifacts, not a broken application.
- The existing RPC experiment uses old bundled Pi, lacks feature parity, and cannot guarantee hard termination while waiting on a hung abort.

The next approval should be for a narrowly scoped compatibility candidate, not a full rewrite or production upgrade.

## Purpose and authority

Decide whether to continue this fork, synchronize with either upstream, upgrade the embedded Pi runtime, or change the execution backend. Marcus requested investigation and a Markdown document, not implementation.

No source fixes, dependency installations in project checkouts, merges, branches, commits, pushes, builds, service restarts, scheduler mutations, model requests, or credential changes were authorized or performed by the coordinator. Tests used temporary files. A timed-out coordinator-owned ESLint process was stopped after its exact command and parent PID were identified. The requested report is the only intended project-file addition.

## Verified local snapshot

| Item | Evidence |
|---|---|
| Main checkout | `ad722997a8f9ab4d638249ba83c94885c667e0eb`, branch `main` |
| Personal fork's live main | `4d6b426fc6`, verified through GitHub PR Broker |
| Unpushed commits | `f51291f`, atomic model-config replacement retries; `ad72299`, context overshoot incident documentation |
| Working tree before report | 33 modified tracked files, 20 untracked entries |
| Tracked diff | 3,431 insertions, 1,617 deletions across 33 files; lockfile accounts for 2,162 additions and 1,355 deletions |
| Package | `@marcusneufeldt/pi-hub` version `0.8.7`; not proof of an up-to-date Pi runtime |
| Embedded Pi packages | `pi-coding-agent`, `pi-agent-core`, `pi-ai`, `pi-tui` all installed and declared at `0.85.1` |
| Committed package declarations | Pi packages `0.84.0`; the `0.85.1` dependency update is uncommitted |
| Global Pi CLI | `pi --version` returned `0.99.1` |
| Published Pi target | `npm view @earendil-works/pi-coding-agent version --json` returned `1.0.3` |
| Node and npm | Node `v24.18.0`, npm `11.16.0` |
| Service | No listener on port 30141; HTTP probe returned status `000` |
| Windows scheduler | `pi-hub server` and `pi-hub watchdog` both `Disabled`; cause of disablement was not investigated |
| Existing build | `.next/BUILD_ID` last modified 2026-09-14; no build run |

The embedded runtime, global CLI, published runtime, source HEAD, dirty source, and existing production build are separate versioned things. Updating the global CLI does not update Hub's embedded SDK. An old build timestamp alone does not establish which source changes it contains.

### Lineage and local references

Configured remotes:

- `upstream`: `https://github.com/agegr/pi-web.git`; push disabled.
- `origin`: `https://github.com/jiangliuhong/pi-hub.git`.
- `fork`: `git@github.com:MarcusNeufeldt/pi-hub.git`.

`AGENTS.local.md` explicitly defines a long-term pi-web fork, with isolated Hub modules, one shared agent execution path, and minimal upstream modifications.

Cached tracking refs are stale. Against cached `origin/main` at `85d753f`, local HEAD has 153 exclusive commits and origin has 30. Against cached `upstream/main` at `0877bff`, local HEAD has 163 exclusive commits and upstream has 71. These are cached historical counts, not current live divergence or a prediction of merge conflicts. Shared merge bases are `31577d5` with cached pi-hub and `07f873c` with cached pi-web. No fetch changed this checkout's refs during the coordinator investigation.

Other worktrees remain intact:

- `feat/beautiful-ui` at `6fbb799`.
- `feat/relay-desk` at `414f05f`.
- `experiment/terminal-pi` at `a94e021`, in `F:\explore\pi-hub-terminal-pi`.

The terminal experiment descends directly from main HEAD and contains seven subsequent commits. It is not merged into main. The separate feature worktrees should not be treated as current main capabilities without checking their ancestry and diff.

## Your additions worth preserving

Commit history shows substantial work beyond the inherited session browser and chat:

- Shared design tokens, a redesigned transcript/composer/sidebar, and split chat panes.
- Live subagent cards, process liveness, detached child wakeups, transcript links, and completion notices.
- Session search with optional model-assisted selection, automatic naming, and history no longer included in compacted model context.
- Scheduling, manual execution, run history, hourly schedules, and resumed runs.
- OpenRouter provider routing and pricing, plus Codex quota display.
- Voice input, speech output caching, and per-turn diffs.
- Stop feedback, abort deadlines, and per-session force reset.
- Windows deployment, background-server, and watchdog work.

Examples include `ae4d614` for split panes, `ae54cbf`/`2adab56` for provider routing, `16f3f28`/`31d225a` for session search, `4f8661d` for wedged-turn recovery, and `4d6b426` for compacted history display. This is a meaningful product fork, not a trivial rebranding that should be discarded without a feature comparison.

### Uncommitted work is several independent changes

The dirty tree is not simply an SDK bump. Its changes include:

1. SDK dependency update and Windows build wrapper.
2. SSE availability subscriptions that observe sessions without booting extensions on reconnect, plus multiple destroy callbacks.
3. Busy-state navigation guards, stale context-request protection, and restoration of user drafts with images.
4. Session listing through a separate indexer process and persisted cache.
5. Minute-based scheduling, deterministic preflight commands, default-tool semantics, cancellation propagation, stale-run recovery, startup/result/shutdown deadlines, and a watchdog.
6. File-response security and persisted-tool-result provenance checks.
7. Deployment/server/watchdog scripts and regression tests.

Classify and preserve these separately before attempting a merge. Neither `HEAD` nor an upstream merge contains the complete current local implementation.

## Local validation and corrected failure interpretation

### Commands and results

| Check | Result | Interpretation |
|---|---|---|
| `npm test` from lowercase `f:\explore\pi-hub` | 864 tests; 837 pass, 24 fail, 3 skipped | Misleading baseline because of Windows path casing |
| Same `npm test` after PowerShell `Set-Location 'F:\explore\pi-hub'` | 864 tests; **854 pass, 7 fail, 3 skipped** | Canonical-path baseline to use going forward |
| `node --experimental-strip-types --test bin/pi-hub-session-indexer.test.mjs` | 2 pass | Not included in main's npm test globs |
| `tsc --noEmit --incremental false` | 28 errors | Same count after canonical-path recheck |
| `npm run lint` | Timed out after 100 seconds | Traversed generated deployment rollback builds; no verdict |
| Source-only ESLint over `app components hooks lib modules scripts bin instrumentation.ts next.config.ts proxy.ts` | 3 errors, 29 warnings | Errors are CommonJS `require()` imports in `scripts/next-build.cjs` |
| Terminal experiment `lib/cli-rpc-manager.test.mjs` | 4 pass | Mock/unit coverage, not live Pi 1.0.3 validation |
| Terminal shutdown mock with hung abort | `client.stop()` never reached after 40 ms | Confirms shutdown depends on abort resolving; no real session spawned |

### Seventeen initial failures were path-sensitive

Sixteen UI tests failed at React `useState` in `I18nProvider`, across ChatInput, MermaidBlock, and MessageView. One test compared `F:\explore\pi-hub` with `f:\explore\pi-hub` using strict equality. Running the identical full suite from the canonical uppercase drive path removes all 17 failures without editing code.

This is strong evidence of test-loader/module identity and path-normalization sensitivity, not 17 confirmed application regressions. The specific internals of Jiti's React duplication were not independently instrumented. Keep path casing consistent before interpreting future test results.

### The seven remaining failures

| Count | Failure class | Evidence and disposition |
|---|---|---|
| 2 | Symlink permission failures | directory-browser test and Telegram escape-root test report Windows `EPERM`; environment constraint |
| 1 | POSIX permission assertion | Telegram secret store expects `0600`, NTFS reports `0666`; platform-specific assertion |
| 3 | Telegram local file path validation | `modules/telegram/telegram-config.ts:205-213` accepts absolute roots only if they start with `/`, rejecting Windows drive paths; real Windows portability problem in optional transport code |
| 1 | Stale watchdog source test | Test expects two distinct probes; script now loops over four consecutive probes and validates the port owner; update expectation if retaining script, not evidence by itself that watchdog restart logic fails |

Telegram was not configured, exercised against its API, or changed. These findings came from repository validation and source inspection only. `AGENTS.md`'s old claim of exactly six expected Windows failures is not an accurate current baseline.

### Type errors are broader than the runtime wrapper

Diagnostic distribution:

- 15 in `modules/telegram`: SQLite row casts and bigint return types, locale typing, missing `./transport`, runner argument/type mismatches.
- 1 in generated `.next` Telegram config route types.
- 1 in `lib/telegram-client.ts`.
- 4 in `hooks/useAgentSession.ts`: `asyncDir` and `runId` not declared on the narrowed event-detail shape.
- 4 in `lib/search/*`: `.ts` imports without `allowImportingTsExtensions`.
- 1 in session search: `"off"` does not satisfy the installed thinking-level type.
- 1 in `lib/session-changes.ts`: `AgentMessage.id` assumption.
- 1 in `lib/stt.ts`: Buffer versus BlobPart typing.

`next.config.ts` explicitly sets `typescript.ignoreBuildErrors: true`. A production build succeeding therefore would not prove SDK compatibility or type safety. No isolated pristine HEAD plus pristine HEAD dependencies comparison was run, so this investigation does not attribute every error to the dirty diff.

## Current execution architecture and maintenance cost

`lib/rpc-manager.ts` is an in-process wrapper despite its name. It constructs services with `createAgentSessionServices()`, creates an AgentSession with `createAgentSessionFromServices()`, and owns its registry in `globalThis`. Current source is 1,396 lines. The chat hook is 3,047 lines.

The wrapper also translates SDK behavior into Hub commands and SSE, binds extensions in RPC mode, emulates terminal/custom UI, tracks extension statuses/widgets, handles settings and models, merges extension tools into selected coding presets, and manages idle cleanup and subagent liveness.

Important boundaries:

- `lib/rpc-manager.ts:122-132,1297-1366`: explicit empty tools means all off; nonempty presets keep extension tools available. The builtin coding-name list is hardcoded. New builtin tools and native code-mode presentation need deliberate compatibility checks.
- `lib/rpc-manager.ts:208-270`: asynchronous extension binding must finish before relevant commands. A provider version bump does not remove extension startup failures.
- `lib/rpc-manager.ts:680-723`: force destruction is synchronous and calls SDK `dispose()`; orderly shutdown awaits extension binding and `session_shutdown` hooks. Those are different recovery guarantees.
- Installed `0.85.1` SDK `dist/core/agent-session.js:584-599`: disposal aborts supported activity, invalidates extension context, disconnects event listeners, and cleans session resources. It does not create an OS process boundary capable of killing arbitrary stuck code.
- `modules/scheduler/scheduler-runtime.ts:625-647`: scheduler execution routes through this same embedded wrapper. Its resume guard also checks that registry. Replacing only interactive chat would create a second execution path and inconsistent session ownership.
- `modules/scheduler/prompt-run-waiter.ts`: completion waits for wrapper `prompt_done`, not first `agent_end`. Timeout or external cancel sends abort but does not await it. Unattended interactive requests are cancelled rather than waiting for a human.
- `modules/scheduler/pi-task-executor.ts:78-99,296-302,391-398`: deadline wrappers bound the waiting caller. Rejecting a promise on deadline does not itself terminate the underlying operation. A failed task row is not proof all tools or side effects have stopped.
- `lib/session-reader.ts:42-43`: new Hub index cache is written under `getAgentDir()`, while `AGENTS.local.md` section 8 says Hub-specific persistence should use `~/.pi/hub`. Resolve that boundary before adopting this local addition as permanent architecture.

Your runtime risk is concentrated in a large compatibility layer and its extension interactions. The scheduler module itself already follows the sensible principle of reusing one execution service.

## Historical incidents and attribution limits

Read source-of-truth incident documents rather than treating all symptoms as generic Pi runtime bugs:

- `docs/pi-hub/incident-2026-08-12-wedged-turn.md`: a long tool wait and hanging abort led to a server restart. The document later corrects its first phase-label premise and notes uncertainty about whether dispatch happened. Per-session force reset and abort feedback were subsequently added. It does not prove a current 1.0.3 defect, or conclusively assign the fault to core Pi rather than a tool extension/transport.
- `docs/pi-hub/incident-2026-08-18-compaction-overshoot.md`: distinguishes Pi's compaction boundary from pi-subagents result-discovery problems, and records an external `pi-context-guard` extension that bounded real overshoots. These are historical outcomes on older runtimes. The guard and extension package versions require compatibility review, not automatic reapplication or removal.
- Current watchdog source comments record whole-server restarts interrupting healthy rename work and explain the change from two to four failed probes. Those comments are historical evidence, not a new live reproduction.

Upgrading can remove obsolete workarounds, but only after verifying the corresponding upstream behavior and the external extensions that still depend on them.

## Terminal-Pi experiment assessment

Ref: `experiment/terminal-pi` at `a94e021`. The last commit adds the optional subprocess-RPC path; the branch also adds a terminal server, xterm UI, websocket authentication, voice input, and native dependencies. Whole branch versus main HEAD: 35 files changed, 2,120 insertions, 142 deletions. Last RPC commit alone: 12 files changed, 642 insertions, 27 deletions.

### What it proves

- Uses official SDK `RpcClient` and resumes an existing session.
- `app/api/agent/[id]/cli-rpc/route.ts` checks session ownership, rejects an active embedded turn, and destroys an idle embedded wrapper before switching.
- Tracks prompt completion on `agent_settled`; reconstructs cumulative text from streaming deltas.
- Four focused tests cover reconstruction, settlement, explicit fork rejection, and recognizing a process-exit error.

### What it does not prove

1. **Not the global CLI runtime.** `startCliRpcSession()` passes `join(getPackageDir(), 'dist', 'cli.js')`. This starts the branch's bundled Pi `0.84.0`, not global Pi `0.99.1` or published `1.0.3`. Both its installed dependency and package declaration are `0.84.0`.
2. **Feature parity is absent.** It rejects fork, tool selection, reload, tree navigation, queue clear, compaction abort, and extension UI response/input. `get_tools` returns an empty array. Context usage is null, extension statuses/widgets are empty.
3. **Unattended and interactive ownership remain separate.** The branch does not migrate scheduler execution to this backend. A production migration needs one shared selection/ownership policy across all entry points.
4. **Hard shutdown is not yet hard.** `shutdown()` awaits cooperative `client.abort()` before calling `client.stop()` when the session is running. A mocked abort that never resolves confirms stop is not reached. A production isolated backend needs a bounded graceful stop and an independent force-termination path.
5. **No live compatibility proof.** Tests are mocks and execute against old dependencies. No model, extension, MCP, reconnect, branch, or scheduler roundtrip against 1.0.3 was run.

Subprocess isolation is worth evaluating for fault containment. Merging this entire terminal branch is not the same as implementing a minimal supervised RPC backend, and is not justified by four passing unit tests.

## Evidence files

Temporary coordinator logs, available on this machine but not permanent report dependencies:

- `%TEMP%/pi-hub-test-status.log`: initial lowercase-path tests.
- `%TEMP%/pi-hub-canonical-full-tests.log`: canonical-path full suite.
- `%TEMP%/pi-hub-additional-checks.log`: indexer tests and canonical-path typecheck.
- `%TEMP%/pi-hub-tsc-status.log`: initial complete TypeScript diagnostics.
- `%TEMP%/pi-hub-lint-investigation.log`: timed-out lint scanning rollback builds.
- `%TEMP%/pi-hub-lint-source.log`: completed source-only ESLint.
- `%TEMP%/pi-hub-cli-rpc-test.log`: terminal experiment focused tests.

Dirty-source blob identities captured without staging: `lib/rpc-manager.ts` `dfa25db1c158b09cdbd770a6519845dc5524849d`; `hooks/useAgentSession.ts` `17995dca9dac2ced2d5f1d3c1e242e840f958abe`; `package-lock.json` `66fe5b5ca80edd0d06824b72dd5d97368052ae93`.

## Current upstream comparison

GitHub PR Broker verified live branch tips and supplied pinned source. The coordinator independently read both pinned package manifests and pi-web's event-wire implementation.

| Item | agegr/pi-web | jiangliuhong/pi-hub |
|---|---|---|
| Main tip | `6fcd7d4498`, release commit dated October 2 | `fc51762d3e`, merge dated September 9 |
| Package | `@agegr/pi-web` `0.10.0` | `@jarome/pi-hub` `0.0.12` |
| Pi packages | `1.0.0` | `0.85.1` |
| Next | `16.3.6` | `16.3.1` |
| Execution | In-process AgentSession wrapper | Same foundation with additional server-side subagent integration |
| Hub domain modules | No `modules/` directory found at inspected ref | Scheduler, agent-execution, Telegram |
| Native code-mode integration | Code-mode settings/view files and MCP/tool-exposure integration | No matching code-mode implementation found in bounded searches |
| Terminal subsystem | xterm, node-pty, terminal postinstall preparation | Also inherited terminal subsystem |
| CI evidence from investigator | Tip-time CI run `37037410474` successful; later run `37093963990` requires action | CI `34317869316` and publish `34317869222` successful |

The exact CI workflow job/step coverage was not independently audited by the coordinator. Green remote CI is not a Windows/local-extension compatibility guarantee. Search absence is bounded evidence, not proof that no equivalent behavior exists anywhere.

The upstream investigator found at least 60 pi-web commits in two bounded post-August query windows, including releases 0.9.0 and 0.10.0. Pi-hub's September work includes a pi-web sync through `2e914db`, regression repairs, subagent runtime work, and lockfile registry hygiene. Counting those own commits is not the complete imported upstream change count. Pi-hub's September sync could still provide useful fixes, but it does not bring this fork to Pi 1.x or code mode.

### Actual runtime changes to study in pi-web

Pinned `lib/agent-event-wire.ts` establishes concrete changes beyond a package version bump:

- Filters `entry_appended`, which can include large code-mode `store()` entries, as well as turn start/end events.
- Filters transcript system messages carrying prompt/tool schemas introduced in newer Pi versions.
- Projects assistant streaming deltas and extracts tool-call identity/name before stripping partial snapshots.
- Preserves slim nested tool start/end events with `parentToolCallId`; omits nested progress updates and bulky end-result payloads.
- Retains code-mode progress with the newest 200 calls and an omitted-call count, bounding repeated snapshot growth.

Our current `app/api/agent/[id]/events/route.ts:5-25` instead drops all non-subagent tool updates, strips `assistantMessageEvent` from message updates, and does not filter `entry_appended` or system message events. That is a specific compatibility gap for code-mode progress and newer transcript/wire behavior. Adopt a matching server/client contract, not just a new SDK and a randomly selected streaming helper.

Additional upstream changes found by the investigator include runtime-session cleanup (`ed7a4d71d5`), random UUID manual-code auth handshake tokens (`47a0bb2f8f`), MCP late-transport/command-wait hardening (`5d4c0b543a`), and SDK upgrade (`e77a4e55cf`). These are investigation candidates, not approved cherry-picks. MCP-specific fixes may depend on a native MCP integration different from our adapter setup; verify applicability first.

Pi-web continues to use an embedded SDK. Its latest integration is evidence that a maintained embedded approach remains viable, not evidence that every runtime problem requires subprocess RPC.

### Merge cost and evidence boundaries

Main HEAD versus the historical pi-hub merge base `31577d5` changes **168 files, with 22,906 insertions and 2,812 deletions**, including docs and other files. Core directories `lib`, `components`, `app`, `hooks`, `modules` alone change 150 files, with 19,585 insertions and 2,419 deletions. These are actual local Git stats, independent of the additional dirty diff. Do not add file counts from directory-specific stats because they can describe overlapping or differently bounded sets.

Hotspots are `lib/rpc-manager.ts`, the chat hook/components, agent/SSE routes, dependency manifests, and upstream instruction/doc layout. Both upstream wrappers have grown substantially. Pi-hub additionally imports its own server-side subagent helpers into the wrapper, while ours carries our installed pi-subagents integration and custom monitoring/recovery. That is overlapping ownership which a mechanical merge cannot decide correctly.

No actual merge dry run, freshly fetched live merge base, or conflict count was produced. Broker cross-repo compare was insufficient for exact ancestry. Some commits present locally are absent from cached upstream refs; stale refs do not establish a history rewrite, squash, or origin from a particular feature branch. The investigator's stronger explanation was not adopted.

The investigator also misidentified local `AGENTS.md` as Personal Life OS guidance. The coordinator reread the actual file: it is the Pi Hub development notes, has no working-tree diff, and should remain preserved under `AGENTS.local.md`'s policy. No recommendation in this report relies on that misidentification.

### Primary upstream conclusion

Use **agegr/pi-web as the primary runtime/UI compatibility reference**. It is already on Pi 1.0.0 and has the relevant code-mode/MCP/wire work. Use jiangliuhong/pi-hub as a secondary source for Hub-domain and packaging fixes. Do not merge pi-hub first just because its package name matches ours: that adds another integration step and still leaves the 1.x migration outstanding.

Pinned sources:

- [pi-web package manifest](https://github.com/agegr/pi-web/blob/6fcd7d4498/package.json).
- [pi-web agent event wire](https://github.com/agegr/pi-web/blob/6fcd7d4498/lib/agent-event-wire.ts).
- [pi-web runtime wrapper](https://github.com/agegr/pi-web/blob/6fcd7d4498/lib/rpc-manager.ts).
- [pi-hub package manifest](https://github.com/jiangliuhong/pi-hub/blob/fc51762d3e/package.json).
- [pi-hub runtime wrapper](https://github.com/jiangliuhong/pi-hub/blob/fc51762d3e/lib/rpc-manager.ts).

## Pi 1.0.3 source findings verified by the coordinator

Official versioned npm tarball metadata declares `@earendil-works/pi-coding-agent` version `1.0.3`, with runtime sibling dependencies including `pi-agent-core`, `pi-ai`, `pi-tui`, new `pi-codemode`, and `pi-mcp`. These are package/source checks, not a project installation or live compatibility test.

### The SDK entry points survive

The official tarball still exports `createAgentSessionServices`, `createAgentSessionFromServices`, `RpcClient`, `createCodemodeExtension`, and `createMcpExtension`. AgentSession declarations still expose `bindExtensions`, `getAllTools`, `getActiveToolNames`, and `setActiveToolsByName`. The constructor/services options still support a resource loader, settings manager, model runtime, explicit tool names, and project reload options.

This rules out a premise that the whole embedded architecture must be discarded because its main entry points disappeared. It does not establish compatibility of every structural type, provider implementation, extension hook, UI binding, or internal access in this fork.

### CLI code mode is not automatic SDK code mode

Concrete source trace in the 1.0.3 tarball:

1. `dist/extensions/index.js` declares built-in factories for `llama.cpp`, `codemode`, `tool-search`, and `mcp`, with the latter three replaceable by existing extension registrations.
2. `dist/core/resource-loader.js:239-251` uses `options.extensionFactories ?? []`. Without factories, the loader has no built-in factory map to discover.
3. `dist/core/agent-session-services.js:53-69` passes `resourceLoaderOptions` into `DefaultResourceLoader`, but does not itself add the CLI's built-in factories.
4. Current Hub `lib/rpc-manager.ts:1316-1320` supplies cwd, agent directory, and trust reload options, not built-in factories.
5. `dist/extensions/codemode/index.js` explicitly documents that the CLI loads it as a built-in and SDK users pass the factory to their resource loader. The tool is registered with `defaultActive: false`; activation is explicit, via selected tools/settings or MCP integration.

Therefore: update the SDK, choose the desired built-in factories deliberately, and preserve trust/disabled-tool semantics. Do not assume that installing 1.0.3 creates parity with a Pi CLI session.

### Tool exposure is now an integration contract

`dist/core/extensions/types.d.ts:375-423` distinguishes the tools declared to the model from tools callable through nested `ctx.executeTool()`. Exposure can be `direct`, `model-only`, `codemode`, `deferred`, or `hidden`. Nested execution has a parent tool-call identity and its own lifecycle.

Current `withExtensionTools()` adds every registered name outside the hardcoded coding-tool set into the active selection. After adding native factories, this may activate tools that are intentionally inactive or conflict with the chosen code-mode policy. Review presets, dynamic `get_tools`, restricted scheduled tasks, and runtime tool switching as one behavior contract. Tool exposure must not become a permission bypass through nested execution.

The installed MCP adapter is configured and explicit `-builtin:mcp` exists in global extension selection. Native replacement behavior does not justify loading two MCP stacks or removing the adapter blindly. Establish which implementation owns server registration, OAuth/auth persistence, tool schemas, and code-mode exposure. Confirm those behaviors with a no-model startup test before any live tools.

### Runtime versus protocol selection

The package retains both embedded SDK and RPC support. Its executable entry is `dist/bundle/cli.js`, and a `./rpc-entry` export also exists. The unbundled `dist/cli.js` remains present, so the old experiment's path is not conclusively broken by packaging alone. Choose a supported entry deliberately rather than assuming the experiment will use global `pi`.

The old experiment's command omissions are its adapter limitations, not a claim that official RPC has no fork or queue support. A process boundary helps independent termination and per-session fault isolation; it does not automatically fix extension bugs, wire compatibility, child cleanup, concurrency, or scheduler ownership.

Versioned evidence: [npm 1.0.3 package](https://www.npmjs.com/package/@earendil-works/pi-coding-agent/v/1.0.3) and the published npm tarball, inspected in temporary directories `pi-103-inspect` and `pi-hub-coordinator-103`. No tag-to-source Git SHA was independently established; tarball version is the exact source identifier here.

## Recommended direction

**Keep the product fork. Freeze new features. Use pi-web's latest integration as the reference and run a narrow embedded-runtime modernization pilot before choosing a rewrite or subprocess migration.**

Reasons:

- Your UI, task, search, subagent, and recovery work has substantial value.
- Pi-web has already integrated Pi 1.x and code-mode-aware wire behavior using the same embedded foundation.
- Pi-hub's current dependency is still 0.85.1, so merging it first does not solve the main runtime gap.
- The current code remains close enough at the SDK entry points to justify a controlled pilot, but its tool activation and wire behavior need coordinated adaptation.
- The terminal experiment is useful research, not a production-ready replacement.
- Present failures include environment/test and optional-transport issues, not evidence that the entire application is unsalvageable.

### Option comparison

| Option | What it achieves | Main cost/risk | Verdict |
|---|---|---|---|
| Continue adding features on current runtime | Least immediate change | Maintains version gap and growing compatibility debt | Do not choose as default |
| Only bump Pi dependencies to 1.0.3 | New core implementation | No automatic CLI built-ins; presets, wire, extensions and types unverified | Insufficient by itself |
| Merge jiangliuhong main first | September pi-web sync and Hub fixes | Still old Pi; imports competing subagent/runtime changes and terminal dependencies | Optional selected source, not necessary first step |
| Broad merge of both upstreams | Most upstream feature coverage | Multiple ownership conflicts with no measured merge result | Avoid |
| Embedded 1.0.3 pilot informed by pi-web | Modern runtime with existing product preserved | Requires a bounded coordinated compatibility patch and extension validation | Recommended first experiment |
| Fresh pi-web base with selected Hub features reapplied | Cleaner future runtime inheritance | UI/custom-feature reimplementation and product regression risk | Fallback if pilot demonstrates the old integration is costlier to preserve |
| Minimal supervised RPC backend | Independent per-session termination | Full Hub command/event parity, ownership and scheduler migration | Conditional second experiment if fault isolation remains a measured need |

Do not combine a runtime modernization, terminal UI merge, full upstream UI refresh, scheduler redesign, and Next upgrade into one change. Their outcomes would be impossible to attribute cleanly.

## Proposed next steps and acceptance criteria

These are recommendations, not actions performed. Each implementation/deployment step needs Marcus's approval.

### 1. Preserve and classify

- Capture the tracked dirty diff and explicitly selected untracked source files before any integration work. Do not use a blanket `git add .`: backup env files, rollback builds, and unrelated work are present.
- Keep all existing worktrees intact. Decide which uncommitted changes are product requirements, fixes, experiments, or deployment assets.
- Record installed extension versions and configuration references without exposing credentials.
- Use an isolated candidate checkout with canonical Windows path casing and its own test/build outputs. Do not share `.next` with main.

Acceptance: the baseline and each retained change are identifiable; secrets/rollback output are excluded; main remains untouched.

### 2. Establish a clean compatibility baseline

- Fix test invocation/path consistency and identify the seven canonical failures as separate baseline items.
- Include the indexer tests currently excluded by main's npm test globs.
- Separate TypeScript baseline errors from errors introduced by the upgrade; do not accept new failures hidden by `ignoreBuildErrors`.
- Limit ESLint to source or exclude all rollback build trees in the candidate.

Acceptance: repeatable baseline checks and an explicit error inventory, not a claimed green build with suppressed errors.

### 3. Embedded-runtime pilot

- Pin a coherent Pi package set at 1.0.3 in the candidate and inspect lockfile resolutions.
- Study current pi-web startup, event serialization, tools, extension UI, and code-mode/MCP integration as a coordinated reference.
- Explicitly choose builtin factories, tool exposures, MCP ownership, and settings scope. Preserve project trust and all-tools-disabled behavior.
- Keep your existing UI/product behavior unless a specific SDK/wire requirement forces a change.
- Start with no-model initialization and mocked lifecycle tests; use scratch sessions and controlled config roots so real session migrations, credentials, and tasks are not changed.

Acceptance: startup/provider/resource discovery succeeds; no duplicate tools or MCP owners; all-off really disables direct and nested calls; presets remain intentional; no new type errors; payloads and nested progress remain bounded.

### 4. End-to-end behavior matrix

A candidate is not ready until these have evidence. Live provider/tool tests require appropriate authorization and a harmless scratch workspace.

| Behavior | Required evidence |
|---|---|
| Manual chat | Prompt, streaming text, error, completion, queue and reopen behave correctly |
| Code mode | Nested tool calls are observable, correctly parented, bounded, and permission checked; completion/error/cancel are rendered |
| Ordinary tools | Read/edit/write/bash and available platform shell behavior preserve contracts |
| MCP | One chosen stack; discovery, deferred exposure, disconnect, timeout and cancellation do not permanently wedge a turn |
| Subagents | Foreground and async completion, wakeup, reconnect, child liveness and idle cleanup behave correctly |
| Compaction | Manual and automatic compaction, reload, historical context display and context-guard interaction do not truncate or prematurely finish work |
| Navigation | Fork, in-session tree navigation, selected model and explicit startup preferences survive without stale registry identity |
| Extensions | Status/widgets/dialog/custom UI, extension commands, reload and shutdown are supported or explicitly bounded |
| Browser reconnection | Refresh/visibility/network changes reconcile without duplicate prompts, stale running state, or extension startup solely from idle SSE |
| Scheduler | Manual/once/recurring tasks share backend behavior; overlap, resume ownership, timeout, cancellation and restart recovery are correct |
| Isolation/recovery | A hung tool and hung extension hook are recoverable without interrupting unrelated sessions; terminal DB state does not falsely imply execution stopped |
| Storage | Existing session files are not rewritten by test discovery; Hub cache/task state remains scoped appropriately |

### 5. Choose integration versus rebase versus RPC

- If the embedded candidate works with a modest, traceable compatibility patch, retain it and document the new upstream-sync policy.
- If preserving the wrapper requires repeatedly overriding most of upstream's runtime implementation, compare a fresh pi-web base plus a minimal Hub module/UI port. Make this choice on actual diff and passing workflow evidence, not line counts alone.
- If cancellation/extension faults still require killing the entire server, build the smallest shared supervised RPC adapter. Keep chat and scheduling on one backend and prove independent hard termination. Do not merge the terminal UI subsystem merely to obtain a subprocess.

Acceptance: one explicit backend/ownership policy, supported commands documented, no competing session writers, and a reversible candidate with a baseline comparison.

### 6. Deployment later

Build in isolation, test on a separate port, verify that the served build contains the candidate, and prepare rollback before enabling or restarting the currently disabled Windows tasks. Preserve existing disabled state until deployment is explicitly approved. Neither task enablement nor a global CLI update belongs in a read-only investigation.

## Additional compatibility findings and required adaptations

### Confirmed runtime break: mutating the system prompt

Current `lib/rpc-manager.ts:287-288` assigns `this.inner.agent.state.systemPrompt = ""` for all-tools-off sessions. In official pi-agent-core 1.0.3 `dist/agent.js:30-39`, mutable agent state instead exposes a getter-only `systemPrompt` derived from transcript messages. Its type is readonly. Assigning to that property in strict-mode JavaScript throws.

This is a concrete incompatibility on the disabled-tools path, not a hypothetical concern about a major version. The structural types in `lib/pi-types.ts` can conceal the API mismatch from TypeScript, so compiler output alone is insufficient.

`DefaultResourceLoaderOptions.systemPromptOverride` is a supported hook, verified at `dist/core/resource-loader.d.ts:120`. A candidate should use supported prompt construction instead of mutating derived agent state, while preserving tool-mode changes, reloads, settings, and system-prompt inspection. Do not apply an unconditional empty prompt to all sessions merely to make all-off initialization pass.

### Confirmed context-projection gap

Both versions retain session format version 3, but 1.0.3's `SessionEntry` union adds `UsageEntry` and `ContextEditEntry`. A version-3 header is therefore not evidence that all entry semantics are unchanged.

Official `dist/core/session-manager.js:256-284` implements `buildSessionProjection()`: it collects context edits, projects each source entry to its effective messages, preserves provenance, and then builds model context. Current `lib/session-reader.ts:338-373` calls SDK `buildSessionContext()` but uses only its model/thinking metadata; it constructs displayed messages separately from raw `buildContextEntries()` using `entryToUiMessage()`.

Consequences to verify:

- Raw-history display and effective model-context display are different products and should be labelled intentionally.
- Context-edited or removed content must not appear as though it remains in the model's effective context.
- Fork/navigation entry IDs must remain aligned with original provenance after projections produce changed or zero messages.
- Usage-only entries must not be rendered as chat messages, but their accounting must not be mistaken for corruption.

Extend the local entry types and use the supported projection for effective-context views while retaining raw history where deliberately requested. Source proves the gap; a 1.0.3 context-edit fixture should prove the adapted behavior before release.

### Installed MCP adapter compatibility is not established

The coordinator verified installed `pi-mcp-adapter` version **5.0.0**. Its `pi-ai` peer range is `^0.84.1 || ^0.85.0 || ^0.86.0 || ^0.87.0 || ^0.99.0`, which excludes 1.0.x. This establishes an undeclared compatibility target, not proof the adapter is unusable or that npm will always install a second SDK.

Adapter `index.ts:63-64` chooses native MCP capability based on `typeof pi.registerMcpServer === 'function'`. Pi 1.0.3 exports that API even when a particular SDK loader did not include the connecting MCP extension. The investigator traced a native diagnostic for registered servers with no loaded connecting extension. Consequently, a combination of the old adapter, new core API, and no connecting factory is a source-supported startup risk. It was not executed against real servers.

Installed package references also include pi-subagents, pi-web-access, pi-hermes-memory, collaborating-agents, pi-research-loop, pi-codex-goal, local pi-context-guard, pi-claude-bridge, ponytail, and pi-you-should-know. Selection entries include `-builtin:mcp`; the runtime investigator also found `defaultTools: ['+codemode']`. These are configuration facts, not evidence each package loads successfully in Hub. Package declarations and actual versions need a candidate compatibility matrix.

Existing adapter-provided MCP/code-mode functionality must not be described as absent just because native CLI factories are absent. Likewise, SDK settings are not universally ignored: settings can select tools that are actually registered. The narrower verified finding is lack of automatic native factory loading and therefore lack of guaranteed CLI parity.

### Surviving APIs and remaining migration checks

The runtime investigator compared service-factory and extension-binding declarations and found no required call-shape change for Hub's two-stage startup. It also found the methods Hub calls still present on AgentSession, retained root auth-type exports, and current compaction start/end support. The coordinator spot-checked the public exports, relevant session methods and factory path, not every signature.

Other investigator findings to check during the candidate:

- New steer/follow-up handled-versus-queued dispositions are additive and may improve UI acknowledgement.
- New tool output sizes and nested execution can create large SSE payloads if current filters are left unchanged.
- Reported Azure provider rename and MCP name normalization need a conditional configuration/tool-reference sweep if those identifiers are used. No user credentials were inspected or migrated here.
- Hub accesses SessionManager internals such as `flushed`; their continued existence is not a public compatibility guarantee.
- `ModelRuntime`, `SettingsManager`, project-trust reload options, package management, and exact tool-info shapes require field-level verification in the candidate.

The investigator's stale statement that exactly six Windows failures are expected was superseded by the coordinator's canonical full-suite result. Its blanket claim of no MCP in SDK sessions was narrowed as above. No recommendation relies on either claim.

## Completion audit and limitations

Two fresh-context read-only investigators were dispatched: one upstream source lane and one official Pi compatibility lane. The upstream lane completed. The overall workflow hit its 15-minute limit before the runtime lane finished. That same runtime investigator was resumed through the native protocol with a synthesis-only brief and completed. There was no third fresh investigator or unauthorized execution fallback.

The coordinator independently verified:

- Local refs, working tree, installed/package/global versions, published version, service listener and disabled task state.
- Both pinned upstream package manifests and pi-web's event-wire implementation.
- Canonical-path full tests, separate indexer tests, typechecking and source-only lint.
- Terminal experiment source, four focused unit tests, and the mocked hung-abort shutdown behavior.
- Official 1.0.3 SDK exports, resource-loader/factory behavior, code-mode activation, tool-exposure declarations, getter-only agent prompt state, context projection, and installed MCP adapter peer range/capability check.
- Initial upstream worker mistakes about AGENTS, exact stats, stale-ref ancestry explanations, and the runtime worker's overbroad native-versus-adapter statements. These were corrected rather than copied into the recommendation.

Not checked or not proved:

- No live Pi 1.0.3 AgentSession, provider request, MCP connection, extension/subagent roundtrip, scheduler execution, browser interaction, production build, deployment, or service restart.
- No comprehensive pure-HEAD plus original-dependencies baseline, new-branch integration diff, live-ref merge base, actual merge attempt, or exact conflict count.
- No complete field-level SDK surface or every installed extension version audit. Native/adapter cooperation, project trust, compaction guard, and auth/package-management interactions remain candidate gates.
- No exact upstream history-rewrite claim, guaranteed maintenance cadence, guaranteed hard-stop safety, or numerical effort estimate.
- Windows Scheduled Task disablement was observed, not explained or changed.

At completion the tracked diff remains **33 files, +3,431/-1,617**, matching the initial snapshot. Untracked entries increased from 20 to 21 solely for this requested report. Existing worktrees, source modifications, dependencies and disabled scheduled tasks remain intact.

Research reports were retained by the subagent system under workflow `d38beaf3-cbec-439d-9a61-6d207f8f5fe2`, with `research/upstreams.md` and `research/pi-runtime.md`. This document contains the durable conclusions and decision evidence; those scratch reports are not needed to understand the recommendation.

**Decision ready for Marcus:** approve an isolated embedded-runtime compatibility pilot informed by pi-web, while preserving your product fork and keeping production untouched. Rebase or subprocess migration stays a measured fallback, not the starting assumption.
