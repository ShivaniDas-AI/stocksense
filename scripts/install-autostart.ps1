<#
  Register (or remove) StockSense auto-start at Windows sign-in.

    powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
    powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Remove

  Adds "StockSense.cmd" to your Startup folder. At sign-in it runs
  start-stocksense.ps1 in a hidden window. Nothing is installed system-wide
  and no admin rights are needed; delete the file to undo.
#>
param([switch]$Remove)

$Startup  = [Environment]::GetFolderPath("Startup")
$Launcher = Join-Path $Startup "StockSense.cmd"
$Script   = Join-Path $PSScriptRoot "start-stocksense.ps1"

if ($Remove) {
  if (Test-Path $Launcher) { Remove-Item $Launcher -Confirm:$false; Write-Output "Removed $Launcher" }
  else { Write-Output "Nothing to remove" }
  exit 0
}

$cmd = "@echo off`r`n" +
       "rem StockSense backend auto-start (Docker containers + ngrok tunnel)`r`n" +
       "start """" /min powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""$Script""`r`n"
Set-Content -Path $Launcher -Value $cmd -Encoding ascii
Write-Output "Installed $Launcher"
Write-Output "It runs $Script at every sign-in. Log: $env:LOCALAPPDATA\StockSense\startup.log"
