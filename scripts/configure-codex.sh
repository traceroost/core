#!/usr/bin/env bash
# Configure Codex to send OTLP telemetry to TraceRoost.
# Safe to re-run: if an [otel] section already exists, the script exits without changes.
#
# Usage:
#   ./scripts/configure-codex.sh          # uses port 4318 (default)
#   ./scripts/configure-codex.sh 4319     # custom port
#   TRACEROOST_PORT=4319 ./scripts/configure-codex.sh

set -euo pipefail

PORT=${1:-${TRACEROOST_PORT:-4318}}
ENDPOINT="http://localhost:${PORT}"
CONFIG="$HOME/.codex/config.toml"

echo "Configuring Codex for TraceRoost at ${ENDPOINT}..."

if [ -f "$CONFIG" ] && grep -q '^\[otel\]' "$CONFIG" 2>/dev/null; then
  echo ""
  echo "An [otel] section already exists in ${CONFIG}."
  echo "Verify that the endpoint line reads:"
  echo "  endpoint = \"${ENDPOINT}\""
  echo "Edit the file manually if the endpoint needs to change."
  exit 0
fi

mkdir -p "$(dirname "$CONFIG")"

# Append a blank separator if the file already has content
if [ -s "$CONFIG" ]; then
  printf "\n" >> "$CONFIG"
fi

cat >> "$CONFIG" <<TOML
[otel]
log_user_prompt = true
exporter = { otlp-http = { endpoint = "${ENDPOINT}", protocol = "json" } }
trace_exporter = { otlp-http = { endpoint = "${ENDPOINT}", protocol = "json" } }
TOML

echo "Updated ${CONFIG}"
echo ""
echo "Done. Restart Codex to apply:"
echo "  CLI:      exit the running session and start a new one"
echo "  VS Code:  Command Palette -> Reload Window"
