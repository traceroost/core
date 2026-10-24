#!/usr/bin/env bash
# Rehearses the Developer ID signing path without a Developer ID: re-signs a packed TraceRoost.app
# with a throwaway self-signed identity under the hardened runtime and the production entitlements,
# verifies the signature, and runs the packaged-app smoke test against it.
#
#   pnpm run pack:host                     # the ad-hoc build this re-signs (any recent one will do)
#   pnpm run rehearse:mac-signing [path/to/TraceRoost.app]
#
# What it proves: the hardened runtime with build/entitlements.mac.plist lets the app start, run the
# collector as a child (Electron re-entered as Node), load sql.js's WASM, serve the dashboard, and
# quit cleanly — the things that break when an entitlement is missing, and that the ad-hoc CI build
# (hardened runtime off) never exercises.
#
# What it cannot prove: notarization and Gatekeeper (they need Apple's certificate), and library
# validation. Library validation requires the app and every framework it loads to share a Team ID;
# a self-signed certificate has none, so a self-signed hardened app dies in dyld before main ("have
# different Team IDs"). The rehearsal therefore adds `disable-library-validation` to a *copy* of the
# entitlements — the one difference from a real build, where a Developer ID supplies the Team ID and
# the production entitlements stay as they are. The copy is never launched without it.
#
# Side effects, all undone on exit: a temporary keychain added to the user's keychain search list
# (codesign only finds identities there), and files under a temporary directory. The login keychain
# is not touched, nothing is trusted system-wide, and the app runs with HOME redirected (the smoke
# test's own isolation).
set -euo pipefail

desktop_dir="$(cd "$(dirname "$0")/.." && pwd)"
# electron-builder's output directory for a host build: dist/mac-arm64 on Apple Silicon, dist/mac on Intel.
host_dir="$desktop_dir/dist/mac"; [ "$(uname -m)" = arm64 ] && host_dir="$desktop_dir/dist/mac-arm64"
source_app="${1:-$host_dir/TraceRoost.app}"
if [ ! -d "$source_app" ]; then
  echo "rehearse: no app at $source_app — run 'pnpm run pack:host' first, or pass the .app path" >&2
  exit 1
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/traceroost-rehearse.XXXXXX")"
keychain="$work/rehearsal.keychain-db"
keychain_password="$(openssl rand -hex 16)"
p12_password="$(openssl rand -hex 16)"

original_keychains=()
while IFS= read -r line; do
  line="${line#"${line%%[![:space:]]*}"}"; line="${line#\"}"; line="${line%\"}"
  [ -n "$line" ] && original_keychains+=("$line")
done < <(security list-keychains -d user)

cleanup() {
  security list-keychains -d user -s "${original_keychains[@]}" || echo "rehearse: could not restore the keychain search list; it was: ${original_keychains[*]}" >&2
  security delete-keychain "$keychain" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

# A code-signing certificate named like a Developer ID one, valid for two days.
cat > "$work/cert.cnf" <<'EOF'
[req]
distinguished_name=dn
prompt=no
x509_extensions=ext
[dn]
CN=Developer ID Application: TraceRoost Rehearsal (REHEARSAL0)
OU=REHEARSAL0
O=TraceRoost Rehearsal
[ext]
basicConstraints=critical,CA:false
keyUsage=critical,digitalSignature
extendedKeyUsage=critical,codeSigning
EOF
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -config "$work/cert.cnf" \
  -keyout "$work/key.pem" -out "$work/cert.pem" 2>/dev/null
openssl pkcs12 -export -inkey "$work/key.pem" -in "$work/cert.pem" \
  -out "$work/rehearsal.p12" -passout "pass:$p12_password"

security create-keychain -p "$keychain_password" "$keychain"
security set-keychain-settings "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"
security import "$work/rehearsal.p12" -k "$keychain" -P "$p12_password" -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$keychain_password" "$keychain" >/dev/null
security list-keychains -d user -s "$keychain" "${original_keychains[@]}"
# Untrusted, so `find-identity -v` would hide it; codesign accepts it by hash all the same.
identity="$(security find-identity -p codesigning "$keychain" | awk '/"Developer ID Application: TraceRoost Rehearsal/ { print $2; exit }')"
[ -n "$identity" ] || { echo "rehearse: the self-signed identity did not import" >&2; exit 1; }

app="$work/TraceRoost.app"
cp -R "$source_app" "$app"
cp "$desktop_dir/build/entitlements.mac.plist" "$work/entitlements.plist"
/usr/libexec/PlistBuddy -c 'Add :com.apple.security.cs.disable-library-validation bool true' "$work/entitlements.plist"

echo "rehearse: signing a copy of $source_app under the hardened runtime"
# @electron/osx-sign is what electron-builder signs with; identity validation is off because the
# identity is untrusted by design.
node -e '
  const [app, identity, keychain, entitlements] = process.argv.slice(1)
  require(require.resolve("@electron/osx-sign", { paths: [process.cwd()] })).signAsync({
    app, identity, keychain, platform: "darwin", identityValidation: false,
    optionsForFile: () => ({ hardenedRuntime: true, entitlements }),
  }).catch(e => { console.error(e); process.exit(1) })
' "$app" "$identity" "$keychain" "$work/entitlements.plist"

codesign --verify --deep --strict --verbose=1 "$app"
details="$(codesign --display --verbose=2 "$app" 2>&1)"
grep -q 'flags=.*runtime' <<<"$details" || { echo "rehearse: hardened runtime flag missing" >&2; exit 1; }
granted="$(codesign --display --entitlements - --xml "$app" 2>/dev/null | plutil -convert json -o - - | node -pe 'Object.keys(JSON.parse(require("fs").readFileSync(0))).sort().join(" ")')"
expected="com.apple.security.cs.allow-jit com.apple.security.cs.allow-unsigned-executable-memory com.apple.security.cs.disable-library-validation"
[ "$granted" = "$expected" ] || { echo "rehearse: entitlements are '$granted', expected '$expected'" >&2; exit 1; }
echo "rehearse: signed, hardened runtime on, entitlements = production + disable-library-validation"

env -u ELECTRON_RUN_AS_NODE node "$desktop_dir/scripts/smoke-packaged.mjs" "$app"
echo "rehearse: the hardened-runtime app passed the smoke test"
