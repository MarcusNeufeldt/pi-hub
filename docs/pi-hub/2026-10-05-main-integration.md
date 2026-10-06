# Pi 1.0.3 integrated into main

Marcus explicitly requested integration into the main app after rejecting the empty UI sandbox.

## Applied

- Applied the independently reviewed runtime/context/streaming upgrade to `F:/explore/pi-hub`, on the existing `main` checkout.
- Patch baseline: preserved current source at `133c327`; imported product and regression-test delta through `f457c69` (product fixes accepted at `985ea0f`). All 21 imported files match the candidate, including after dependency installation.
- All four Pi host dependencies are pinned and installed at 1.0.3. Global Pi was not changed.
- Existing uncommitted work was retained. Unrelated files in the original source manifest still match their original SHA-256 hashes. No reset, stash, branch switch, blanket commit, or push was used.
- Personal environment, model configuration, credentials, history and task data were not copied, cleared or replaced. Normal launch still uses the existing configuration.

## Checked

- Main suite: 886 tests; 876 pass, seven known baseline failures, three skipped. Explicit indexer suite: two pass.
- Scoped ESLint: zero errors, two existing hook dependency warnings. Whitespace check passes.
- Non-incremental typecheck before build: 28 existing diagnostics (27 source diagnostics plus the old generated Telegram route diagnostic). Not a green typecheck.
- Fresh `npx next build`: passes, with existing type validation disabled in next.config.ts and tracing warnings. Build ID: `ZQ_yQH8ENIGTbpaUWA_z1`.
- No main Next dev process was found before the build. Previous `.next` was preserved under `F:/explore/pi-hub-worktrees/pi-1.0.3-artifacts/main-next-before-integration` instead of deleted. Other rollback folders were untouched.
- Build-time Pi/Hub directories were process-local scratch overrides, not personal state directories.

## Runtime boundary

Source, installed dependencies and the production build are updated. This action did not start or restart the normal scheduled service, enable server/watchdog tasks, deploy remotely, or make provider/MCP requests. Both Windows tasks remain disabled. Actual configured provider/MCP execution and browser lifecycle behavior still need a running-app smoke test.

Changes were initially left uncommitted beside the pre-existing work. Marcus subsequently requested a clean main checkout, authorizing a local checkpoint of the combined app source. Deployment/build backups and the private env backup remain on disk and are locally excluded, not committed. Evidence: `main-integration.patch`, install/test/typecheck/lint/build logs under `F:/explore/pi-hub-worktrees/pi-1.0.3-artifacts`.

No new implementation workers were launched for this tightly sequential integration. Parent applied and checksum-verified the already-reviewed delta, installed dependencies, reran checks and built main.

## Subsequent authorized startup

Marcus then explicitly requested starting main. Started the existing `scripts/pi-hub-server.ps1` manually, without enabling scheduled tasks or using scratch state. Main listens on port 30141 (Node PID 70476 at verification time). Root returned HTTP 200. `/api/models`, with normal same-origin request headers, returned HTTP 200, no error, 541 models and a default model. No chat prompt or model/MCP execution was submitted. Open `http://localhost:30141/` on this PC.
