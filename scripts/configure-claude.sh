#!/usr/bin/env bash
# Configure Claude Code to send OTLP telemetry to TraceRoost.
# Safe to re-run: only the relevant env vars are updated; other settings are preserved.
#
# Usage:
#   ./scripts/configure-claude.sh          # uses port 4318 (default)
#   ./scripts/configure-claude.sh 4319     # custom port
#   TRACEROOST_PORT=4319 ./scripts/configure-claude.sh
#   ./scripts/configure-claude.sh 4318 <token>             # Docker / LAN mode (BIND_HOST=0.0.0.0)
#   TRACEROOST_TOKEN=<token> TRACEROOST_HOST=192.168.1.20 ./scripts/configure-claude.sh
#
# When TraceRoost is bound beyond localhost (the Docker image does this), every OTLP request
# needs its bearer token — pass it as the second argument or TRACEROOST_TOKEN and the script
# adds OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer <token>. See README → Docker.

set -euo pipefail

PORT=${1:-${TRACEROOST_PORT:-4318}}
TOKEN=${2:-${TRACEROOST_TOKEN:-}}
HOST=${TRACEROOST_HOST:-localhost}
ENDPOINT="http://${HOST}:${PORT}"
if [ -n "$TOKEN" ] && ! [[ "$TOKEN" =~ ^[A-Za-z0-9._~-]+$ ]]; then
  echo "Error: the token may only contain letters, digits and . _ ~ -" >&2
  exit 1
fi

echo "Configuring Claude Code for TraceRoost at ${ENDPOINT}..."

if ! command -v python3 &>/dev/null; then
  echo ""
  echo "Error: python3 is required but not found."
  echo "Configure manually by adding the following to ~/.claude/settings.json:"
  cat <<JSON

{
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "CLAUDE_CODE_ENHANCED_TELEMETRY_BETA": "1",
    "OTEL_TRACES_EXPORTER": "otlp",
    "OTEL_EXPORTER_OTLP_PROTOCOL": "http/json",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "${ENDPOINT}",
    "OTEL_LOG_TOOL_DETAILS": "1",
    "OTEL_LOG_TOOL_CONTENT": "1",
    "OTEL_LOG_USER_PROMPTS": "1"${TOKEN:+,
    \"OTEL_EXPORTER_OTLP_HEADERS\": \"Authorization=Bearer ${TOKEN}\"}
  }
}
JSON
  exit 1
fi

python3 - "$ENDPOINT" "$TOKEN" <<'PYEOF'
import json, os, sys

endpoint = sys.argv[1]
token = sys.argv[2]
path = os.path.expanduser("~/.claude/settings.json")

settings = {}
if os.path.exists(path):
    raw = open(path).read().strip()
    if raw:
        try:
            settings = json.loads(raw)
        except json.JSONDecodeError as e:
            print(f"Error: {path} is not valid JSON ({e})")
            print("Fix the file manually and re-run.")
            sys.exit(1)

env = settings.setdefault("env", {})
env.update({
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "CLAUDE_CODE_ENHANCED_TELEMETRY_BETA": "1",
    "OTEL_TRACES_EXPORTER": "otlp",
    "OTEL_EXPORTER_OTLP_PROTOCOL": "http/json",
    "OTEL_EXPORTER_OTLP_ENDPOINT": endpoint,
    "OTEL_LOG_TOOL_DETAILS": "1",
    "OTEL_LOG_TOOL_CONTENT": "1",
    "OTEL_LOG_USER_PROMPTS": "1",
})
if token:
    env["OTEL_EXPORTER_OTLP_HEADERS"] = f"Authorization=Bearer {token}"

os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
with open(path, "w") as f:
    json.dump(settings, f, indent=2)
    f.write("\n")

print(f"Updated {path}")
PYEOF

echo ""
echo "Done. Restart Claude Code to apply:"
echo "  CLI:      exit the running session and start a new one"
echo "  VS Code:  Command Palette -> Reload Window"
