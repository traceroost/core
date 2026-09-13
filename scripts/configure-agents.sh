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

set -euo pipefail

PORT=${TRACEROOST_PORT:-4318}
AGENT="all"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port|-p)    PORT="$2"; shift 2 ;;
    --port=*)     PORT="${1#*=}"; shift ;;
    --agent|-a)   AGENT="$2"; shift 2 ;;
    --agent=*)    AGENT="${1#*=}"; shift ;;
    -h|--help)
      echo "Usage: $0 [--agent claude|codex|all] [--port PORT]"
      exit 0 ;;
    *)
      echo "Unknown argument: $1  (try --help)"
      exit 1 ;;
  esac
done

ENDPOINT="http://localhost:${PORT}"

echo "TraceRoost Agent Configuration"
echo "Endpoint: ${ENDPOINT}  |  Agent: ${AGENT}"
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
      "OTEL_LOG_USER_PROMPTS": "1"
    }
  }
JSON
    return
  fi

  python3 - "$ENDPOINT" <<'PYEOF'
import json, os, sys

endpoint = sys.argv[1]
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
    return
  fi

  mkdir -p "$(dirname "$config")"
  [ -s "$config" ] && printf "\n" >> "$config"

  cat >> "$config" <<TOML
[otel]
log_user_prompt = true
exporter = { otlp-http = { endpoint = "${ENDPOINT}", protocol = "json" } }
trace_exporter = { otlp-http = { endpoint = "${ENDPOINT}", protocol = "json" } }
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
    return
  fi

  if grep -q 'OTEL_EXPORTER_OTLP_ENDPOINT' "$profile" 2>/dev/null; then
    echo "  OTEL_EXPORTER_OTLP_ENDPOINT already set in ${profile} — skipping."
    echo "  Verify it is: ${ENDPOINT}"
    return
  fi

  printf "\n# TraceRoost — Copilot CLI telemetry\nexport OTEL_EXPORTER_OTLP_ENDPOINT=\"${ENDPOINT}\"\nexport OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true\n" >> "$profile"
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
