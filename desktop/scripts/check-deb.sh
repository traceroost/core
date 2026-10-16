#!/usr/bin/env bash
# Installs, exercises, upgrades, removes and reinstalls the TraceRoost .deb on a clean Debian or
# Ubuntu system, and checks the Linux plan's Stage 2 gate along the way:
#
#   - apt resolves every dependency from the distribution's own archive (no nodejs);
#   - the install lands in /opt/TraceRoost with /usr/bin/traceroost-desktop, a .desktop entry,
#     hicolor icons at every standard size, and the sandbox set up (setuid chrome-sandbox only on a
#     kernel without user namespaces; the AppArmor profile where AppArmor can load it);
#   - the Electron binary links with nothing missing, and runs the collector's Node;
#   - the packaged app starts as an unprivileged user, owns a collector, serves the dashboard and
#     quits cleanly (scripts/smoke-packaged.mjs, run on the app's own Electron — no system Node);
#   - upgrading over an older version, `apt remove`, `apt purge` and reinstalling all keep the
#     user's ~/.traceroost, and the maintainer scripts touch nothing in any home directory.
#
# Meant for a throwaway container or VM, as root:
#
#   docker run --rm -v "$PWD/desktop:/desktop:ro" ubuntu:24.04 /desktop/scripts/check-deb.sh /desktop/dist/TraceRoost-<v>-linux-<arch>.deb
#
# CI runs it on ubuntu:22.04, ubuntu:24.04 and debian:12 containers, and directly on the Ubuntu
# 24.04 runner — a real VM with AppArmor, where the profile is installed and loaded rather than
# skipped (.github/workflows/desktop-linux.yml).
#
# In a container the sandbox needs `--security-opt seccomp=unconfined --security-opt
# apparmor=unconfined --cap-add SYS_ADMIN`: Docker's default seccomp policy refuses the namespaces
# Chromium's sandbox creates, on any host. That is a property of the container, not the package.

set -euo pipefail

DEB=${1:?usage: check-deb.sh path/to/TraceRoost-<version>-linux-<arch>.deb}
# Every home directory, in a container. On a CI runner host — whose own user's home is busy with
# the job itself — CI narrows this to the test user's.
HOMES_TO_WATCH=${HOMES_TO_WATCH:-/home /root}
HERE=$(cd "$(dirname "$0")" && pwd)
APP=/opt/TraceRoost/traceroost-desktop
export DEBIAN_FRONTEND=noninteractive

pass=0
fail=0
ok()   { echo "  ✔ $*"; pass=$((pass + 1)); }
bad()  { echo "  ✘ $*"; fail=$((fail + 1)); }
check() { local what=$1; shift; if "$@" >/dev/null 2>&1; then ok "$what"; else bad "$what"; fi; }

. /etc/os-release
echo "check-deb: $PRETTY_NAME, $(dpkg --print-architecture), $(basename "$DEB")"

# Test tooling only — none of it is a dependency of the package. (xvfb for a display, dbus for a
# session bus, procps for pgrep.)
apt-get update -qq
apt-get install -y -qq --no-install-recommends xvfb xauth dbus dbus-x11 procps ca-certificates >/dev/null

# ── A user with data that must survive everything below ──
useradd -m -s /bin/bash tester 2>/dev/null || true
install -d -o tester -g tester -m 700 /home/tester/.traceroost
echo '{"keep":"me"}' > /home/tester/.traceroost/sentinel.json
chown tester:tester /home/tester/.traceroost/sentinel.json
install -d -o tester -g tester /home/tester/smoke
# Anything in a home directory newer than this, outside the smoke harness's own scratch directory,
# was written by something below.
HOME_MARK=$(mktemp)
sleep 1
homes_untouched() {
  local changed
  # Excluded: the smoke harness's scratch directory, and ~/.cache — where Xvfb, the test's own
  # display server running as the test user, keeps Mesa's shader cache on some distributions.
  # shellcheck disable=SC2086 # HOMES_TO_WATCH is a list
  changed=$(find $HOMES_TO_WATCH -xdev -newer "$HOME_MARK" -not -path '/root/.cache*' -not -path '/home/tester/.cache*' -not -path '/home/tester/smoke*' 2>/dev/null | grep -v -E '^/(home/tester|root)$' || true)
  [ -z "$changed" ] && return 0
  echo "    changed since the install began:" >&2; echo "$changed" | sed 's/^/      /' >&2
  return 1
}

