$ErrorActionPreference = 'Stop'
$pidFile = Join-Path $PSScriptRoot 'data\server.pid'
if (-not (Test-Path -LiteralPath $pidFile)) { Write-Output 'No launcher-managed server found.'; exit 0 }
$serverPid = [int](Get-Content -LiteralPath $pidFile)
$serverInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $serverPid"
$expectedEntry = Join-Path $PSScriptRoot 'run.py'
if ($serverInfo -and $serverInfo.CommandLine -and $serverInfo.CommandLine.Contains($expectedEntry)) {
    Stop-Process -Id $serverPid
    Write-Output 'Account Atlas stopped. Saved data remains encrypted.'
} elseif ($serverInfo) {
    throw 'PID belongs to another process. Nothing was stopped.'
}
Remove-Item -LiteralPath $pidFile
