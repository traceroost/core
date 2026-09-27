#!/usr/bin/env bash
# Configure Codex to send OTLP telemetry to TraceRoost.
# Safe to re-run: if an [otel] section already exists, the script exits without changes.
#
# Usage:
#   ./scripts/configure-codex.sh          # uses port 4318 (default)
#   ./scripts/configure-codex.sh 4319     # custom port
#   TRACEROOST_PORT=4319 ./scripts/configure-codex.sh
#   ./scripts/configure-codex.sh 4318 <token>             # Docker / LAN mode (BIND_HOST=0.0.0.0)
#   TRACEROOST_TOKEN=<token> TRACEROOST_HOST=192.168.1.20 ./scripts/configure-codex.sh
#
# When TraceRoost is bound beyond localhost (the Docker image does this), every OTLP request
# needs its bearer token — pass it as the second argument or TRACEROOST_TOKEN and the exporter
# gets an Authorization header. See README → Docker.

set -euo pipefail

PORT=${1:-${TRACEROOST_PORT:-4318}}
TOKEN=${2:-${TRACEROOST_TOKEN:-}}
HOST=${TRACEROOST_HOST:-localhost}
ENDPOINT="http://${HOST}:${PORT}"
CONFIG="$HOME/.codex/config.toml"
if [ -n "$TOKEN" ] && ! [[ "$TOKEN" =~ ^[A-Za-z0-9._~-]+$ ]]; then
  echo "Error: the token may only contain letters, digits and . _ ~ -" >&2
  exit 1
fi
HEADERS=""
if [ -n "$TOKEN" ]; then
  HEADERS=", headers = { \"Authorization\" = \"Bearer ${TOKEN}\" }"
fi

echo "Configuring Codex for TraceRoost at ${ENDPOINT}..."

if [ -f "$CONFIG" ] && grep -q '^\[otel\]' "$CONFIG" 2>/dev/null; then
  echo ""
  echo "An [otel] section already exists in ${CONFIG}."
  echo "Verify that the endpoint line reads:"
  echo "  endpoint = \"${ENDPOINT}\""
  if [ -n "$TOKEN" ]; then
    echo "and that both exporter tables carry the token:"
    echo "  headers = { \"Authorization\" = \"Bearer ${TOKEN}\" }"
  fi
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
exporter = { otlp-http = { endpoint = "${ENDPOINT}", protocol = "json"${HEADERS} } }
trace_exporter = { otlp-http = { endpoint = "${ENDPOINT}", protocol = "json"${HEADERS} } }
TOML

echo "Updated ${CONFIG}"
echo ""
echo "Done. Restart Codex to apply:"
echo "  CLI:      exit the running session and start a new one"
echo "  VS Code:  Command Palette -> Reload Window"
