# TraceRoost desktop shell (macOS, Linux, Windows)

An Electron shell that runs the existing standalone collector and dashboard as a normal desktop
app with a menu bar / tray icon — no terminal, no separately installed Node.

**Linux** (a .deb and an AppImage, x64 and arm64) is built and released in CI; see
[Linux](#linux). **Windows** (a one-click NSIS installer, x64 and
arm64, built and tested natively on each) is in [Windows](#windows). The rest of this section is
about macOS.

**Status: the macOS app is built, tested and released; signing and notarization wait on an Apple
Developer Program membership.**
The app builds as a `.app` and a DMG for arm64 and x64, verifies and smoke-tests itself,
ships its third-party notices and checksums, and is built in CI on every change. What it is **not**
is signed with a Developer ID or notarized, so a *downloaded* copy is refused by Gatekeeper until
the user right-clicks → Open. Signing and notarization are wired up and switch on when the
credentials exist — see [Signing and notarization](#signing-and-notarization) — and
[what is not done](#what-is-not-done-yet) lists the rest.

Nothing here changes the npm, VSIX, Docker or Homebrew builds. It consumes their output.

## Running it from a checkout

```sh
cd desktop
npm install          # Electron + electron-builder; deliberately not in the repo's pnpm workspace
pnpm run build       # type-check, bundle the main process, stage the collector, write the notices
pnpm start           # or: ./node_modules/.bin/electron .
```

`pnpm run build` type-checks `src/` against the Electron types, bundles the main process to
`out/main.js` with esbuild, runs [`scripts/stage-resources.mjs`](scripts/stage-resources.mjs) —
which builds the **core edition** at the repo root and copies what the app ships into
`resources/collector/` — and runs [`scripts/third-party-notices.mjs`](scripts/third-party-notices.mjs).

If `electron .` exits at once with no output, check for `ELECTRON_RUN_AS_NODE=1` in the
environment: a shell inside VS Code (or any Electron host) has it set, and it turns the Electron
binary into plain Node. `env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron .` fixes it.

## Packaging it

```sh
cd desktop
pnpm run pack        # arm64 + x64: dist/TraceRoost-<version>-mac-{arm64,x64}.dmg + SHA256SUMS
pnpm run pack:host   # this machine's architecture only — quicker while iterating
pnpm run smoke       # launch the packaged app for this architecture and check it end to end
```

`pack` is `build:release` (the same build, with the main process bundled `--production`) followed
by [electron-builder](https://www.electron.build) with [`electron-builder.cjs`](electron-builder.cjs),
then [`scripts/checksums.mjs`](scripts/checksums.mjs). The version on the artifact is the
collector's version from the repo root's `package.json`; `desktop/package.json`'s own version is
not consulted.

What goes into the `.app`:

| Where in `TraceRoost.app/Contents/Resources` | What |
| --- | --- |
| `app.asar` | `out/main.js` and `package.json` — the main process, and nothing else |
| `collector/` | the staged tree: `standalone/server.js`, `media/…`, `package.json`, `node_modules/sql.js/` |
| `tray/` | the menu bar template icons |
| `LICENSE`, `THIRD_PARTY_NOTICES.md` | this project's license; every bundled package's license and text |
| `LICENSE.electron.txt`, `LICENSES.chromium.html` | Electron's own, and the Chromium/Node notices it carries (on Linux and Windows, electron-builder puts these beside the executable instead, and only there) |

Two things in that layout are easy to lose and are checked for. `collector/node_modules/sql.js`
must be a real directory because the collector `require.resolve`s it at run time for its WASM, and
electron-builder's blanket `!**/node_modules/**` exclusion on copied resources would drop it — so
it is copied by a separate entry from inside the package. And the tray icons cannot live in
`build/`, because that is electron-builder's `buildResources` directory (the app icon source and
the entitlements) and is kept out of the app by design; `main.ts` reads them from
`<Resources>/tray` when packaged and from `build/` in development.

**Every packed `.app` is verified before it is signed or wrapped** by
[`scripts/afterPack.cjs`](scripts/afterPack.cjs): the layout above is present; the staged
collector, the repo and the app's `Info.plist` agree on the version; the collector bundles *inside
the .app* and the main-process bundle pass the repo's core-edition check
(`scripts/check-edition.mjs --tree`, one marker list, no copy); and the packaged Electron,
re-entered as Node, is a Node the collector supports. A failure fails the build. The first build of
this packaging produced a launchable app with no `sql.js` in it, which is why the layout check
exists.

`pnpm run smoke` ([`scripts/smoke-packaged.mjs`](scripts/smoke-packaged.mjs)) then launches the
built `.app` the way the Finder would — with `HOME` redirected, so the collector's agent
auto-configuration cannot touch your real `~/.claude/settings.json` — and checks: the collector
claims the data dir with the configured ports and the shipped version, `/health`, the identity
probe, the dashboard page and a real asset serve, `desktop.log` records owned mode, and a SIGTERM
to the app (`traceroost-desktop --quit` on Windows) stops the collector over the [owner
channel](#stopping-the-collector-the-owner-channel), releases the lock and exits 0 with no orphan
left behind. It proves the flush rather than assuming it: a span is sent just before quitting,
inside the collector's one-second save debounce, and must be in `spans.json` afterwards, saved by
the collector's own shutdown.

### Installing

Open the DMG and drag TraceRoost to Applications. Then:

- **An unsigned build** (every build until the Apple credentials exist): the first open is refused
  with "cannot be opened because the developer cannot be verified" or "is damaged". That is
  Gatekeeper reacting to the quarantine flag on a downloaded, un-notarized app. Right-click the app
  → **Open**, then **Open** again in the dialog; macOS remembers the choice. Or clear the flag:
  `xattr -d com.apple.quarantine /Applications/TraceRoost.app`. A build you made locally has no
  quarantine flag and opens normally.
- **A signed and notarized build** opens like any other app.

Check a download against the release's `TraceRoost-desktop-<v>-SHA256SUMS` with
`shasum -a 256 -c TraceRoost-desktop-<v>-SHA256SUMS --ignore-missing` in the directory holding the
files. (A local `pnpm run pack` writes a plain `dist/SHA256SUMS`.) Releases attach the macOS files
under their plain names once they are notarized, and as `*-preview` until then; see [Releases](#releases).

On first launch the app decides who owns the data directory (below), starts a collector if nothing
else does, and opens the dashboard. It uses the same `~/.traceroost` data directory and
`~/.traceroost/config.json` (ports, data dir, bind host, token) as `npx traceroost` and the
Homebrew service, so existing data appears as is. It creates `~/.traceroost/desktop.log`
(owner-only, rotated at 5 MB with one generation kept) and, like every collector, asks once —
in a dashboard banner, since it has no terminal — before setting up the coding agents on the
machine to send telemetry to it; the answer is shared with `npx traceroost` and the service.

Requires macOS 12 or later. Git is optional: without it, sessions are still recorded but commit
outcomes are unavailable, and the menu bar says so.

### Signing and notarization

[`electron-builder.cjs`](electron-builder.cjs) reads the environment and nothing else branches on
it, so the switch from the current unsigned CI artifact to a shippable one is a secrets change:

| Environment | Effect |
| --- | --- |
| nothing | **ad-hoc signed**, hardened runtime off, no notarization. Launches locally; refused by Gatekeeper when downloaded |
| `CSC_NAME` naming a *Developer ID Application* identity in the keychain (without the `Developer ID Application: ` prefix; CI imports the `.p12` into a job keychain and passes its SHA-1 plus `CSC_KEYCHAIN`). Not `CSC_LINK`: electron-builder 26.15.3 fails to import a `.p12` that way | signed with that identity under the hardened runtime, with [`build/entitlements.mac.plist`](build/entitlements.mac.plist) |
| …plus `APPLE_API_KEY` (path to an App Store Connect API `.p8`), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` — or `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | …and notarized and stapled |

Ad-hoc is explicit rather than electron-builder's default (which is to skip signing entirely when
no identity is found): Apple Silicon refuses to launch an unsigned binary whose bundle differs from
the one Electron shipped, so an unsigned build would pass every check and then die on launch. The
hardened runtime is off on the ad-hoc path because it enforces library validation, which rejects
the pre-signed Electron frameworks under an ad-hoc identity; it is only meaningful with a real one.

The CI job ([`.github/workflows/desktop-macos.yml`](../.github/workflows/desktop-macos.yml))
maps repository secrets onto those variables: `MAC_CSC_LINK` and `MAC_CSC_KEY_PASSWORD` (the
`.p12`), and either `APPLE_API_KEY_P8`, `APPLE_API_KEY_ID` and `APPLE_API_ISSUER` or `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`. Until they exist the job builds ad-hoc, exactly
as a developer's machine does; with only half of them it fails. Creating them is
[`runbooks/MACOS_SIGNING.md`](../runbooks/MACOS_SIGNING.md).

`pnpm run rehearse:mac-signing` (after `pnpm run pack:host`) re-signs the packed app with a
throwaway self-signed identity under the hardened runtime and the production entitlements, and
runs the smoke test against it — the signed path, minus what only Apple's certificate can prove
(notarization, Gatekeeper, library validation). See the script's header. The membership itself is **US$99/year**
([Apple](https://developer.apple.com/programs/whats-included/)).

## Linux

```sh
cd desktop
pnpm run pack:linux        # x64 + arm64: dist/TraceRoost-<v>-linux-{amd64,arm64}.deb,
                           #              dist/TraceRoost-<v>-linux-{x86_64,arm64}.AppImage, SHA256SUMS
pnpm run pack:linux:host   # this machine's architecture only
```

Both build on Linux natively (what CI does) or cross-build from macOS — electron-builder fetches
the Linux Electron, fpm and the AppImage tools itself. A cross-build skips only afterPack's
"run the packaged Electron as Node" check. Each format uses its own architecture names, as the
download chooser lists them: `amd64`/`arm64` for the .deb, `x86_64`/`arm64` for the AppImage.

### Installing

- **.deb** (Debian 12, Ubuntu 22.04 and 24.04, and their derivatives):
  `sudo apt install ./TraceRoost-<version>-linux-amd64.deb`. It installs to `/opt/TraceRoost`,
  links `/usr/bin/traceroost-desktop` (not `traceroost`, which is the npm/Homebrew CLI), adds a
  launcher entry and hicolor icons at every standard size, and depends only on distribution
  packages — never on `nodejs`.
- **AppImage** (any mainstream x64 or arm64 distribution): `chmod +x TraceRoost-*.AppImage` and
  run it. No root and no install step. It uses the static AppImage runtime, so no `libfuse2` is
  needed (`fusermount` from fuse or fuse3 is, as for any AppImage; without FUSE at all,
  `./TraceRoost-*.AppImage --appimage-extract-and-run` works). On first run it *offers* to add
  itself to the applications menu and does nothing unless you say yes — **TraceRoost → Show in
  Applications Menu** changes your answer later.

Both use the same `~/.traceroost` data directory, `config.json` and `desktop.log` as every other
TraceRoost (no move to XDG directories), so existing data appears as is. The app's own settings —
answers to the questions below — are in `~/.config/TraceRoost/desktop-prefs.json`.

### The sandbox, and why the AppImage refuses to start on Ubuntu 23.10+

The dashboard window renders content captured from coding agents, so its renderer always runs in
Chromium's sandbox. **There is no way to turn that off**: started with `--no-sandbox`, the app shows
why and exits ([`src/sandbox.ts`](src/sandbox.ts)). The sandbox needs unprivileged user namespaces,
or a setuid-root `chrome-sandbox` helper:

| System | .deb | AppImage |
| --- | --- | --- |
| Ubuntu 23.10+ (namespaces restricted by AppArmor) | the package installs `/etc/apparmor.d/traceroost-desktop`, granting `userns` to `/opt/TraceRoost/traceroost-desktop` only | **refuses to start** — it cannot install a profile |
| namespaces available (Fedora, Arch, openSUSE, Debian, Ubuntu ≤ 23.04) | namespace sandbox | namespace sandbox |
| namespaces disabled (`kernel.unprivileged_userns_clone=0`, some hardened kernels) | setuid `chrome-sandbox` | refuses to start (its mount is `nosuid`) |

The AppImage refusal is deliberate. electron-builder's AppImage launcher responds to restricted
namespaces by adding `--no-sandbox`; the app refuses that rather than run untrusted content
unsandboxed, and the dialog says to install the .deb. A hand-written profile for the AppImage
does not help, because the launcher decides by running `/usr/bin/unshare`, which that profile
does not cover.

The .deb's post-install is electron-builder's own, with one fix
([`build/linux/after-install.tpl`](build/linux/after-install.tpl)): upstream decides whether the
helper needs to be setuid by testing namespaces *as root*, which always passes, so on exactly the
systems that needed the helper the app aborted at launch. It now tests as an unprivileged user,
and in a way Ubuntu's restriction cannot pass (create the namespace *and use it*).

### Tray, or no tray

Electron's tray on Linux is a StatusNotifierItem. KDE Plasma, Cinnamon, XFCE, MATE, Budgie and
Ubuntu's GNOME (with its bundled AppIndicator extension) show it. **Stock GNOME on Fedora and
Debian does not.** The app asks the session bus whether a `StatusNotifierWatcher` is present
([`src/trayHost.ts`](src/trayHost.ts)), and checks again each time the window is closed. If it
cannot tell, it assumes there is no tray:

| | tray | no tray |
| --- | --- | --- |
| close the window | hides it; collection continues behind the tray icon | asks: **Quit and Stop Collecting**, **Keep Running Minimised** or Cancel, with "Remember my choice". If nothing of ours is collecting (attached to another collector, or stopped), it just quits |
| Launch at Login | starts with no window | starts with a minimised window — the only sign it is running |
| a collector needing confirmation, or a blocked start | shown in the tray menu | asked or explained in a dialog straight away |

Wherever the tray is, the same controls are also in the window's **TraceRoost** menu (Start /
Stop / Restart, Open Logs, Launch at Login, Show in Applications Menu, About, Quit). Without a
tray, that menu is the only place they live. The tray icon is the glyph on its teal tile
(`build/trayLinux.png`), legible on both dark and light panels; the macOS template glyph would
vanish on a dark one.

### Launch at Login, and the systemd user service

**Launch at Login** writes `~/.config/autostart/traceroost-desktop.desktop` (honouring
`$XDG_CONFIG_HOME`) when you turn it on and deletes it when you turn it off
([`src/autostart.ts`](src/autostart.ts)). It starts *this app*, never a collector. It points at the
app's current path, which matters for an AppImage: moving the file and running it once repoints
the entry, and `TryExec` makes the session skip it silently if the file is gone. A file there that
TraceRoost did not write is never edited or removed.

`traceroost service install` (npm or Homebrew) runs the collector as a **systemd user unit**,
`~/.config/systemd/user/traceroost.service`. The app never creates, edits, stops or disables it,
and it never starts a second collector beside it ([`src/systemdUnit.ts`](src/systemdUnit.ts)):

- **Service running** → the app attaches, exactly as on macOS: no Start/Stop/Restart, and Quit
  leaves the service running.
- **Service enabled, app opened at login** → both start as the session comes up. The app waits
  (up to a minute) for the service to claim the data directory, then attaches, instead of racing
  it for the lock.
- **Service enabled but stopped, app opened by hand** → the documented handoff (below): the app
  takes the data directory.
- **Turning on Launch at Login with the service enabled** → the app says the service already
  starts collection at login, and that it will attach to it.

Handoff is the same as on macOS, with `systemctl --user` in place of launchd. To go from the app
to the service, quit the app, then `traceroost service install`. To go from the service to the
app, `traceroost service stop` (or `uninstall`), then open the app. The app will not stop the
service for you.

### Verifying a download

```sh
sha256sum -c TraceRoost-desktop-<v>-SHA256SUMS --ignore-missing
minisign -Vm TraceRoost-desktop-<v>-SHA256SUMS -P <public key>      # once releases are signed — see below
```

The checksums file is the Linux integrity story: there is no package signature until an APT repository
exists (the plan's Stage 5). CI signs it with minisign when the `MINISIGN_SECRET_KEY` and
`MINISIGN_PASSWORD` secrets exist (`minisign -G` makes the pair). **No key exists yet**: the
public key goes here and in the release notes when one is made.

### Uninstalling

- **.deb**: `sudo apt remove traceroost-desktop` removes the app, `/usr/bin/traceroost-desktop`,
  the launcher entry and the AppArmor profile. `apt purge` does the same — there is no
  system-wide configuration to purge.
- **AppImage**: delete the file, and, if you added them, `~/.local/share/applications/traceroost-appimage.desktop`
  and `~/.local/share/icons/hicolor/512x512/apps/traceroost-appimage.png` (or untick **Show in
  Applications Menu** first).

Either way, turn off **Launch at Login** first (or delete
`~/.config/autostart/traceroost-desktop.desktop`). **Your data is kept**: package removal never
touches a home directory, so `~/.traceroost` and any `traceroost service` stay as they were.
Delete `~/.traceroost` yourself if you want the data gone, and `~/.config/TraceRoost` for the
app's own settings and Chromium state.

### Testing the packages

Two scripts check the plan's gates on a clean system. Run each as root in a throwaway container or
VM:

- [`scripts/check-deb.sh`](scripts/check-deb.sh) covers install, upgrade from an older version,
  the layout and icons, dependency resolution (`ldd` finds every library), the bundled Node, the
  smoke test as an unprivileged user, attaching to a collector the app did not start (and leaving
  it running), remove, reinstall, purge, and that no maintainer script touches a home directory.
- [`scripts/check-appimage.sh`](scripts/check-appimage.sh) runs the smoke test sandboxed where
  namespaces are usable. Where they are restricted, it checks that the app refuses: no collector,
  no renderer.

```sh
docker run --rm --security-opt seccomp=unconfined --security-opt apparmor=unconfined --cap-add SYS_ADMIN \
  -v "$PWD:/desktop:ro" ubuntu:24.04 /desktop/scripts/check-deb.sh /desktop/dist/TraceRoost-<v>-linux-arm64.deb
```

The container options are needed because Docker's default seccomp policy refuses the namespaces
Chromium's sandbox creates, on any host. The smoke test itself runs on the app's own Electron as
Node, which also proves the machine needs no Node.

**CI**: [`desktop-linux.yml`](../.github/workflows/desktop-linux.yml) builds both formats natively
on x64 and arm64 runners. It runs `check-deb.sh` on ubuntu:22.04, ubuntu:24.04 and debian:12, and
directly on the Ubuntu 24.04 runner, where the AppArmor profile must load and be what lets the
sandbox start. It runs `check-appimage.sh` on the runner with namespaces restricted (must refuse)
and unrestricted (must run), and on Fedora, openSUSE Tumbleweed and Arch.

### Supported matrix (what has actually been run)

| | Result | Where |
| --- | --- | --- |
| .deb on Ubuntu 24.04, 22.04, Debian 12 — arm64 | 37/37 `check-deb.sh` checks | containers on an arm64 Ubuntu 24.04 kernel with the namespace restriction on, so the setuid-helper path ran (AppArmor cannot load a profile from inside a container) |
| AppImage on Ubuntu 24.04, Fedora 42, openSUSE Tumbleweed — arm64 | refuses as designed: no collector, no renderer; dialog verified by screenshot | same kernel, restriction on |
| x64 (both formats); AppImage running sandboxed; .deb with its AppArmor profile loaded; Arch | built, not run here | `desktop-linux.yml` — **not yet run** |
| a real desktop session: tray on GNOME (Ubuntu and stock), KDE Plasma, XFCE; Wayland and X11; window restore and single-instance focus | **not run** | needs VMs with a desktop; the logic is unit-tested and the no-tray path ran under Xvfb |

## Windows

```powershell
cd desktop
pnpm run pack:win        # x64 + arm64: dist\TraceRoost-<v>-win-{x64,arm64}.exe (installer), SHA256SUMS
pnpm run pack:win:host   # this machine's architecture only
pnpm run smoke           # the packaged app for this architecture, end to end
node scripts/check-nsis.mjs dist\TraceRoost-<v>-win-x64.exe   # install, run, upgrade over the running app, uninstall
```

`pack:win` runs electron-builder once per architecture (given both at once, NSIS would build one
installer carrying both apps). CI builds each natively — x64 on `windows-latest`, arm64 on
`windows-11-arm` — so afterPack runs the packaged Electron as Node and the smoke test and installer
checks run the real binaries. A cross-build from Linux works with Wine (electron-builder runs the
NSIS stub under it to extract the uninstaller; 32-bit Wine is needed) and skips only the runtime
check.

What the installed app looks like, beside the macOS table above:

| In `%LOCALAPPDATA%\Programs\traceroost-desktop` | What |
| --- | --- |
| `traceroost-desktop.exe` | the app — not `traceroost.exe`, which is the npm CLI's name and may be on PATH beside it |
| `resources\app.asar`, `resources\collector\`, `LICENSE`… | as on macOS |
| `resources\tray\trayWindows.ico` | the notification-area icon: the glyph on its teal tile, 16–64 px, legible on dark and light taskbars |
| `Uninstall traceroost-desktop.exe` | the uninstaller |

Icons are made by [`scripts/make-icons.mjs`](scripts/make-icons.mjs) from the committed tile PNGs
(`node scripts/make-icons.mjs --ico` runs that step alone, on any OS): `build/icon.ico` (app,
installer and uninstaller, 16–256) and `build/trayWindows.ico`.

### Installing

Double-click `TraceRoost-<v>-win-x64.exe` (or `-win-arm64.exe` on Windows on Arm). It is a
one-click installer: no pages to step through, no administrator rights and no UAC prompt. It
installs **for the current user** into `%LOCALAPPDATA%\Programs\traceroost-desktop`, adds
**Start Menu → TraceRoost** and an entry in **Settings → Apps**, and opens the app. Running a newer
installer upgrades in place. A silent install is `TraceRoost-<v>-win-x64.exe /S`.

Requires Windows 10 or 11. Like every TraceRoost it uses `%USERPROFILE%\.traceroost` for data,
`config.json` and `desktop.log`, so existing data appears as is; the app's own settings and
Chromium state are in `%APPDATA%\TraceRoost`. It sits in the notification area: a left click opens
the dashboard, a right click shows the menu, and closing the window leaves collection running
there (the same controls are also in the window's **TraceRoost** menu). **Launch at Login** is a
value under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`; it starts the app with no window.

**SmartScreen.** Until a code-signing certificate is configured (below) the installer, the app and
the uninstaller are unsigned, and the first run of a *downloaded* copy shows "Windows protected your
PC". Click **More info → Run anyway**; Windows remembers the choice for that file. Until then releases
attach the Windows builds as previews, named `TraceRoost-<v>-win-<arch>-preview.exe` so that is
never a surprise (see
[Releases](#releases)). Check a download against the release's `TraceRoost-desktop-<v>-SHA256SUMS`:

```powershell
(Get-FileHash -Algorithm SHA256 .\TraceRoost-<v>-win-x64.exe).Hash.ToLower()   # compare with its line in the SHA256SUMS file
```

**Upgrading** is running a newer installer. It asks a running TraceRoost to quit first
(`traceroost-desktop --quit`, from [`build/installer.nsh`](build/installer.nsh)), which stops its
collector over the owner channel and waits for the flush, before it replaces any file.
electron-builder's own fallback — `Stop-Process`, which is TerminateProcess and would lose unsaved
spans — only runs if the app is still there 30 seconds later.

**The background service.** `traceroost service install` (npm) runs the collector as a Scheduled
Task. The app never creates, changes or stops it: with the service running, the app attaches to it
(Quit leaves it running), exactly as on macOS and Linux. To hand off from the app to the service,
quit the app, then `traceroost service install`; the other way, `traceroost service stop` (or
`uninstall`), then open the app.

### Signing

[`electron-builder.cjs`](electron-builder.cjs) reads the environment; nothing else branches on it:

| Environment | Effect |
| --- | --- |
| nothing | **unsigned**. Runs; SmartScreen warns on a downloaded copy until it builds reputation |
| `WIN_CSC_LINK` (base64 or path of a code-signing `.pfx`) + `WIN_CSC_KEY_PASSWORD` | the executables, installer and uninstaller signed with signtool and timestamped |
| `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` | the same, through [Azure Artifact Signing](https://learn.microsoft.com/azure/artifact-signing/) (takes precedence over a .pfx), with the profile fixed in `electron-builder.cjs`: account `TraceRoost` at `https://eus.codesigning.azure.net/`, certificate profile `traceroost-public`, publisher `Roger Reed`. `AZURE_TRUSTED_SIGNING_ENDPOINT`, `_ACCOUNT`, `_PROFILE` and `_PUBLISHER` override those |
| `TRACEROOST_WINDOWS_SIGNING=off` | **unsigned**, whatever credentials are set. In CI, set it as a repository variable (`gh variable set TRACEROOST_WINDOWS_SIGNING --body off`) to pause signing without deleting the secrets; releases then attach the Windows builds as previews. Delete the variable to sign again |

CI ([`.github/workflows/desktop-windows.yml`](../.github/workflows/desktop-windows.yml)) maps
repository secrets of the same names onto those variables (only the three service-principal
values are secrets), and once they exist it fails a build
whose executables do not carry a valid Authenticode signature rather than shipping it unsigned.
New OV/EV certificates are issued on hardware tokens or cloud HSMs and can no longer be exported
as a `.pfx`, so this project uses Azure Artifact Signing (a service principal with the *Artifact
Signing Certificate Profile Signer* role on the `TraceRoost` account).

### Uninstalling

**Settings → Apps → TraceRoost → Uninstall** (or `Uninstall traceroost-desktop.exe`, `/S` for
silent). It asks a running TraceRoost to quit first, as an upgrade does, then removes the app, the
Start Menu shortcut and the Apps entry. Turn off **Launch at Login** first, or remove the
`TraceRoost` value under `HKCU\…\Run` afterwards. **Your data is kept**: `%USERPROFILE%\.traceroost`
and any `traceroost service` are untouched; delete `.traceroost` yourself if you want the data
gone, and `%APPDATA%\TraceRoost` for the app's own settings.

### What CI proves

[`desktop-windows.yml`](../.github/workflows/desktop-windows.yml), on x64 and arm64: afterPack's
checks; the staged-collector suite on the runner's Electron (including the flushed stop over the
owner channel); the packaged smoke test; and
[`scripts/check-nsis.mjs`](scripts/check-nsis.mjs) — silent per-user install (files, Start Menu
shortcut, Uninstall entry, nothing under Program Files), the smoke test of the *installed* app,
a reinstall over the running app that must quit it through `--quit` with its spans saved (not kill
it), and a silent uninstall that removes the app, shortcut and entry and keeps the data directory.
On the arm64 runner the installer (electron-builder's NSIS stub is x86, so it runs emulated) takes
about four minutes for a fresh install; the arm64 payload is packed with the x86 BCJ 7z filter
because the installer's 7-Zip plugin cannot decode the ARM64 filter current 7-Zip picks by default
(it silently dropped every .exe and .dll — see `electron-builder.cjs`). Not covered by CI: a human
looking at the tray icon and menu on a real desktop, SmartScreen on a
downloaded copy, log-off/shutdown with the app running, and a
non-ASCII user profile path.

## How it fits together

```
Electron main process (out/main.js)
├── handshake.ts   reads <dataDir>/server.lock → may we attach, or is the dir free?
├── collector.ts   spawns ONE supervised child: the staged standalone/server.js,
│                  run by Electron's own binary re-entered as Node
├── tray.ts        the menu bar item; its contents come from trayMenu.ts
└── window.ts      one sandboxed window loading the collector's own dashboard
```

The collector is **not** forked or reimplemented. `resources/collector/` reproduces the directory
layout `standalone/server.js` expects of itself, so the same bundle that `npx traceroost` runs
executes unmodified inside the app:

| Staged path | Why it has to be exactly there |
| --- | --- |
| `standalone/server.js` | the collector; resolves everything below relative to its own `__dirname` |
| `media/…` | `path.join(__dirname, '..', 'media')` — the dashboard it serves |
| `package.json` | `readPackageManifest` — the version it reports, logs, and writes into its lock |
| `node_modules/sql.js/` | `require.resolve('sql.js')` and the `.wasm` beside it, for the outcomes cache |

### The runtime

The collector runs on **Electron's bundled Node**, via `ELECTRON_RUN_AS_NODE=1` on
`process.execPath`. Electron 44.7.1 bundles Node 24.21.0, which satisfies this repo's
`"engines": { "node": ">=24" }`, so no second runtime is packaged and the user needs none
installed.

**Re-check this on every Electron major.** `resources.ts` asserts it at startup and fails loudly
rather than letting the collector bundle die on unsupported syntax, and `afterPack.cjs` asserts it
against the packaged binary:

```sh
cd desktop && pnpm run runtime-check   # prints the bundled Node version
```

### Owned or attached — never both, never neither

Two collectors on one data directory overwrite each other's `spans.json`; that is what
[`standalone/dataDirLock.ts`](../standalone/dataDirLock.ts) exists to prevent, and the shell must
not be the thing that tries it. So before showing anything, the app asks who owns the data dir and
reaches one of five answers:

| Mode | When | What the app does |
| --- | --- | --- |
| **own** | nothing holds the lock, or its holder is dead | spawns and supervises a collector; Quit stops and flushes it |
| **attach** | a validated collector holds it | shows its dashboard; Start/Stop/Restart are **absent**; Quit leaves it running |
| **confirm-attach** | a collector holds it but publishes no version | asks first — attaching is an explicit act, not a guess |
| **wait** | a holder is mid-startup | re-runs the handshake shortly |
| **blocked** | another host, a foreign process on the port, or an incompatible version | collects nothing and says exactly why |

Attachment is judged from the writer's **own record** rather than anything self-reported over HTTP:
the lock file (pid, host, start time, service flag, bound ports, version), that the pid is alive on
this host, and an unauthenticated `/traceroost/standalone` probe on the port the lock names.
`/health` is never used for it — it answers `{status:'ok'}` with no identity, so it cannot tell a
TraceRoost collector from anything else returning 200.

`version` in the lock is the one change this feature made outside `desktop/` (plus `--tree`/`--bundles`
in `scripts/check-edition.mjs`, a quoted public-host exception there for the shell's link
allowlist, and build/test wiring). It is optional, so a collector from an older release simply
reports no version — which is why **confirm-attach** exists instead of a refusal.

#### Running alongside, or instead of, the Homebrew or npx service

The app never installs, removes or rewrites a background service. `traceroost service install`
(launchd, via npx or Homebrew) is a separately managed thing, and the two coexist like this:

- **Service running, app opened** → the app attaches. The menu bar shows the service's status,
  Start/Stop/Restart are absent, and Quit closes the window and the menu bar item only. Collection
  continues in the service.
- **No service, app opened** → the app owns a collector. Closing the window leaves it running in
  the menu bar; Quit stops and flushes it.
- **Hand off from the app to the service**: Quit the app (its collector stops and releases the data
  dir), then `traceroost service install`. Reopen the app and it attaches.
- **Hand off from the service to the app**: `traceroost service stop` (or `uninstall`, to also
  remove the launchd job), then open the app — it finds the data dir free and starts its own
  collector. The app refuses to do this step for you, by design: stopping a service the user set
  up separately is not this app's to do.
- **Launch at Login** registers *this app* through the OS login item API. It never adds a launchd
  collector, so enabling it alongside the service does not create a second writer — the app
  simply attaches at login.

### Stopping the collector: the owner channel

The collector is stopped the same way on every OS: the app sends it one message,
`{ type: 'traceroost:shutdown' }`, over the Node IPC channel it was spawned with, and the collector
runs exactly what its SIGTERM handler runs — save `spans.json` and the outcomes cache, release the
data-dir lock, exit 0 ([`standalone/ownerChannel.ts`](../standalone/ownerChannel.ts),
[`src/collector.ts`](src/collector.ts)). The app waits up to 10 seconds for that, and only then
kills it. This exists because Windows has no SIGTERM — `child.kill()` there is TerminateProcess,
which runs no handler, and is why owned mode used to be refused on Windows — but one path everywhere
is simpler than two, and SIGTERM and Ctrl-C still work on the collector exactly as before.

Why a pipe and not an HTTP endpoint: the channel is a pipe the app creates and only its child
inherits (a socketpair on macOS and Linux; on Windows a single-instance named pipe that is already
connected when the child starts). There is nothing to connect to, so no web page — whatever its
origin, whatever reaches 127.0.0.1 — and no other local user or process can send the request, and
there is no token to keep away from the dashboard page. The collector opens the channel only when
the app asks for it (`TRACEROOST_OWNER_CHANNEL=ipc`) *and* it really has one; `npx traceroost`, the
background services and Docker have neither and are unchanged. Any other message is ignored.

If the channel closes without a request — the app crashed, or was ended from Task Manager — the
collector treats that as the request: it flushes and exits rather than outliving its owner with
the data dir locked. On Windows, the app also asks for the flush when the session ends (log off,
shut down), since Windows ends both processes then without a Quit.

### What the renderer can do

Nothing. The window is sandboxed, context-isolated, has no Node integration and **no preload
script** — and that last one is the point: a preload is the only route IPC takes into a renderer,
so without one there is no channel for trace content to reach the main process through. The app's
controls live in the tray, which is what makes that possible.

The page displays prompts, tool calls and tool output captured from coding agents. That is
untrusted input, so [`navigation.ts`](src/navigation.ts) decides every navigation by origin: the
dashboard origin loads in-window, `https` to an allowlisted host goes to the system browser, and
everything else — every other origin, and every non-`http` scheme, `file:` above all — is dropped.
Permission requests are all refused, downloads and webviews are blocked, and nothing opens a second
window.

### Privacy

Local-only, as the plan requires: no account, no network dependency, no analytics, and
`crashReporter` is deliberately never started, so there is no upload path to misconfigure. The
log (`<dataDir>/desktop.log`, owner-only, rotated at 5 MB with one generation kept) holds the
collector's stdout and stays on the machine. Signing and notarization, when enabled, upload the
app bundle to Apple — the code, never any data.

The shell registers **no launchd job**. "Launch at Login" registers *this app* through the OS login
item API; the `traceroost service install` job is a separately managed thing the app attaches to,
never duplicates or rewrites.

## Uninstalling

1. If **Launch at Login** is on, turn it off in the menu bar menu first (or afterwards under
   System Settings → General → Login Items, where a removed app shows as a stale entry).
2. Quit TraceRoost. If it owned a collector, that flushes and stops it.
3. Drag `TraceRoost.app` to the Trash.

Removing the app **keeps your data**: `~/.traceroost` (spans, config, the outcomes cache, the
desktop log) is untouched, and so is any `traceroost service` you installed separately — it keeps
running, and `npx traceroost`, Homebrew and the VS Code extension keep working with the same data.
Delete `~/.traceroost` yourself if you want the data gone; run `traceroost service uninstall` if
you want the service gone. The app's own Electron state is in
`~/Library/Application Support/traceroost-desktop` and can be deleted too. The coding agents the
collector configured keep their telemetry endpoint settings; with no collector listening they
simply fail to deliver, and `traceroost` (npx or Homebrew) reconfigures them on its next start.

## Tests

Desktop tests run with the rest of the repo's suite — `pnpm run test:unit` at the root — and are
compiled by [`tsconfig.test.desktop.json`](../tsconfig.test.desktop.json). `desktop/src` is
linted by the repo's `pnpm run lint`, with the same rules and the same cloud-import boundary as
`src/`.

- **Unit** (`src/*.test.ts`): the attach decision table, version compatibility, restart backoff,
  mode resolution, navigation rules, tray labelling and enablement, log rotation, URL/token
  handling, and the supervisor driven against a stub collector (readiness, graceful stop, crash
  restart, forced kill of a wedged child).
- **Integration** (`src/stagedCollector.test.ts`): the real staged collector started by the real
  supervisor on Electron's Node — ports, `/health`, the identity probe, the dashboard page and a
  real asset, `sql.js` resolution with its WASM, version in the lock, and a graceful stop that
  releases the dir. **Skipped** (not failed) when `resources/collector` or the Electron binary is
  absent, so a checkout that has not run `pnpm run build` here needs no 300 MB download to run the
  repo's suite.
- **Owner channel** ([`standalone/ownerChannel.test.ts`](../standalone/ownerChannel.test.ts)): only
  the exact shutdown message is honoured, only when asked for and with a real channel, once; and a
  real child process flushes and exits 0 on the request and on the channel closing — on every OS
  in the repo's CI, Windows included.
- **Packaged** (`pnpm run smoke`, above): the built app, launched and quit, with the flush proved;
  on Windows also `scripts/check-nsis.mjs` (install, upgrade over a running app, uninstall).

These tests redirect `HOME` to a temporary directory. The collector **auto-configures the agents it
finds at startup**, writing OTEL endpoints into `~/.claude/settings.json`, `~/.codex/config.toml`
and VS Code's settings. Running one against the real `HOME` points a developer's live agents at a
test port that is about to disappear. `stagedCollector.test.ts` and the smoke test both assert the
redirection holds; keep it that way in anything added here.

**CI**: [`desktop-macos.yml`](../.github/workflows/desktop-macos.yml) runs on every pull request
that touches the desktop, collector, dashboard or build inputs (and on `main` for `desktop/`
changes). On an Apple Silicon runner it builds and packs both architectures (afterPack verifying
each), smoke-tests the arm64 app, runs the staged-collector integration suite, prints the
signature state, and uploads the DMGs, `SHA256SUMS` and `THIRD_PARTY_NOTICES.md` as a build
artifact for 14 days. [`desktop-linux.yml`](../.github/workflows/desktop-linux.yml) does the same
for the .deb and AppImage on native x64 and arm64 runners, then installs and runs them across the
distro matrix, and [`desktop-windows.yml`](../.github/workflows/desktop-windows.yml) for the NSIS
installer on native x64 and arm64 Windows runners (see [Windows](#windows)).

## Releases

A `v*` tag's `release.yml` run calls [`desktop-release.yml`](../.github/workflows/desktop-release.yml)
(its `desktop` job) once `package` has passed and created the GitHub release. That calls the three
workflows above, waits for their jobs, re-verifies each artifact against the SHA256SUMS its build
wrote (`scripts/release-assets.mjs`, tested by `desktop/src/releaseAssets.test.ts`), and attaches the
installers, one `TraceRoost-desktop-<v>-SHA256SUMS` and build-provenance attestations. The version is
the repo's `package.json` version, which `package` has checked against the tag.

| Platform | Attached to a release when |
| --- | --- |
| Linux (.deb, AppImage; x64, arm64) | always, once the build and install matrix pass |
| macOS (DMG; arm64, x64) | the build is Developer ID signed and notarized — `desktop-macos.yml` checks with `stapler validate` and `spctl`. Until the Apple secrets exist it is built and tested on every release and attached as a `*-preview` (below) |
| Windows (NSIS installer .exe; x64, arm64) | the build is Authenticode-signed (`WIN_CSC_LINK` or Azure Artifact Signing) — `desktop-windows.yml` checks every executable with `Get-AuthenticodeSignature`. Until then it is built and tested on every release and attached as a `*-preview` (below) |

**Preview builds.** Until a platform's signing secrets exist, a release attaches its ad-hoc signed
(not notarized) macOS build or unsigned Windows build as a preview:
`TraceRoost-<v>-mac-<arch>-preview.dmg` and `TraceRoost-<v>-win-<arch>-preview.exe`, labelled
"(preview)" on the release page — the same bytes CI tested, in the same SHA256SUMS, with
attestations — and adds a section to the release notes on opening them (Gatekeeper: right-click →
Open; SmartScreen: More info → Run anyway). A platform is attached signed or as a preview, never
both, and a later signed build of the same version cannot collide with a preview by name.

Platforms are independent: if one platform's build fails, the others are still attached. The
repository variable `TRACEROOST_DESKTOP_PLATFORMS` (default `linux,macos,windows`) switches a
platform off without a code change, and a non-`core` release edition skips desktop entirely. A desktop failure
never blocks the VSIX, npm or Docker publish. Files already on a release are never replaced; a re-run
uploads only what is missing and fails on a same-named file with different bytes. A pull request
that changes `desktop-release.yml` or the assembly script runs everything except attest and upload.

## What is not done yet

Linux, beyond the [matrix](#supported-matrix-what-has-actually-been-run) above:

- **Real desktop sessions.** The tray (GNOME stock and Ubuntu, KDE Plasma, XFCE; Wayland and
  X11), the close question, the minimised login launch, the AppImage menu entry and Launch at
  Login have been unit-tested and run under Xvfb, but never in a real desktop.
- **A minisign key** for the release checksums. Releases attach the Linux installers without one
  (with SHA256 checksums only); the Linux rows in the download chooser wait for it.
- **Updates.** The AppImage could self-update (electron-updater supports it) and the .deb would
  show a notice. Both follow the shared update rules, which macOS has not built yet either.
- **arm64 downloads** wait for the arm64 CI legs to pass.
- **Stage 5** (an APT repository, Flatpak, Snap) is not started.

macOS:

Needs the Apple Developer Program membership and the secrets above:

- **Developer ID signing, notarization and stapling** — the code path exists and is exercised by
  the config, but nothing has been through it, and nothing here has been through Gatekeeper. The
  validation that matters is a *downloaded, quarantined* artifact opening on a fresh user account.

Stage 4, not started:

- **Automatic updates** — signed artifacts from a trusted manifest origin, coordinated collector
  shutdown, recoverable interrupted installs, and a guard against opening migrated data with an
  older collector (a binary rollback is not a database rollback). Electron's macOS updater refuses
  unsigned apps, so the most that can be built before signing is a *notice* that a release exists.
  Desktop update notices must stay separate from the existing npm version check and honour the
  no-update-check preference.
- **The packaged smoke matrix** — the smoke test above covers owned startup, serving and a clean
  quit on arm64. Still to script: offline launch, port collisions, stale locks, crash recovery,
  login, sleep, update failure and Homebrew-service attachment; and all of it on an Intel Mac,
  which CI's Apple Silicon runner cannot do natively (the x64 build is produced but not launched).

Smaller, genuinely open items:

- **Windows, beyond CI** ([what CI proves](#what-ci-proves)): code signing (the Azure Artifact
  Signing account and profile exist; the three service-principal secrets are not set in CI yet), a human check of the tray icon, menu
  and close-to-tray on a real desktop, SmartScreen on a downloaded copy, the all-users install,
  log-off with the app running, automatic updates, and winget/Microsoft Store listings.
- **Unverified in a GUI session:** clicking the window's close button (close-to-menu-bar), Dock
  reopen, the Launch at Login toggle actually registering a login item, sleep/wake, and how the
  template icon looks in a light vs dark menu bar. The code paths exist and the equivalent
  programmatic paths were exercised; the human-interaction ones were not.
