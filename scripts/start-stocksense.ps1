<#
  StockSense: bring the local backend up after Windows sign-in.

  1. Starts Docker Desktop if it is not running and waits for the engine.
  2. Starts the db, server and worker containers (docker compose up -d).
     They also carry restart: unless-stopped, so Docker restores them itself.
  3. Waits for the server's /health endpoint.
  4. Starts the ngrok tunnel on the fixed domain, hidden, unless it already runs.

  Log: %LOCALAPPDATA%\StockSense\startup.log
  Run by hand any time; it is safe to run twice.
  Registered to run at sign-in by scripts\install-autostart.ps1.
#>

$ErrorActionPreference = "Continue"
$ProjectDir  = Split-Path -Parent $PSScriptRoot
$NgrokDomain = "https://shiftless-uncle-occupier.ngrok-free.dev"
$DockerExe   = Join-Path $env:ProgramFiles "Docker\Docker\Docker Desktop.exe"
$LogDir      = Join-Path $env:LOCALAPPDATA "StockSense"
$Log         = Join-Path $LogDir "startup.log"

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
function Log($msg) {
  $line = "{0}  {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
  Add-Content -Path $Log -Value $line -Encoding utf8
  Write-Output $line
}

Log "---- StockSense start (project: $ProjectDir)"

# 1. Docker engine
function DockerReady { docker info --format "{{.ServerVersion}}" 2>$null | Out-Null; return ($LASTEXITCODE -eq 0) }

if (-not (DockerReady)) {
  if (-not (Get-Process -Name "Docker Desktop" -ErrorAction SilentlyContinue)) {
    if (Test-Path $DockerExe) {
      Log "Starting Docker Desktop"
      Start-Process -FilePath $DockerExe -WindowStyle Minimized
    } else {
      Log "ERROR: Docker Desktop not found at $DockerExe"
      exit 1
    }
  }
  $deadline = (Get-Date).AddMinutes(5)
  while (-not (DockerReady)) {
    if ((Get-Date) -gt $deadline) { Log "ERROR: Docker engine not ready after 5 minutes"; exit 1 }
    Start-Sleep -Seconds 5
  }
}
Log "Docker engine ready"

# 2. Containers
Push-Location $ProjectDir
docker compose up -d 2>&1 | ForEach-Object { Log "compose: $_" }
Pop-Location

# 3. Server health
$deadline = (Get-Date).AddMinutes(2)
$healthy = $false
while ((Get-Date) -lt $deadline) {
  try {
    $r = Invoke-WebRequest -Uri "http://localhost:3000/health" -UseBasicParsing -TimeoutSec 3
    if ($r.StatusCode -eq 200) { $healthy = $true; break }
  } catch { }
  Start-Sleep -Seconds 3
}
if ($healthy) { Log "Server healthy on http://localhost:3000" } else { Log "WARNING: server did not answer /health within 2 minutes" }

# 4. ngrok tunnel
if (Get-Process -Name "ngrok" -ErrorAction SilentlyContinue) {
  Log "ngrok already running"
} else {
  Log "Starting ngrok tunnel $NgrokDomain"
  Start-Process -FilePath "ngrok" -ArgumentList @("http", "3000", "--url=$NgrokDomain", "--log=stdout") `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $LogDir "ngrok.log") `
    -RedirectStandardError  (Join-Path $LogDir "ngrok.err.log")
}

Start-Sleep -Seconds 5
try {
  $t = Invoke-RestMethod -Uri "http://127.0.0.1:4040/api/tunnels" -TimeoutSec 5
  foreach ($tun in $t.tunnels) { Log ("Tunnel online: {0} -> {1}" -f $tun.public_url, $tun.config.addr) }
} catch {
  Log "WARNING: ngrok API not reachable yet; see $LogDir\ngrok.log"
}

Log "---- done"
