# Configure Codex to send OTLP telemetry to TraceRoost.
# Safe to re-run: if an [otel] section already exists, the script exits without changes.
#
# Usage:
#   .\scripts\configure-codex.ps1              # uses port 4318 (default)
#   .\scripts\configure-codex.ps1 -Port 4319   # custom port
#   .\scripts\configure-codex.ps1 -Token <token>   # Docker / LAN mode (BIND_HOST=0.0.0.0) - see README -> Docker

param(
    [int]$Port = $(if ($env:TRACEROOST_PORT) { [int]$env:TRACEROOST_PORT } else { 4318 }),
    # Bearer token - required when TraceRoost is bound beyond localhost (Docker / LAN mode).
    [string]$Token = $env:TRACEROOST_TOKEN,
    [string]$HostName = $(if ($env:TRACEROOST_HOST) { $env:TRACEROOST_HOST } else { "localhost" })
)

$ErrorActionPreference = "Stop"
$Endpoint = "http://${HostName}:$Port"
if ($Token -and ($Token -notmatch '^[A-Za-z0-9._~-]+$')) {
    Write-Host "Error: the token may only contain letters, digits and . _ ~ -"
    exit 1
}
$ConfigPath = Join-Path $env:USERPROFILE ".codex\config.toml"

Write-Host "Configuring Codex for TraceRoost at $Endpoint..."

if ((Test-Path $ConfigPath) -and (Select-String -Path $ConfigPath -Pattern '^\[otel\]' -Quiet)) {
    Write-Host ""
    Write-Host "An [otel] section already exists in $ConfigPath"
    Write-Host "Verify that the endpoint line reads:"
    Write-Host "  endpoint = `"$Endpoint`""
    if ($Token) { Write-Host "and that both exporters carry: headers = { `"Authorization`" = `"Bearer $Token`" }" }
    Write-Host "Edit the file manually if the endpoint needs to change."
    exit 0
}

$Headers = if ($Token) { ", headers = { `"Authorization`" = `"Bearer $Token`" }" } else { "" }

$dir = Split-Path $ConfigPath
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }

$block = @"

[otel]
log_user_prompt = true
exporter = { otlp-http = { endpoint = "$Endpoint", protocol = "json"$Headers } }
trace_exporter = { otlp-http = { endpoint = "$Endpoint", protocol = "json"$Headers } }
"@

# Appended as UTF-8 without a byte-order mark (Out-File -Encoding UTF8 adds one on Windows PowerShell 5.1).
[System.IO.File]::AppendAllText($ConfigPath, $block + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding $false))

Write-Host "Updated $ConfigPath"
Write-Host ""
Write-Host "Done. Restart Codex to apply:"
Write-Host "  CLI:      exit the running session and start a new one"
Write-Host "  VS Code:  Command Palette -> Reload Window"
