$ErrorActionPreference = "Stop"
$env:PI_SUBAGENT_FS_RETRY_MAX_TOTAL_MS = "0"
Set-Location -LiteralPath "F:\explore\pi-hub"

& cmd.exe /d /c 'node "F:\explore\pi-hub\node_modules\next\dist\bin\next" start -H 0.0.0.0 -p 30141 >> "F:\explore\pi-hub\hub-server.log" 2>&1'
exit $LASTEXITCODE
