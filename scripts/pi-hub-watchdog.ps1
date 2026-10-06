param(
  [string]$TaskName = "pi-hub server",
  [int]$Port = 30141,
  [string]$HealthUrl = "http://127.0.0.1:30141/api/agent/running",
  [string]$LogPath = "F:\explore\pi-hub\hub-watchdog.log"
)

$ErrorActionPreference = "Stop"

# Only one watchdog may own the restart lane. Minute triggers can otherwise
# overlap while an earlier hidden invocation is still finishing a slow restart,
# letting two watchdogs stop each other's freshly started server.
$watchdogMutex = [System.Threading.Mutex]::new($false, "Local\PiHubWatchdog")
try {
  $watchdogMutexAcquired = $watchdogMutex.WaitOne(0)
}
catch [System.Threading.AbandonedMutexException] {
  $watchdogMutexAcquired = $true
}
if (-not $watchdogMutexAcquired) {
  $watchdogMutex.Dispose()
  exit 0
}

function Write-WatchdogLog([string]$Message) {
  $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content -LiteralPath $LogPath -Value "[$timestamp] $Message"
}

function Test-PiHubHealth {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $HealthUrl -TimeoutSec 5
    return $response.StatusCode -eq 200
  }
  catch {
    return $false
  }
}

function Get-PiHubListener {
  Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1
}

try {
  # A heavy but healthy server (e.g. a scheduled task renaming hundreds of
  # session files) can stall the event loop past a single probe. Restart only
  # after 4 consecutive failed probes (≈1 minute of unresponsiveness with the
  # 10s gaps), so long-running task work is not killed mid-flight; a truly
  # wedged server fails them all. Previously 2 probes — that killed the rename
  # task's script 3 minutes into every run (PROCESS_RESTARTED loop).
  $failedProbes = 0
  for ($probe = 1; $probe -le 4; $probe++) {
    if (Test-PiHubHealth) {
      if ($failedProbes -gt 0) {
        Write-WatchdogLog "health recovered on probe $probe"
      }
      exit 0
    }
    $failedProbes++
    if ($probe -lt 4) { Start-Sleep -Seconds 10 }
  }

  Write-WatchdogLog "health failed 4 consecutive probes; restarting scheduled task '$TaskName'"
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

$listener = Get-PiHubListener
if ($listener) {
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
  if ($process.CommandLine -notmatch "pi-hub" -or $process.CommandLine -notmatch "next") {
    Write-WatchdogLog "refused to kill PID $($listener.OwningProcess): port owner is not Pi Hub"
    exit 1
  }
  & taskkill.exe /PID $listener.OwningProcess /T /F | Out-Null
}

Start-ScheduledTask -TaskName $TaskName
$deadline = (Get-Date).AddSeconds(30)
do {
  Start-Sleep -Seconds 1
  if (Test-PiHubHealth) {
    $listener = Get-PiHubListener
    Write-WatchdogLog "restart succeeded; PID $($listener.OwningProcess) is healthy"
    exit 0
  }
} while ((Get-Date) -lt $deadline)

  Write-WatchdogLog "restart did not become healthy within 30 seconds"
  exit 1
}
finally {
  if ($watchdogMutexAcquired) { $watchdogMutex.ReleaseMutex() }
  $watchdogMutex.Dispose()
}
