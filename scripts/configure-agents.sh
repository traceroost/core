#!/usr/bin/env bash
# Configure AI agents to send OTLP telemetry to TraceRoost.
# GitHub Copilot is configured automatically by the VS Code extension; no script needed.
#
# Usage:
#   ./scripts/configure-agents.sh                      # configure all (Claude + Codex)
#   ./scripts/configure-agents.sh --agent claude       # Claude Code only
#   ./scripts/configure-agents.sh --agent codex        # Codex only
#   ./scripts/configure-agents.sh --port 4319          # custom port
#   ./scripts/configure-agents.sh --agent claude --port 4319
#   ./scripts/configure-agents.sh --token <token>             # Docker / LAN mode (BIND_HOST=0.0.0.0)
#   ./scripts/configure-agents.sh --host 192.168.1.20 --token <token>
#
# When TraceRoost is bound beyond localhost (the Docker image does this), every OTLP request needs
# its bearer token — --token (or TRACEROOST_TOKEN) adds the Authorization header to each agent's
# exporter config. See README → Docker for where to find the token.

set -euo pipefail

PORT=${TRACEROOST_PORT:-4318}
TOKEN=${TRACEROOST_TOKEN:-}
HOST=${TRACEROOST_HOST:-localhost}
AGENT="all"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port|-p)    PORT="$2"; shift 2 ;;
    --port=*)     PORT="${1#*=}"; shift ;;
    --agent|-a)   AGENT="$2"; shift 2 ;;
    --agent=*)    AGENT="${1#*=}"; shift ;;
    --token|-t)   TOKEN="$2"; shift 2 ;;
    --token=*)    TOKEN="${1#*=}"; shift ;;
    --host)       HOST="$2"; shift 2 ;;
    --host=*)     HOST="${1#*=}"; shift ;;
    -h|--help)
      echo "Usage: $0 [--agent claude|codex|copilot|all] [--port PORT] [--host HOST] [--token TOKEN]"
      exit 0 ;;
    *)
      echo "Unknown argument: $1  (try --help)"
      exit 1 ;;
  esac
done

ENDPOINT="http://${HOST}:${PORT}"
if [ -n "$TOKEN" ] && ! [[ "$TOKEN" =~ ^[A-Za-z0-9._~-]+$ ]]; then
  echo "Error: the token may only contain letters, digits and . _ ~ -" >&2
  exit 1
fi

echo "TraceRoost Agent Configuration"
echo "Endpoint: ${ENDPOINT}  |  Agent: ${AGENT}${TOKEN:+  |  with auth token}"
echo ""

# ── Claude Code ────────────────────────────────────────────────────────────────

configure_claude() {
  echo "Configuring Claude Code..."

  if ! command -v python3 &>/dev/null; then
    echo "  python3 not found — configure manually (see Help tab in TraceRoost)"
    echo "  Add the following env block to ~/.claude/settings.json:"
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
    return
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
            print(f"  Error: {path} is not valid JSON ({e}) — fix it and re-run")
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

print(f"  Updated {path}")
PYEOF

  echo "  Restart: CLI — exit session and reopen | VS Code — Reload Window"
}

# ── Codex ───────────────────────────────────────────────────────────────

configure_codex() {
  echo "Configuring Codex..."
  local config="$HOME/.codex/config.toml"

  if [ -f "$config" ] && grep -q '^\[otel\]' "$config" 2>/dev/null; then
    echo "  [otel] section already present — no changes made."
    echo "  Verify endpoint in ${config}: endpoint = \"${ENDPOINT}\""
    [ -n "$TOKEN" ] && echo "  and that both exporters carry: headers = { \"Authorization\" = \"Bearer ${TOKEN}\" }"
    return
  fi
  local headers=""
  [ -n "$TOKEN" ] && headers=", headers = { \"Authorization\" = \"Bearer ${TOKEN}\" }"

  mkdir -p "$(dirname "$config")"
  [ -s "$config" ] && printf "\n" >> "$config"

  cat >> "$config" <<TOML
[otel]
log_user_prompt = true
exporter = { otlp-http = { endpoint = "${ENDPOINT}", protocol = "json"${headers} } }
trace_exporter = { otlp-http = { endpoint = "${ENDPOINT}", protocol = "json"${headers} } }
TOML

  echo "  Updated ${config}"
  echo "  Restart: CLI — exit session and reopen | VS Code — Reload Window"
}

# ── GitHub Copilot CLI ─────────────────────────────────────────────────────────

configure_copilot() {
  echo "Configuring GitHub Copilot CLI..."
  echo "  (The Copilot VS Code extension is configured automatically by TraceRoost — no script needed.)"

  # Detect shell profile
  local profile=""
  if [ -n "${ZSH_VERSION:-}" ] && [ -f "$HOME/.zshrc" ]; then
    profile="$HOME/.zshrc"
  elif [ -n "${BASH_VERSION:-}" ] && [ -f "$HOME/.bashrc" ]; then
    profile="$HOME/.bashrc"
  elif [ -f "$HOME/.zshrc" ]; then
    profile="$HOME/.zshrc"
  elif [ -f "$HOME/.bashrc" ]; then
    profile="$HOME/.bashrc"
  elif [ -f "$HOME/.bash_profile" ]; then
    profile="$HOME/.bash_profile"
  fi

  if [ -z "$profile" ]; then
    echo "  Could not detect a shell profile. Add manually:"
    echo "    export OTEL_EXPORTER_OTLP_ENDPOINT=\"${ENDPOINT}\""
    echo "    export OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true"
    [ -n "$TOKEN" ] && echo "    export OTEL_EXPORTER_OTLP_HEADERS=\"Authorization=Bearer ${TOKEN}\""
    return
  fi

  if grep -q 'OTEL_EXPORTER_OTLP_ENDPOINT' "$profile" 2>/dev/null; then
    echo "  OTEL_EXPORTER_OTLP_ENDPOINT already set in ${profile} — skipping."
    echo "  Verify it is: ${ENDPOINT}"
    return
  fi

  local headers_export=""
  [ -n "$TOKEN" ] && headers_export="export OTEL_EXPORTER_OTLP_HEADERS=\"Authorization=Bearer ${TOKEN}\"\n"
  printf "\n# TraceRoost — Copilot CLI telemetry\nexport OTEL_EXPORTER_OTLP_ENDPOINT=\"${ENDPOINT}\"\nexport OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true\n${headers_export}" >> "$profile"
  echo "  Updated ${profile}"
  echo "  Run: source ${profile}, then restart Copilot CLI."
}

# ── Dispatch ───────────────────────────────────────────────────────────────────

case "$AGENT" in
  claude)
    configure_claude ;;
  codex)
    configure_codex ;;
  copilot)
    configure_copilot ;;
  all)
    configure_claude
    echo ""
    configure_codex
    echo ""
    configure_copilot ;;
  *)
    echo "Unknown agent: ${AGENT}. Choose from: claude, codex, copilot, all"
    exit 1 ;;
esac

echo ""
echo "Done. Start a short agent session and check the TraceRoost dashboard to confirm data is arriving."
