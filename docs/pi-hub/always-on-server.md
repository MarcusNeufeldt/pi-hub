# Running Pi Hub as an Always-On Server

Pi Hub is often left running permanently on one machine and reached from a phone or
laptop. This describes that setup: a production build, started automatically, with
configuration that survives however the process happens to be launched.

## Use a Production Build, Not the Dev Server

`next dev` is not built to run for days. It recompiles on demand, its memory grows,
and it can serve a stale chunk after a file changes — which looks like the app
ignoring your edits. For a machine you leave on, build once and serve the build:

```text
npx next build
npx next start -H 0.0.0.0 -p 30141
```

The trade is that there is no hot reload. After changing code you must rebuild and
restart. Keep a separate `npm run dev` on another port while actively developing.

Use `npx next build`, not `npm run build`. See Troubleshooting.

## Starting It Automatically

On Windows, a Scheduled Task at logon keeps the server up without a terminal
window. Register it once:

```powershell
$cmd = 'node "F:\path\to\pi-hub\node_modules\next\dist\bin\next" start -H 0.0.0.0 -p 30141 >> "F:\path\to\pi-hub\hub-server.log" 2>&1'
$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument ("/c " + $cmd) -WorkingDirectory "F:\path\to\pi-hub"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName "pi-hub server" -Action $action -Trigger $trigger -Settings $settings
```

Two settings matter. `ExecutionTimeLimit` of zero stops Windows from killing the
task after its default three days. `RestartCount` brings the server back if it
exits.

Restart it after a rebuild. `Restart-ScheduledTask` is not enough, and neither is
`schtasks /end` on its own — see Troubleshooting for why the `taskkill` is required:

```powershell
npx next build
$held = Get-NetTCPConnection -State Listen -LocalPort 30141 -ErrorAction SilentlyContinue
schtasks /end /tn "pi-hub server"
if ($held) { taskkill /PID $held.OwningProcess /F }   # the step that frees the port
schtasks /run /tn "pi-hub server"
```

`%USERPROFILE%\pi-web\deploy.ps1` does exactly this with error handling — it builds
first, so a failed build leaves the running server untouched on the previous build,
and it health-checks afterwards. The "Rebuild Pi Hub" desktop shortcut runs it.
Keep it separate from the "Pi Hub" launcher shortcut, which only opens the UI.

An at-logon trigger fires when that user logs in, not when the machine boots. If
the machine reboots and waits at the lock screen, the server is down until someone
logs in. Running it before logon requires the task's "run whether user is logged on
or not" option, which stores the account password in Task Scheduler.

## Configuration Belongs in `.env.local`

Next loads `.env.local` for both `dev` and `start`, so put server configuration
there rather than in the Windows user profile:

```text
PI_WEB_ALLOWED_HOSTS=my-machine.tailnet-name.ts.net
```

This is not a style preference. A variable set only in the user profile is
inherited from whichever process starts the server, so a server launched by a
parent that predates the variable silently loses it. The symptom is a blanket 403
from every non-loopback client, with nothing in the UI to explain it.

`.env.local` is gitignored. It holds host allowlists and provider API keys, so keep
it that way.

## Reaching It From Another Device

Bind to `0.0.0.0` so the machine is reachable on its own addresses, then pick a
path in. The host gate in `proxy.ts` accepts loopback names and **any IP literal**
without configuration, but a DNS name must be listed explicitly:

| How you connect | Extra configuration |
| --- | --- |
| `http://127.0.0.1:30141` | none |
| `http://<lan-ip>:30141` | none — IP literals are trusted |
| `http://<tailscale-ip>:30141` | none — also an IP literal |
| `https://<node>.tailnet-name.ts.net` | `PI_WEB_ALLOWED_HOSTS` must contain that name |

A VPN such as Tailscale is the simplest way to reach the machine from outside the
LAN without opening a port. Two options, and they can both be active:

- **Tailscale IP directly.** Needs no allowlist entry and puts nothing between the
  browser and the server.
- **`tailscale serve` proxying to loopback.** Gives you a real TLS certificate and
  a stable hostname. It streams Server-Sent Events correctly — measured at 69ms to
  first byte with the connection held open — so it is not a source of the "stopped
  updating" symptom.

Prefer keeping a working hostname rather than switching to the IP for its own sake.
The origin is part of your browser state: moving from `https://host` to
`http://ip:port` is a different origin, which means a new PWA install and an empty
`localStorage` (sidebar sizes, theme, sticky-unread markers).

## Security When Bound to `0.0.0.0`

Binding to all interfaces exposes the port to the local network, not just the VPN.
Pi Hub can run a high-privilege agent, so:

- Set `PI_WEB_PASSWORD` to require Basic Auth on the UI and every API route.
- Basic Auth does not encrypt anything. Only expose plain HTTP over a trusted VPN
  or LAN, never the internet.
- The host gate still rejects unknown `Host` headers with a 403, which limits DNS
  rebinding but is not access control.

## Troubleshooting

**Every request from my phone returns 403 "Untrusted request".**
The hostname is not in `PI_WEB_ALLOWED_HOSTS`, or the running process never
received the variable. Confirm the value is in `.env.local` rather than only in the
user profile, then restart the server. Connecting by IP instead needs no allowlist.

**`npm run build` fails with `EPERM ... scandir 'C:\Users\<you>\Application Data'`.**
The `build` script passes `--webpack`, and that path globs the user's home
directory, tripping over the legacy `Application Data` junction on Windows. Use
`npx next build`, which compiles the same tree with Turbopack. The build also warns
that `next.config.ts` performs `readFileSync` at module scope, which makes the file
tracer pull in the whole project — likely the same root cause.

**`next build` stops at a type error.**
`next build` type-checks the whole project and halts on the first error, and this
tree carries pre-existing ones. `typescript.ignoreBuildErrors` in `next.config.ts`
keeps the build moving; `npx tsc --noEmit` is the real gate and still reports every
one. Remove that block once the count reaches zero.

**Code changes have no effect.**
A production build does not hot reload. Rebuild, then restart the task — but the
restart is the part that usually goes wrong, below.

**The restart reported success and the old build kept serving.**
Two separate traps, both observed:

`Restart-ScheduledTask` is part of the ScheduledTasks module and is not available in
every shell here; when it is missing you get a `CommandNotFoundException` and nothing
restarts.

`schtasks /end` prints `SUCCESS` and does *not* stop the server. The task action is
`cmd.exe /c node ... next start`, and ending the task kills the `cmd` wrapper while
the `node` child keeps the port. It happens whether or not that wrapper is still
alive, so the check is the port, never the exit code:

```powershell
Get-NetTCPConnection -State Listen -LocalPort 30141
```

If anything is still listening after `/end`, `taskkill /PID <pid> /F` it before
`schtasks /run`, or the new instance cannot bind and you keep serving the old build.
A node process whose parent `cmd` has already exited is orphaned and outside the
task's control entirely — same fix.

Confirm you are actually on the new build rather than trusting the restart: compare
`.next/BUILD_ID` against a token you just changed appearing in the served CSS, e.g.
`curl -s http://127.0.0.1:30141/ | grep -o '/_next/static/[^/]*/'`.

**The server is down after a reboot.**
An at-logon task does not run before anyone logs in. Log in, or convert the task to
run whether the user is logged on or not.

**One device stops updating while another works.**
Not a device limit — the server fans out events to every connected client, and two
streams on one session coexist. Reload the stalled tab. If it recurs while sitting
idle, the event stream is not being re-established; see the reconnect handling in
`hooks/useAgentSession.ts`.
