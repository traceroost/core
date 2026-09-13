# Configure Codex to send OTLP telemetry to TraceRoost.
# Safe to re-run: if an [otel] section already exists, the script exits without changes.
#
# Usage:
#   .\scripts\configure-codex.ps1              # uses port 4318 (default)
#   .\scripts\configure-codex.ps1 -Port 4319   # custom port

param(
    [int]$Port = $(if ($env:TRACEROOST_PORT) { [int]$env:TRACEROOST_PORT } else { 4318 })
)

$ErrorActionPreference = "Stop"
$Endpoint = "http://localhost:$Port"
$ConfigPath = Join-Path $env:USERPROFILE ".codex\config.toml"

Write-Host "Configuring Codex for TraceRoost at $Endpoint..."

if ((Test-Path $ConfigPath) -and (Select-String -Path $ConfigPath -Pattern '^\[otel\]' -Quiet)) {
    Write-Host ""
    Write-Host "An [otel] section already exists in $ConfigPath"
    Write-Host "Verify that the endpoint line reads:"
    Write-Host "  endpoint = `"$Endpoint`""
    Write-Host "Edit the file manually if the endpoint needs to change."
    exit 0
}

$dir = Split-Path $ConfigPath
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }

$block = @"

[otel]
log_user_prompt = true
exporter = { otlp-http = { endpoint = "$Endpoint", protocol = "json" } }
trace_exporter = { otlp-http = { endpoint = "$Endpoint", protocol = "json" } }
"@

$block | Out-File -FilePath $ConfigPath -Append -Encoding UTF8

Write-Host "Updated $ConfigPath"
Write-Host ""
Write-Host "Done. Restart Codex to apply:"
Write-Host "  CLI:      exit the running session and start a new one"
Write-Host "  VS Code:  Command Palette -> Reload Window"