# ── An "older version" of the same package, to upgrade from ──
OLD_DEB=/tmp/traceroost-older.deb
rm -rf /tmp/older && mkdir -p /tmp/older
dpkg-deb -R "$DEB" /tmp/older
NEW_VERSION=$(dpkg-deb -f "$DEB" Version)
sed -i "s/^Version: .*/Version: 0.0.1/" /tmp/older/DEBIAN/control
dpkg-deb -Zxz -b /tmp/older "$OLD_DEB" >/dev/null
rm -rf /tmp/older

echo "── install the older version, then upgrade to $NEW_VERSION"
apt-get install -y -qq "$OLD_DEB" >/dev/null
check "older version installed" dpkg-query -W -f='${Version}' traceroost-desktop
apt-get install -y -qq "$DEB" > /tmp/apt-install.log 2>&1 || { cat /tmp/apt-install.log; bad "upgrade to $NEW_VERSION"; }
[ "$(dpkg-query -W -f='${Version}' traceroost-desktop)" = "$NEW_VERSION" ] && ok "upgraded to $NEW_VERSION" || bad "upgraded to $NEW_VERSION"
check "nodejs was not pulled in" sh -c '! dpkg -l nodejs 2>/dev/null | grep -q ^ii'

echo "── what the package installed"
check "/usr/bin/traceroost-desktop runs the app" sh -c "[ \"\$(readlink -f /usr/bin/traceroost-desktop)\" = $APP ]"
check "launcher entry /usr/share/applications/traceroost-desktop.desktop" grep -q "^Exec=$APP" /usr/share/applications/traceroost-desktop.desktop
check "launcher entry has no --no-sandbox" sh -c '! grep -q -- --no-sandbox /usr/share/applications/traceroost-desktop.desktop'
check "StartupWMClass matches the app_id (desktopName)" grep -q '^StartupWMClass=traceroost-desktop$' /usr/share/applications/traceroost-desktop.desktop
for size in 16 24 32 48 64 128 256 512; do
  check "hicolor icon ${size}x${size}" test -s /usr/share/icons/hicolor/${size}x${size}/apps/traceroost-desktop.png
done
check "AppArmor profile shipped, granting userns to $APP" sh -c "grep -q '\"$APP\"' /opt/TraceRoost/resources/apparmor-profile && grep -q 'userns,' /opt/TraceRoost/resources/apparmor-profile"
if command -v apparmor_status >/dev/null && apparmor_status --enabled 2>/dev/null; then
  check "AppArmor profile installed at /etc/apparmor.d/traceroost-desktop" test -f /etc/apparmor.d/traceroost-desktop
else
  echo "  · AppArmor not enabled here — profile installation not exercised"
fi
# setuid chrome-sandbox exactly when an unprivileged user cannot create a user namespace and use
# it (Ubuntu 24.04's restriction without the profile loaded, Debian's unprivileged_userns_clone=0, a
# container's seccomp policy) — the post-install's own test, repeated here.
if setpriv --reuid=65534 --regid=65534 --clear-groups unshare --user --map-root-user --net true 2>/dev/null; then
  check "chrome-sandbox is not setuid (user namespaces available)" sh -c "[ \"\$(stat -c %a /opt/TraceRoost/chrome-sandbox)\" = 755 ]"
else
  check "chrome-sandbox is setuid root (no user namespaces)" sh -c "[ \"\$(stat -c %a:%U /opt/TraceRoost/chrome-sandbox)\" = 4755:root ]"
fi
missing=$(ldd "$APP" | grep 'not found' || true)
[ -z "$missing" ] && ok "every shared library the binary links is installed" || bad "missing libraries: $missing"
node_version=$(ELECTRON_RUN_AS_NODE=1 "$APP" -p process.versions.node 2>/dev/null || true)
[ "${node_version%%.*}" -ge 24 ] 2>/dev/null && ok "bundled runtime is Node $node_version" || bad "bundled runtime ran (got '$node_version')"

echo "── run the installed app as an unprivileged user"
cp "$HERE/smoke-packaged.mjs" /home/tester/smoke/
# The smoke harness itself runs on the app's Electron as Node: this machine has no Node at all.
if su tester -c "cd /home/tester/smoke && dbus-run-session -- xvfb-run -a env ELECTRON_RUN_AS_NODE=1 $APP smoke-packaged.mjs $APP" > /tmp/smoke.log 2>&1; then
  ok "smoke test passed ($(grep -c '✔' /tmp/smoke.log) checks)"
else
  bad "smoke test failed"; cat /tmp/smoke.log
fi
grep -E '✔|✘' /tmp/smoke.log | sed 's/^/    /' || true

