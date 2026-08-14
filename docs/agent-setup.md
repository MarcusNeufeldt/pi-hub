# Setting up Pi Hub — for an agent

You have just cloned this repository and need a working Pi Hub. Work through the
steps in order. Every step has a **verify** command; do not continue past a step
whose verification fails.

Facts worth knowing before you start:

- **Pi Hub bundles the pi SDK** (`@earendil-works/pi-*`, pinned exactly in
  `package.json`). It never shells out to the `pi` binary. So the global pi CLI
  is not required for the web UI to run — it is required to install extensions
  and to use pi in a terminal.
- **This fork is not published to npm.** Do not run `npx @agegr/pi-web`; that
  installs the upstream project, not this one. Run it from the clone.
- The pi *data* directory (`~/.pi/agent/`) is shared between the CLI and Pi Hub.
  Sessions, model config, and credentials all live there.

---

## 0. Preflight

Node 22.19.0 or newer, required by both pi and Pi Hub.

```bash
node --version
```

If it is older, install a newer Node before continuing. Nothing below will work
on Node 20.

---

## 1. Install the pi CLI

```bash
npm install -g @earendil-works/pi-coding-agent
```

**Verify:**

```bash
pi --version
```

Expect a version string such as `0.84.1`. Version **0.84.1 or newer** is needed
for `pi auth check`, used to verify step 3.

> The package provides the `pi` binary. If `pi` is not found afterwards, your
> global npm bin directory is not on `PATH`; resolve that before continuing.

---

## 2. Install Pi Hub's dependencies

From the repository root:

```bash
npm install
```

**Verify:**

```bash
node -e "console.log(require('./node_modules/@earendil-works/pi-coding-agent/package.json').version)"
```

Expect the version pinned in `package.json` (currently `0.84.0`). This is the
copy the web app actually uses, and it is deliberately independent of the global
CLI version from step 1 — they do not have to match.

---

## 3. Connect a model provider — OpenRouter strongly recommended

Pi Hub is useless without at least one provider. **OpenRouter is the recommended
starting point**, for three concrete reasons:

- One key reaches hundreds of models, so you are not signing up per vendor.
- Pi's remote catalog already carries OpenRouter's model list, so models appear
  in the picker without any manual definition.
- **Session search's model-assisted picking requires it.** That feature calls
  `openrouter/deepseek/deepseek-v4-flash-0731`; without an OpenRouter key the
  search modal still works for name and content matching, but the "Ask the
  model" step is disabled with an explanatory notice.

Get a key at <https://openrouter.ai/keys>, then store it. Either route works and
both write to `~/.pi/agent/auth.json`:

```bash
# From the terminal
pi auth --help          # shows the auth subcommands available in your version
```

Or, once the server is running (step 5), use **Models → OpenRouter → API key** in
the web UI, which is usually easier and needs no CLI.

**Verify:**

```bash
pi auth check --provider openrouter
```

Expect exactly:

```text
ready
```

Add `--json` for machine-readable output if you are parsing it. Anything else
means the key was not stored — check that `~/.pi/agent/auth.json` exists and has
an `openrouter` entry (never print its contents; it holds live secrets).

---

## 4. Install the recommended pi extensions

Extensions are pi packages, installed with `pi install` and recorded in the
`packages` array of `~/.pi/agent/settings.json`. All three below are strongly
recommended: they are what turn pi from a single-file assistant into something
that can use your tools, reach the web, and delegate work.

```bash
pi install pi-mcp-adapter
pi install pi-subagents
pi install pi-web-access
```

| Package | What it gives you |
| --- | --- |
| `pi-mcp-adapter` | MCP (Model Context Protocol) adapter — exposes MCP servers to pi as tools |
| `pi-subagents` | Single-agent delegation and scripted multi-agent workflows |
| `pi-web-access` | Web search, URL fetching, PDF extraction, video understanding. **No API key required** — Exa provides zero-config search. Optional provider keys go in `~/.pi/web-search.json`. |

### Optional: persistent memory

```bash
pi install pi-hermes-memory
```

Gives pi memory that survives across sessions, plus secret scanning. It also
ships session-search tools, which overlap Pi Hub's built-in search — hermes
searches from inside a pi conversation, Pi Hub's modal searches your whole
history from the UI. Install it for the memory, not for search.

