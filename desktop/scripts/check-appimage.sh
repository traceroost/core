#!/usr/bin/env bash
# Runs the TraceRoost AppImage on a clean Debian/Ubuntu, Fedora, openSUSE or Arch system, as an unprivileged
# user, and checks the Linux plan's Stage 3 gate: it runs with the sandbox enabled, or refuses
# clearly — never unsandboxed.
#
#   - Where an unprivileged user can create a usable user namespace, the AppImage must come up
#     sandboxed and pass scripts/smoke-packaged.mjs (owned collector, dashboard, clean quit), with
#     nothing written to the applications menu or autostart unasked.
#   - Where it cannot (Ubuntu 23.10+'s AppArmor restriction — an AppImage cannot install the profile
#     that lifts it), electron-builder's launcher adds --no-sandbox and the app must refuse: say so
#     in desktop.log, start no collector, and run no renderer.
#
# FUSE is not needed: the AppImage is run with APPIMAGE_EXTRACT_AND_RUN=1, which the static runtime
# supports, so this works in a container. Meant for a throwaway container or VM, as root:
#
#   docker run --rm -v "$PWD/desktop:/desktop:ro" fedora:42 /desktop/scripts/check-appimage.sh /desktop/dist/TraceRoost-<v>-linux-<arch>.AppImage

set -euo pipefail

IMAGE=${1:?usage: check-appimage.sh path/to/TraceRoost-<version>-linux-<arch>.AppImage}
HERE=$(cd "$(dirname "$0")" && pwd)

pass=0
fail=0
ok()  { echo "  ✔ $*"; pass=$((pass + 1)); }
bad() { echo "  ✘ $*"; fail=$((fail + 1)); }

. /etc/os-release
echo "check-appimage: $PRETTY_NAME, $(uname -m), $(basename "$IMAGE")"

# What a desktop install of each distribution already has (Electron's runtime libraries), plus the
# test's own tooling: Xvfb for a display, dbus for a session bus.
if command -v apt-get >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends xvfb xauth dbus dbus-x11 procps util-linux \
    libgtk-3-0 libnss3 libxss1 libxtst6 libgbm1 'libasound2t64|libasound2' libsecret-1-0 libnotify4 xdg-utils >/dev/null 2>&1 \
  || apt-get install -y -qq --no-install-recommends xvfb xauth dbus dbus-x11 procps util-linux \
    libgtk-3-0 libnss3 libxss1 libxtst6 libgbm1 libasound2 libsecret-1-0 libnotify4 xdg-utils >/dev/null
elif command -v dnf >/dev/null; then
  dnf install -y -q xorg-x11-server-Xvfb xorg-x11-xauth dbus-daemon dbus-x11 procps-ng util-linux \
    gtk3 nss libXScrnSaver libXtst mesa-libgbm alsa-lib libsecret libnotify xdg-utils which >/dev/null
elif command -v zypper >/dev/null; then
  zypper --non-interactive --quiet install --no-recommends xvfb-run xorg-x11-server-Xvfb xauth dbus-1 dbus-1-daemon procps util-linux \
    libgtk-3-0 mozilla-nss libXss1 libXtst6 libgbm1 libasound2 libsecret-1-0 libnotify4 xdg-utils which shadow >/dev/null
elif command -v pacman >/dev/null; then
  pacman -Sy --noconfirm --needed xorg-server-xvfb xorg-xauth dbus procps-ng util-linux \
    gtk3 nss libxss libxtst mesa alsa-lib libsecret libnotify xdg-utils which >/dev/null
else
  echo "check-appimage: no apt-get, dnf, zypper or pacman — unsupported test host"; exit 2
fi

useradd -m tester 2>/dev/null || true
install -d -o tester -g tester /home/tester/run
cp "$IMAGE" /home/tester/run/TraceRoost.AppImage
cp "$HERE/smoke-packaged.mjs" /home/tester/run/
chown -R tester:tester /home/tester/run
chmod +x /home/tester/run/TraceRoost.AppImage

as_tester() { su tester -c "cd /home/tester/run && export APPIMAGE_EXTRACT_AND_RUN=1 && $1"; }

# The same probe as the .deb's post-install: can an unprivileged user make a user namespace and
# use it? This is what decides whether electron-builder's launcher adds --no-sandbox.
if as_tester 'unshare --user --map-root-user --net true' 2>/dev/null; then
  echo "── user namespaces are usable: the AppImage must run sandboxed"
  # The harness runs on the AppImage's own Electron as Node — this host has no Node.
  as_tester './TraceRoost.AppImage --appimage-extract >/dev/null && mv squashfs-root extracted'
  if as_tester "dbus-run-session -- xvfb-run -a env ELECTRON_RUN_AS_NODE=1 ./extracted/traceroost-desktop smoke-packaged.mjs /home/tester/run/TraceRoost.AppImage" > /tmp/smoke.log 2>&1; then
    ok "smoke test passed ($(grep -c '✔' /tmp/smoke.log) checks)"
  else
    bad "smoke test failed"; cat /tmp/smoke.log
  fi
  grep -E '✔|✘' /tmp/smoke.log | sed 's/^/    /' || true
  [ ! -e /home/tester/.local/share/applications/traceroost-appimage.desktop ] && ok "no applications-menu entry written unasked" || bad "an applications-menu entry was written unasked"
else
  echo "── user namespaces are restricted here: the AppImage must refuse rather than run unsandboxed"
  home=$(as_tester 'mktemp -d /tmp/appimage-home-XXXXXX')
  as_tester "HOME=$home XDG_CONFIG_HOME=$home/.config DATA_DIR=$home/.traceroost UI_PORT=31900 OTLP_PORT=31918 MCP_PORT=31916 TRACEROOST_NO_UPDATE_CHECK=1 \
    dbus-run-session -- xvfb-run -a ./TraceRoost.AppImage > $home/out.log 2>&1 &"
  refused=0
  for _ in $(seq 1 120); do
    if grep -q 'refusing to start' "$home/.traceroost/desktop.log" 2>/dev/null; then refused=1; break; fi
    sleep 0.5
  done
  [ "$refused" = 1 ] && ok "the app refused to start, and said why in desktop.log" || { bad "the app did not record a refusal"; cat "$home/out.log" "$home/.traceroost/desktop.log" 2>/dev/null || true; }
  sleep 2
  [ ! -e "$home/.traceroost/server.lock" ] && ok "no collector was started" || bad "a collector was started"
  if pgrep -u tester -f -- '--type=renderer' >/dev/null; then bad "a renderer process is running unsandboxed"; else ok "no renderer process was started"; fi
  grep -q -- '--no-sandbox' /proc/[0-9]*/cmdline 2>/dev/null && echo "  · (the launcher did pass --no-sandbox, as expected — and was refused)"
  pkill -u tester -f TraceRoost || true
  pkill -u tester -f traceroost-desktop || true
fi

echo
echo "check-appimage: $pass passed, $fail failed — $PRETTY_NAME $(uname -m)"
[ "$fail" -eq 0 ]
