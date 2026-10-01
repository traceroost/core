# Configure Claude Code to send OTLP telemetry to TraceRoost.
# Safe to re-run: only the relevant env vars are updated; other settings are preserved.
#
# Usage:
#   .\scripts\configure-claude.ps1              # uses port 4318 (default)
#   .\scripts\configure-claude.ps1 -Port 4319   # custom port
#   .\scripts\configure-claude.ps1 -Token <token>   # Docker / LAN mode (BIND_HOST=0.0.0.0) - see README -> Docker

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
$SettingsPath = Join-Path $env:USERPROFILE ".claude\settings.json"

Write-Host "Configuring Claude Code for TraceRoost at $Endpoint..."

$settings = @{ env = [ordered]@{} }

if (Test-Path $SettingsPath) {
    $content = (Get-Content $SettingsPath -Raw -Encoding UTF8).Trim()
    if ($content) {
        try {
            $parsed = $content | ConvertFrom-Json
            $settings = [ordered]@{}
            $parsed.PSObject.Properties | ForEach-Object { $settings[$_.Name] = $_.Value }
            if ($null -eq $settings["env"]) {
                $settings["env"] = [ordered]@{}
            } else {
                $envHash = [ordered]@{}
                $settings["env"].PSObject.Properties | ForEach-Object { $envHash[$_.Name] = $_.Value }
                $settings["env"] = $envHash
            }
        } catch {
            Write-Host "Error: $SettingsPath is not valid JSON ($_)"
            Write-Host "Fix the file manually and re-run."
            exit 1
        }
    }
}

$env = $settings["env"]
$env["CLAUDE_CODE_ENABLE_TELEMETRY"]        = "1"
$env["CLAUDE_CODE_ENHANCED_TELEMETRY_BETA"] = "1"
$env["OTEL_TRACES_EXPORTER"]               = "otlp"
$env["OTEL_EXPORTER_OTLP_PROTOCOL"]        = "http/json"
$env["OTEL_EXPORTER_OTLP_ENDPOINT"]        = $Endpoint
$env["OTEL_LOG_TOOL_DETAILS"]              = "1"
$env["OTEL_LOG_TOOL_CONTENT"]              = "1"
$env["OTEL_LOG_USER_PROMPTS"]              = "1"
if ($Token) { $env["OTEL_EXPORTER_OTLP_HEADERS"] = "Authorization=Bearer $Token" }

$dir = Split-Path $SettingsPath
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }

# UTF-8 *without* a byte-order mark: Windows PowerShell 5.1's `Set-Content -Encoding UTF8`
# writes one, and Node's JSON.parse (Claude Code, TraceRoost's auto-config) rejects it.
$json = ($settings | ConvertTo-Json -Depth 10) + [Environment]::NewLine
[System.IO.File]::WriteAllText($SettingsPath, $json, (New-Object System.Text.UTF8Encoding $false))
Write-Host "Updated $SettingsPath"
Write-Host ""
Write-Host "Done. Restart Claude Code to apply:"
Write-Host "  CLI:      exit the running session and start a new one"
Write-Host "  VS Code:  Command Palette -> Reload Window"
