#!/bin/bash
# TraceRoost .deb post-install.
#
# electron-builder's default (app-builder-lib/templates/linux/after-install.tpl, 26.15) with one
# deliberate change, marked "Sandbox" below. Like the default, it only registers the app with the
# system: the /usr/bin link, the desktop and MIME databases, the AppArmor profile and the mode of
# chrome-sandbox. It never touches a home directory, ~/.traceroost, or a systemd user unit.
#
# Shell variables are written $NAME, never with braces: electron-builder substitutes every
# brace-wrapped name in this file at build time, and fails the build on one it does not know.

APP_DIR='/opt/${sanitizedProductName}'
EXE='${executable}'

if type update-alternatives >/dev/null 2>&1; then
    # Remove previous link if it doesn't use update-alternatives
    if [ -L "/usr/bin/$EXE" -a -e "/usr/bin/$EXE" -a "$(readlink "/usr/bin/$EXE")" != "/etc/alternatives/$EXE" ]; then
        rm -f "/usr/bin/$EXE"
    fi
    update-alternatives --install "/usr/bin/$EXE" "$EXE" "$APP_DIR/$EXE" 100 || ln -sf "$APP_DIR/$EXE" "/usr/bin/$EXE"
else
    ln -sf "$APP_DIR/$EXE" "/usr/bin/$EXE"
fi

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi

# AppArmor profile (Ubuntu 24.04+): grants `userns` to this binary only, which is what Ubuntu's
# restriction on unprivileged user namespaces requires for Chromium's sandbox. Skipped where the
# running AppArmor cannot parse an abi/4.0 profile (Ubuntu 22.04, which has no such restriction).
PROFILE_LOADED=0
if apparmor_status --enabled > /dev/null 2>&1; then
  APPARMOR_PROFILE_SOURCE="$APP_DIR/resources/apparmor-profile"
  APPARMOR_PROFILE_TARGET="/etc/apparmor.d/$EXE"
  if apparmor_parser --skip-kernel-load --debug "$APPARMOR_PROFILE_SOURCE" > /dev/null 2>&1; then
    cp -f "$APPARMOR_PROFILE_SOURCE" "$APPARMOR_PROFILE_TARGET"
    # Live loading is meaningless in a chroot (an image being built); the profile loads at boot.
    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      apparmor_parser --replace --write-cache --skip-read-cache "$APPARMOR_PROFILE_TARGET" && PROFILE_LOADED=1
    fi
  else
    echo "Skipping the installation of the AppArmor profile as this version of AppArmor does not seem to support the bundled profile"
  fi
fi

# Sandbox. Chromium's sandbox needs either unprivileged user namespaces or a setuid-root
# chrome-sandbox helper. The upstream template decides between them by running `unshare --user`
# *as root* — which always succeeds, because root is exempt from both Ubuntu's AppArmor restriction
# and Debian's kernel.unprivileged_userns_clone=0. On exactly the systems that need the helper it
# was then left non-setuid, and the app aborted at launch ("The SUID sandbox helper binary was
# found, but is not configured correctly").
#
# So: namespaces count as available if the profile above was loaded (it grants them to this
# binary specifically), or if an unprivileged user can create one *and use it* — map itself to
# root inside and create a network namespace there, as the sandbox does. A bare `unshare --user`
# is not enough: Ubuntu's restriction lets an unconfined process create the namespace and then
# withholds every capability inside it, so that test passes on precisely the systems where
# Chromium's sandbox then fails. Otherwise the helper is made
# setuid root, as Chrome's own package always does. Chromium prefers namespaces whenever they
# work, so the helper being setuid on a system that did not need it changes nothing at run time.
unprivileged_userns_ok() {
  [ -L /proc/self/ns/user ] || return 1
  command -v setpriv > /dev/null 2>&1 || return 1
  setpriv --reuid=65534 --regid=65534 --clear-groups unshare --user --map-root-user --net true > /dev/null 2>&1
}
if [ "$PROFILE_LOADED" = 1 ] || unprivileged_userns_ok; then
  chmod 0755 "$APP_DIR/chrome-sandbox" || true
else
  chmod 4755 "$APP_DIR/chrome-sandbox" || true
fi