echo "── attach to a collector the app did not start, and leave it running"
# A collector started outside the app (as `npx traceroost` or the systemd unit would), on the same
# data dir. The app must attach — not start a second writer — and quitting it must not stop the
# other collector.
ATTACH_HOME=$(su tester -c 'mktemp -d /tmp/attach-home-XXXXXX')
ATTACH_ENV="HOME=$ATTACH_HOME XDG_CONFIG_HOME=$ATTACH_HOME/.config DATA_DIR=$ATTACH_HOME/.traceroost UI_PORT=31700 OTLP_PORT=31718 MCP_PORT=31716 TRACEROOST_NO_UPDATE_CHECK=1"
su tester -c "env $ATTACH_ENV ELECTRON_RUN_AS_NODE=1 $APP /opt/TraceRoost/resources/collector/standalone/server.js > $ATTACH_HOME/cli.log 2>&1 &"
for _ in $(seq 1 60); do grep -q '"uiPort"' "$ATTACH_HOME/.traceroost/server.lock" 2>/dev/null && break; sleep 0.5; done
cli_pid=$(sed -n 's/.*"pid": *\([0-9]*\).*/\1/p' "$ATTACH_HOME/.traceroost/server.lock" | head -1)
[ -n "$cli_pid" ] && ok "an outside collector holds the data dir (pid $cli_pid)" || bad "the outside collector did not start"
su tester -c "cd /home/tester/smoke && env $ATTACH_ENV dbus-run-session -- xvfb-run -a $APP > $ATTACH_HOME/app.log 2>&1 &"
for _ in $(seq 1 60); do grep -q '\[desktop\] mode: attach' "$ATTACH_HOME/.traceroost/desktop.log" 2>/dev/null && break; sleep 0.5; done
grep -q '\[desktop\] mode: attach' "$ATTACH_HOME/.traceroost/desktop.log" 2>/dev/null && ok "the app attached to it" || { bad "the app did not attach"; cat "$ATTACH_HOME/.traceroost/desktop.log" "$ATTACH_HOME/app.log" 2>/dev/null || true; }
[ "$(pgrep -u tester -f 'collector/standalone/server.js' | wc -l)" = 1 ] && ok "exactly one collector is running" || bad "a second collector was started"
# The app's main process is the one whose command line is the bare executable: the outside
# collector runs the same binary (as Node, with server.js), and Chromium's helpers carry --type=.
pkill -TERM -u tester -f "^$APP\$" || true
for _ in $(seq 1 40); do pgrep -u tester -f "^$APP\$" >/dev/null || break; sleep 0.5; done
grep -q 'the attached collector keeps running' "$ATTACH_HOME/.traceroost/desktop.log" && ok "the app quit, leaving the attached collector alone" || bad "the app's quit did not take the attached path"
kill -0 "$cli_pid" 2>/dev/null && ok "the outside collector is still running after the app quit" || bad "quitting the app stopped the outside collector"
kill -TERM "$cli_pid" 2>/dev/null || true

if homes_untouched; then ok "maintainer scripts left every home directory alone (install, upgrade)"; else bad "maintainer scripts left every home directory alone (install, upgrade)"; fi
check "user data intact after upgrade" grep -q keep /home/tester/.traceroost/sentinel.json

echo "── remove, purge, reinstall"
apt-get remove -y -qq traceroost-desktop >/dev/null
check "remove: /opt/TraceRoost gone" test ! -e /opt/TraceRoost
check "remove: /usr/bin/traceroost-desktop gone" test ! -e /usr/bin/traceroost-desktop
check "remove: launcher entry gone" test ! -e /usr/share/applications/traceroost-desktop.desktop
check "remove: AppArmor profile gone" test ! -e /etc/apparmor.d/traceroost-desktop
check "remove: user data kept" grep -q keep /home/tester/.traceroost/sentinel.json
apt-get install -y -qq "$DEB" >/dev/null
check "reinstall after remove" test -x "$APP"
apt-get purge -y -qq traceroost-desktop >/dev/null
check "purge: package gone" sh -c '! dpkg -l traceroost-desktop 2>/dev/null | grep -q "^[ir]"'
check "purge: user data still kept (it is the user's, in their home)" grep -q keep /home/tester/.traceroost/sentinel.json
apt-get install -y -qq "$DEB" >/dev/null
check "reinstall after purge" test -x "$APP"
if homes_untouched; then ok "maintainer scripts left every home directory alone (remove, purge, reinstall)"; else bad "maintainer scripts left every home directory alone (remove, purge, reinstall)"; fi

echo
echo "check-deb: $pass passed, $fail failed — $PRETTY_NAME $(dpkg --print-architecture)"
[ "$fail" -eq 0 ]
