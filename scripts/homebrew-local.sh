#!/usr/bin/env bash
# Installs this checkout with Homebrew, the way the published formula would, so the Homebrew path
# can be tried before a release (macOS or Linux, with Homebrew installed):
#
#   scripts/homebrew-local.sh            # the core edition — what releases ship today
#   scripts/homebrew-local.sh full       # the full edition
#
# It builds the npm package exactly as `npm publish` would (prepare-edition + package:<edition>),
# packs it, writes a formula for that tarball with scripts/homebrew-formula.mjs --tarball, and
# installs it from a local tap, traceroost/local, replacing any traceroost already installed with
# Homebrew. Then try it: `traceroost --version`, `brew test traceroost`, `traceroost service
# install`. Back to the published formula afterwards:
#
#   brew uninstall traceroost && brew untap traceroost/local && brew install traceroost/tap/traceroost
#
# runbooks/RELEASING.md → Homebrew.
set -euo pipefail

cd "$(dirname "$0")/.."
EDITION="${1:-core}"
case "$EDITION" in
  core) BUILD=package:core ;;
  full) BUILD=package ;;
  *) echo "usage: scripts/homebrew-local.sh [core|full]" >&2; exit 2 ;;
esac
command -v brew >/dev/null || { echo "Homebrew isn't installed (brew not on PATH)." >&2; exit 1; }

node scripts/prepare-edition.mjs "$EDITION"
trap 'node scripts/prepare-edition.mjs restore >/dev/null' EXIT
pnpm run "$BUILD"

OUT="$(mktemp -d)"
npm pack --pack-destination "$OUT" >/dev/null
TGZ="$(ls "$OUT"/traceroost-*.tgz)"
echo "Packed $TGZ"

brew tap-new --no-git traceroost/local >/dev/null 2>&1 || true
TAP="$(brew --repository traceroost/local)"
mkdir -p "$TAP/Formula"
node scripts/homebrew-formula.mjs --tarball "$TGZ" --out "$TAP/Formula/traceroost.rb"

# One traceroost at a time: the published tap's copy (or an earlier local one) comes out first.
if brew list --formula traceroost >/dev/null 2>&1; then
  brew uninstall --ignore-dependencies traceroost
fi
brew install traceroost/local/traceroost

echo
echo "Installed $(traceroost --version 2>/dev/null || echo '?') from traceroost/local. Next:"
echo "  brew test traceroost/local/traceroost"
echo "  traceroost service install"
