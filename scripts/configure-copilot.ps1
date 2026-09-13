# Configure GitHub Copilot CLI to send OTLP telemetry to TraceRoost.
# Sets user-level environment variables that persist across sessions.
#
# The GitHub Copilot VS Code extension is configured automatically by TraceRoost;
# this script only handles the Copilot CLI (the `copilot` command).
#
# Usage:
#   .\scripts\configure-copilot.ps1              # uses port 4318 (default)
#   .\scripts\configure-copilot.ps1 -Port 4319   # custom port

param(
    [int]$Port = $(if ($env:TRACEROOST_PORT) { [int]$env:TRACEROOST_PORT } else { 4318 })
)

$ErrorActionPreference = "Stop"
$Endpoint = "http://localhost:$Port"

Write-Host "Configuring GitHub Copilot CLI for TraceRoost at $Endpoint..."

$existing = [System.Environment]::GetEnvironmentVariable("OTEL_EXPORTER_OTLP_ENDPOINT", "User")

if ($existing) {
    Write-Host ""
    Write-Host "OTEL_EXPORTER_OTLP_ENDPOINT is already set as a user environment variable."
    Write-Host "Current value: $existing"
    if ($existing -ne $Endpoint) {
        Write-Host ""
        Write-Host "Updating to: $Endpoint"
        [System.Environment]::SetEnvironmentVariable("OTEL_EXPORTER_OTLP_ENDPOINT", $Endpoint, "User")
        Write-Host "Updated."
    } else {
        Write-Host "Value matches — no changes needed."
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

Write-Host ""
Write-Host "Done. Open a new terminal (or restart VS Code) to pick up the new env vars."
Write-Host "Then restart Copilot CLI."