**Verify:**

```bash
pi list
```

Output is grouped under `User packages:`, one `npm:<name>@<version>` entry per
package followed by its install path under `~/.pi/agent/npm/node_modules/`. Both
packages should appear.

Use `pi install <source> -l` to scope an install to the current project instead
of globally, and `pi config` to enable or disable individual resources a package
provides.

You can also manage these from Pi Hub's **Plugins** panel, which performs the
same install / remove / update / enable / disable operations through pi's package
manager.

### Optional: MCP servers

`pi-mcp-adapter` only bridges MCP servers; it does not supply any. Server
definitions live in `~/.pi/agent/mcp.json`. Add servers there if you want pi to
reach external tools. This file does not exist by default and Pi Hub runs fine
without it.

---

## 5. Run it

For development, with hot reload:

```bash
npm run dev
```

**Verify:**

```bash
curl -s http://127.0.0.1:30141/api/models | head -c 200
```

Expect JSON containing `modelList`. The `cwd` parameter is optional and defaults
to the server's working directory — do not pass a shell-style path on Windows, it
will not resolve. Then open <http://127.0.0.1:30141>.

For a long-running instance, build first and then serve the build:

```bash
npx next build
npm start
```

> **Use `npx next build`, not `npm run build`.** The `build` script passes
> `--webpack`, which on Windows walks into the `%USERPROFILE%\Application Data`
> junction and dies with `EPERM`. `npx next build` uses Turbopack and does not.
> Note that `npm start` serves the *build output* — it does not watch files, so
> source changes require a rebuild and restart.

See [Always-on server](./pi-hub/always-on-server.md) for running it as a
background service, including the restart sequence.

---

## 6. Confirm the checks pass

```bash
npx tsc --noEmit   # 0 source errors
npm run lint       # exits 0; ~27 warnings are expected and do not gate
npm test           # 777 tests across 111 files
```

**Expect 6 failing tests on Windows.** They are environment-dependent, not a
broken setup:

- 5 in `lib/directory-browser.test.mjs` — creating a symlink needs elevation or
  Developer Mode, so they fail with `EPERM`
- 1 in `modules/telegram/telegram-secret-store.test.mjs` — asserts POSIX file
  mode `0600`, which NTFS reports as `0666`

Everything else should pass. On macOS or Linux all of them should pass.

`npx tsc --noEmit` reports errors only in generated `.next/dev/types/` files
when a dev server has run; source errors are what matter.

---

## Where things live

| Path | Contents |
| --- | --- |
| `~/.pi/agent/sessions/` | Session transcripts, `<encoded-cwd>/<timestamp>_<uuid>.jsonl` |
| `~/.pi/agent/models.json` | Custom providers and per-model overrides |
| `~/.pi/agent/models-store.json` | Cached remote model catalog (managed by pi) |
| `~/.pi/agent/auth.json` | Provider credentials — **never print this** |
| `~/.pi/agent/settings.json` | Default model, installed packages, subagents, skills |
| `~/.pi/agent/mcp.json` | MCP server definitions (optional) |
| `~/.pi/agent/npm/node_modules/` | Where `pi install` puts extension packages |
| `.env.local` | Local-only env for this checkout; gitignored |

Point `PI_CODING_AGENT_DIR` at a different directory to use another pi profile.

---

## Common problems

**Port 30141 already in use.** Something is already serving Pi Hub. Either use
it, or find and stop the owner. On Windows:
`(Get-NetTCPConnection -State Listen -LocalPort 30141).OwningProcess`.

**The model picker is empty.** No provider is connected — go back to step 3.
`GET /api/models` returning `{"modelList":[]}` with no error means credentials,
not code.

**A newly released model is missing from the picker.** Pi's remote catalog lags
the provider by a day or two. Pi Hub refreshes that catalog itself (every four
hours, ETag-validated), so waiting usually fixes it. To use the model
immediately, add a definition under the provider's `models` array in
`models.json`; see
[OpenAI-compatible providers](./pi-hub/openai-compatible-providers.md).

**Sessions do not appear.** Pi Hub reads `~/.pi/agent/sessions/`. If you have
never run pi, there is nothing to browse yet — that is expected, and you can
start a new session from the UI.

**Do not run `next build` while `npm run dev` is running.** They share `.next/`
and will interfere with each other.
