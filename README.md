# Pi Hub

[中文文档](./README.zh-CN.md) | [日本語](./README.ja.md) | [Русский](./README.ru.md)

Local web UI for the [pi coding agent](https://github.com/badlogic/pi-mono). Pi Hub reads your local pi session files and gives you a browser workspace for session browsing, real-time chat, model configuration, skill management, and project file preview.

> **Setting this up with an agent?** Follow **[docs/agent-setup.md](./docs/agent-setup.md)** —
> an ordered, verifiable checklist covering Node, the pi CLI, provider
> credentials, the recommended extensions, and how to run and validate the
> result. It is written to be executed top to bottom.
>
> This fork is **not published to npm**. Run it from a clone; the `npx` commands
> in upstream's README install a different project.

![Pi Web shows the same pi session with structured Markdown, tool calls, and project navigation beside the CLI](https://raw.githubusercontent.com/agegr/pi-web/main/docs/screenshot2.png)

The same pi session in CLI and Pi Web: structured tool calls, readable Markdown, session browsing, and cleaner results.

## Quick Start

Requires **Node.js 22.19.0 or newer** (`node --version`).

```bash
git clone https://github.com/MarcusNeufeldt/pi-hub.git
cd pi-hub
npm install
npm run dev
```

Then open [http://127.0.0.1:30141](http://127.0.0.1:30141). Pi Hub listens on `127.0.0.1` by default.

That gets the UI running. The three sections below are what make it useful.

For a long-running instance, build first and serve the build:

```bash
npx next build   # not `npm run build` — see docs/agent-setup.md
npm start
```

## The pi CLI

Pi Hub bundles the pi SDK, so the UI runs without a global pi install. You still
want the CLI: it is how extensions get installed, and it is pi in a terminal.

```bash
npm install -g @earendil-works/pi-coding-agent
pi --version    # expect 0.84.1 or newer
```

## Model provider — OpenRouter strongly recommended

Pi Hub does nothing useful without at least one provider, and **OpenRouter is the
recommended starting point**:

- One key reaches hundreds of models instead of signing up per vendor.
- Pi's remote catalog already carries OpenRouter's model list, so models show up
  in the picker with nothing to define by hand.
- **Session search's model-assisted picking requires it** — without it, search
  still matches names and content, but the "Ask the model" step is disabled.

Get a key at [openrouter.ai/keys](https://openrouter.ai/keys), then add it under
**Models → OpenRouter → API key** in the UI (easiest), or from the CLI. Verify:

```bash
pi auth check --provider openrouter    # prints: ready
```

## Recommended pi extensions

Extensions are pi packages. These three are what turn pi from a single assistant
into something that can drive your tools, reach the web, and delegate work —
install all three unless you have a reason not to:

```bash
pi install pi-mcp-adapter
pi install pi-subagents
pi install pi-web-access
pi list                    # all three should appear under "User packages:"
```

| Package | What it gives you |
| --- | --- |
| **`pi-mcp-adapter`** | MCP (Model Context Protocol) adapter — exposes your MCP servers to pi as tools. Server definitions live in `~/.pi/agent/mcp.json`; the adapter bridges them, it does not supply any. |
| **`pi-subagents`** | Single-agent delegation and scripted multi-agent workflows, so a session can hand work to child agents. |
| **`pi-web-access`** | Web search, URL fetching, PDF extraction, and video understanding. Works with **no API key** — Exa provides zero-config search — so there is nothing to sign up for. Add keys in `~/.pi/web-search.json` only if you want specific providers. |

**Optional: `pi install pi-hermes-memory`** — persistent memory across sessions,
plus secret scanning. Worth knowing that its session-search tools overlap Pi
Hub's built-in search: hermes gives *pi* search tools inside a conversation,
while Pi Hub's search is the UI modal over your whole session history. Useful
together, but you do not need it for search alone.

Add `-l` to scope an install to the current project instead of globally, and run
`pi config` to enable or disable individual resources a package provides. The
**Plugins** panel in the UI performs the same install / remove / update / enable /
disable operations.

## Options

From a clone, the launcher is `node bin/pi-web.js` — there is no global `pi-web`
binary unless you install this package yourself. It serves the production build,
so run `npx next build` first.

```bash
node bin/pi-web.js --port 8080         # custom port
node bin/pi-web.js --hostname 0.0.0.0  # expose on a trusted network
node bin/pi-web.js -p 8080 -H 0.0.0.0  # combine options
node bin/pi-web.js --no-open           # do not open the browser automatically
```

The same settings can come from the environment, which is what a background
service usually wants:

```bash
PORT=8080                                  # same as --port
PI_WEB_HOSTNAME=0.0.0.0                    # same as --hostname
PI_WEB_NO_OPEN=1                           # same as --no-open
PI_WEB_ALLOWED_HOSTS=pi-hub.internal       # allow an exact proxy/custom hostname
PI_WEB_PASSWORD='a-long-random-password'   # require Basic Auth (username: pi)
```

For development instead, `npm run dev` (127.0.0.1) and `npm run dev:lan`
(0.0.0.0) are the shortcuts.

Set `PI_WEB_PASSWORD` to protect the web interface and every API endpoint with HTTP Basic Auth. The username is always `pi`. Leaving the variable unset or empty disables authentication.

Pi Web can invoke a high-privilege agent. Basic Auth does not encrypt the password in transit, so do not expose plain HTTP to the internet. Use HTTPS through a trusted reverse proxy or a trusted VPN for remote access.
API requests accept loopback names, IP literals, the selected bind hostname, and exact comma-separated names in `PI_WEB_ALLOWED_HOSTS`. Configure that variable when a trusted reverse proxy uses a different external hostname.

## Remote access over Tailscale

Reaching Pi Hub from a phone or another machine on your tailnet. Three settings,
and the first one is a security decision rather than a preference.

**Bind to the tailnet address, not `0.0.0.0`.** Find it with `tailscale ip -4` —
it is a `100.x.y.z` address — and bind to that:

```bash
PI_WEB_HOSTNAME=100.x.y.z    # reachable over the tailnet only
```

`-H 0.0.0.0` also works and is what the flags above describe, but it listens on
*every* interface, including the physical LAN. Pi Hub can run a high-privilege
agent, so anything that can route to that port has close to shell access on the
machine. Binding the tailnet address limits reachability to devices in your
tailnet; `0.0.0.0` does not.

**Using the MagicDNS name instead of the IP? Allow it explicitly.** The API host
gate accepts loopback names and IP literals automatically, but a DNS name is
neither, so requests to `machine.tailnet.ts.net` are rejected until you name it:

```bash
PI_WEB_ALLOWED_HOSTS=machine.tailnet.ts.net
```

**Set a password.** Even on a tailnet, every device you have joined can reach it:

```bash
PI_WEB_PASSWORD='a-long-random-password'    # username is always: pi
```

Put these in `.env.local` rather than a shell, so a background service started by
a different parent process still sees them.

On the plain-HTTP warning above: traffic between tailnet nodes is encrypted by
WireGuard, so Basic Auth inside a tailnet is not the exposed-to-the-internet case
that warning is about. It becomes that case if you publish the port with
Tailscale Funnel or a public reverse proxy — then terminate HTTPS properly.

For the dev server only, `npm run dev` additionally needs the host named in
`PI_WEB_DEV_ORIGINS` (see Notes); `npm start` does not.

## HTTP Proxy

Pi Web reads the standard `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` environment variables for server-side model and API requests.

On macOS or Linux:

```bash
HTTP_PROXY=http://127.0.0.1:7890 \
HTTPS_PROXY=http://127.0.0.1:7890 \
NO_PROXY=localhost,127.0.0.1 \
npx @agegr/pi-web@latest
```

On Windows PowerShell:

```powershell
$env:HTTP_PROXY = "http://127.0.0.1:7890"
$env:HTTPS_PROXY = "http://127.0.0.1:7890"
$env:NO_PROXY = "localhost,127.0.0.1"
npx @agegr/pi-web@latest
```

## Features

- **Find the session you half-remember**: search every conversation by name or content, then optionally have a cheap long-context model read the top candidates and say which one you meant. Ctrl/Cmd+K, or the magnifier in the top bar.
- **Pick work back up**: browse previous pi conversations by project without digging through terminal history or session paths.
- **Work in more than one session at once**: split the chat area into panes, each with its own session, model, and running state.
- **Pin how OpenRouter routes**: choose which upstream providers may serve a model and whether to optimise for throughput or first token, from the composer.
- **Run work on a schedule**: define tasks that start sessions unattended and review their runs from the sidebar.
- **Try different directions safely**: continue from an earlier message or fork a session into a separate route.
- **Work across branches**: switch Git worktrees from the sidebar so new sessions and the Explorer follow the checkout you choose.
- **Chat beside the project**: browse files on the left and preview source, docs, images, audio, and PDFs on the right while the agent works.
- **See session state clearly**: context usage, cost, compaction state, and system prompt details are visible from the top bar.
- **Configure less from the terminal**: manage models, login/API keys, model tests, and skill switches from the web UI.
- **Use the interface in your language**: switch between the supported UI languages from the top bar.

## Notes

- **Local configuration**: put persistent env vars in `.env.local` at the repo root — it is gitignored and Next loads it for both `dev` and `start`. Env vars set only in a shell are lost whenever the server is started by a different parent process, which is the usual reason a setting "stops working" under a background service.
- **Reaching the dev server by hostname**: `allowedDevOrigins` in `next.config.ts` governs who may fetch Next's dev resources. Wildcards match one label at a time, so `*.ts.net` does **not** cover `machine.tailnet.ts.net`; name such a host in full via `PI_WEB_DEV_ORIGINS` (comma-separated) in `.env.local`. Only affects `npm run dev`.
- **Always-on server**: see [Always-on server](./docs/pi-hub/always-on-server.md) for running Pi Hub as a background service and the restart sequence a rebuild needs.
- **Custom and OpenAI-compatible providers**: see [OpenAI-compatible providers](./docs/pi-hub/openai-compatible-providers.md) for adding your own endpoint, and for defining a model pi's catalog does not know yet.
- **Data directory**: Pi Web reads `~/.pi/agent/sessions` by default. Set `PI_CODING_AGENT_DIR` to point at another pi agent directory.
- **Session files**: files are stored as `~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`.
- **Model config**: the Models panel reads and writes `models.json` in the pi agent directory. Model lists and defaults come from pi's config.
- **File access**: file browsing and preview are scoped to the selected project directory and working directories that appear in sessions.
- **Git worktrees**: see [Worktrees in Pi Web](./docs/worktrees.md) for when the switcher appears, how new worktrees are created, and what removal does.
- **Forks vs in-session branches**: Fork creates a new `.jsonl` file. "Edit from here" creates another branch inside the same session file.
- **Internationalization**: see [Internationalization](./docs/i18n.md) for using translations and adding languages or UI text.

## Development

```bash
npm install
npm run dev
```

The local dev server runs at [http://127.0.0.1:30141](http://127.0.0.1:30141).

Common checks:

```bash
node_modules/.bin/tsc --noEmit
npm run lint
```

Avoid running `next build` / `npm run build` during local development. It writes to `.next/` and can interfere with the dev server; leave builds for release work.

## Project Structure

```text
app/
  api/
    agent/          # creates/drives AgentSession and exposes SSE events
    auth/           # OAuth and API key management
    cwd/browse/     # browsable server directory listing
    cwd/validate/   # custom working directory validation
    default-cwd/    # pi default working directory lookup
    files/          # file listing, reading, preview, and watching
    home/           # current user home directory
    models/         # available models, default model, thinking levels
    models-config/  # read/write models.json and test models
    sessions/       # session reads, rename, delete, context, HTML export
    skills/         # skill listing, search, install, enable/disable
components/
  AppShell.tsx        # main layout, URL state, top panels, file tabs
  SessionSidebar.tsx  # project selector, session tree, Explorer
  DirectoryPicker.tsx # browsable and editable working-directory picker
  ChatWindow.tsx      # messages, SSE, image drag/drop, minimap
  ChatInput.tsx       # input bar, model/tools/thinking/compact/slash controls
  MessageView.tsx     # message, thinking, tool call/result rendering
  ModelsConfig.tsx    # model and auth configuration panel
  SkillsConfig.tsx    # skill management panel
  FileExplorer.tsx    # file tree
  FileViewer.tsx      # source, diff, image, audio, PDF, DOCX preview
lib/
  directory-browser.ts # directory normalization and safe listing helpers
  http-dispatcher.ts  # HTTP(S) proxy setup for server-side fetch
  rpc-manager.ts      # AgentSessionWrapper lifecycle and global registry
  session-reader.ts   # parses .jsonl session files and branch contexts
  normalize.ts        # normalizes toolCall field names
  file-access.ts      # file read safety boundary
  file-paths.ts       # path encoding and relative path helpers
  markdown.ts         # Markdown/Mermaid/KaTeX plugin configuration
  pi-types.ts         # pi-related types
hooks/
  useAgentSession.ts  # session loading, command sending, SSE state machine
  useAudio.ts         # completion sound
  useDragDrop.ts      # image drag/drop
  useTheme.ts         # theme switching
bin/
  pi-web.js           # npm CLI entrypoint
instrumentation.ts    # initializes the server HTTP dispatcher
```
