# Configure AI agents to send OTLP telemetry to TraceRoost.
# GitHub Copilot is configured automatically by the VS Code extension; no script needed.
#
# Usage:
#   .\scripts\configure-agents.ps1                        # configure all (Claude + Codex)
#   .\scripts\configure-agents.ps1 -Agent claude          # Claude Code only
#   .\scripts\configure-agents.ps1 -Agent codex           # Codex only
#   .\scripts\configure-agents.ps1 -Port 4319             # custom port
#   .\scripts\configure-agents.ps1 -Agent claude -Port 4319

param(
    [ValidateSet("all", "claude", "codex", "copilot")]
    # all = Claude + Codex + Copilot CLI
    [string]$Agent = "all",
    [int]$Port = $(if ($env:TRACEROOST_PORT) { [int]$env:TRACEROOST_PORT } else { 4318 })
)

$ErrorActionPreference = "Stop"
$Endpoint = "http://localhost:$Port"

Write-Host "TraceRoost Agent Configuration"
Write-Host "Endpoint: $Endpoint  |  Agent: $Agent"
Write-Host ""

# ── Claude Code ────────────────────────────────────────────────────────────────

function Configure-Claude {
    Write-Host "Configuring Claude Code..."
    $SettingsPath = Join-Path $env:USERPROFILE ".claude\settings.json"

    $settings = @{ env = [ordered]@{} }

    if (Test-Path $SettingsPath) {
        $content = (Get-Content $SettingsPath -Raw -Encoding UTF8).Trim()
        if ($content) {
            try {
                $parsed = $content | ConvertFrom-Json
                $settings = @{}
                $parsed.PSObject.Properties | ForEach-Object { $settings[$_.Name] = $_.Value }
                if ($null -eq $settings["env"]) {
                    $settings["env"] = [ordered]@{}
                } else {
                    $envHash = [ordered]@{}
                    $settings["env"].PSObject.Properties | ForEach-Object { $envHash[$_.Name] = $_.Value }
                    $settings["env"] = $envHash
                }
            } catch {
                Write-Host "  Error: $SettingsPath is not valid JSON ($_) — fix it and re-run"
                return
            }
        }
    }

    $e = $settings["env"]
    $e["CLAUDE_CODE_ENABLE_TELEMETRY"]        = "1"
    $e["CLAUDE_CODE_ENHANCED_TELEMETRY_BETA"] = "1"
    $e["OTEL_TRACES_EXPORTER"]               = "otlp"
    $e["OTEL_EXPORTER_OTLP_PROTOCOL"]        = "http/json"
    $e["OTEL_EXPORTER_OTLP_ENDPOINT"]        = $Endpoint
    $e["OTEL_LOG_TOOL_DETAILS"]              = "1"
    $e["OTEL_LOG_TOOL_CONTENT"]              = "1"
    $e["OTEL_LOG_USER_PROMPTS"]              = "1"

    $dir = Split-Path $SettingsPath
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }

    $settings | ConvertTo-Json -Depth 10 | Set-Content $SettingsPath -Encoding UTF8
    Write-Host "  Updated $SettingsPath"
    Write-Host "  Restart: CLI — exit session and reopen | VS Code — Reload Window"
}

# ── Codex ───────────────────────────────────────────────────────────────

function Configure-Codex {
    Write-Host "Configuring Codex..."
    $ConfigPath = Join-Path $env:USERPROFILE ".codex\config.toml"

    if ((Test-Path $ConfigPath) -and (Select-String -Path $ConfigPath -Pattern '^\[otel\]' -Quiet)) {
        Write-Host "  [otel] section already present — no changes made."
        Write-Host "  Verify endpoint in ${ConfigPath}: endpoint = `"$Endpoint`""
        return
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
    Write-Host "  Updated $ConfigPath"
    Write-Host "  Restart: CLI — exit session and reopen | VS Code — Reload Window"
}

# ── GitHub Copilot CLI ─────────────────────────────────────────────────────────

function Configure-Copilot {
    Write-Host "Configuring GitHub Copilot CLI..."
    Write-Host "  (The Copilot VS Code extension is configured automatically by TraceRoost — no script needed.)"

    $existing = [System.Environment]::GetEnvironmentVariable("OTEL_EXPORTER_OTLP_ENDPOINT", "User")
    if ($existing) {
        Write-Host "  OTEL_EXPORTER_OTLP_ENDPOINT already set ($existing) — skipping."
        if ($existing -ne $Endpoint) {
            Write-Host "  Updating to: $Endpoint"
            [System.Environment]::SetEnvironmentVariable("OTEL_EXPORTER_OTLP_ENDPOINT", $Endpoint, "User")
        }
    } else {
        [System.Environment]::SetEnvironmentVariable("OTEL_EXPORTER_OTLP_ENDPOINT", $Endpoint, "User")
        Write-Host "  Set OTEL_EXPORTER_OTLP_ENDPOINT = $Endpoint"
    }

    $existingCapture = [System.Environment]::GetEnvironmentVariable("OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT", "User")
    if (-not $existingCapture) {
        [System.Environment]::SetEnvironmentVariable("OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT", "true", "User")
        Write-Host "  Set OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = true"
    }

    Write-Host "  Open a new terminal to pick up the env vars, then restart Copilot CLI."
}

# ── Dispatch ───────────────────────────────────────────────────────────────────

switch ($Agent) {
    "claude"  { Configure-Claude }
    "codex"   { Configure-Codex }
    "copilot" { Configure-Copilot }
    "all"     { Configure-Claude; Write-Host ""; Configure-Codex; Write-Host ""; Configure-Copilot }
}

Write-Host ""
Write-Host "Done. Start a short agent session and check the TraceRoost dashboard to confirm data is arriving."
