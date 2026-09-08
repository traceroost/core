#!/usr/bin/env bash
# Configure GitHub Copilot CLI to send OTLP telemetry to TraceRoost.
# Adds environment variable exports to your shell profile.
#
# The GitHub Copilot VS Code extension is configured automatically by TraceRoost;
# this script only handles the Copilot CLI (the `copilot` command).
#
# Usage:
#   ./scripts/configure-copilot.sh          # uses port 4318 (default)
#   ./scripts/configure-copilot.sh 4319     # custom port
#   TRACEROOST_PORT=4319 ./scripts/configure-copilot.sh

set -euo pipefail

PORT=${1:-${TRACEROOST_PORT:-4318}}
ENDPOINT="http://localhost:${PORT}"

echo "Configuring GitHub Copilot CLI for TraceRoost at ${ENDPOINT}..."

# Detect shell profile
if [ -n "${BASH_VERSION:-}" ] && [ -f "$HOME/.bashrc" ]; then
  PROFILE="$HOME/.bashrc"
elif [ -n "${ZSH_VERSION:-}" ] && [ -f "$HOME/.zshrc" ]; then
  PROFILE="$HOME/.zshrc"
elif [ -f "$HOME/.zshrc" ]; then
  PROFILE="$HOME/.zshrc"
elif [ -f "$HOME/.bashrc" ]; then
  PROFILE="$HOME/.bashrc"
elif [ -f "$HOME/.bash_profile" ]; then
  PROFILE="$HOME/.bash_profile"
else
  echo ""
  echo "Could not detect a shell profile. Add the following to your shell config manually:"
  echo ""
  echo "  export OTEL_EXPORTER_OTLP_ENDPOINT=\"${ENDPOINT}\""
  echo "  export OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true"
  exit 0
fi

# Check if already configured
if grep -q 'OTEL_EXPORTER_OTLP_ENDPOINT' "$PROFILE" 2>/dev/null; then
  echo ""
  echo "OTEL_EXPORTER_OTLP_ENDPOINT is already set in ${PROFILE}."
  echo "Verify it is set to: ${ENDPOINT}"
  echo ""
  echo "If the endpoint is wrong, edit ${PROFILE} and update the value, then:"
  echo "  source ${PROFILE}"
  exit 0
fi

# Append the exports
printf "\n# TraceRoost — Copilot CLI telemetry\nexport OTEL_EXPORTER_OTLP_ENDPOINT=\"${ENDPOINT}\"\nexport OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true\n" >> "$PROFILE"

echo "  Updated ${PROFILE}"
echo ""
echo "Done. Apply now with:"
echo "  source ${PROFILE}"
echo ""
echo "Then restart Copilot CLI. The env vars are also picked up by Claude Code"
echo "if it is running in the same shell."
