$ErrorActionPreference = 'Stop'
$projectDir = $PSScriptRoot
$pythonExe = Join-Path $projectDir '.venv\Scripts\python.exe'
$entryFile = Join-Path $projectDir 'run.py'
$dataDir = Join-Path $projectDir 'data'
if (-not (Test-Path -LiteralPath $pythonExe) -or -not (Test-Path -LiteralPath (Join-Path $projectDir 'frontend\dist\index.html'))) {
    throw 'Dependencies or frontend build missing. Run install.cmd first.'
}
$running = $null
try { $running = Invoke-RestMethod 'http://127.0.0.1:8765/api/status' -TimeoutSec 2 } catch {}
if ($running) {
    if ($running.app -ne 'account-atlas') { throw 'Port 8765 is occupied by another application.' }
    Start-Process 'http://localhost:8765'
    exit 0
}
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
$serverProcess = Start-Process -FilePath $pythonExe -ArgumentList @('"' + $entryFile + '"') -WorkingDirectory $projectDir -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $dataDir 'server.stdout.log') -RedirectStandardError (Join-Path $dataDir 'server.stderr.log')
$serverProcess.Id | Set-Content -LiteralPath (Join-Path $dataDir 'server.pid')
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 300
    try {
        $status = Invoke-RestMethod 'http://127.0.0.1:8765/api/status' -TimeoutSec 1
        if ($status.app -eq 'account-atlas') { Start-Process 'http://localhost:8765'; exit 0 }
    } catch {}
}
throw 'Server did not become ready. See data/server.stderr.log.'
