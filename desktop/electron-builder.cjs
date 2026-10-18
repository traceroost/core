/**
 * electron-builder configuration for the macOS DMG, the Linux .deb and AppImage, and the Windows
 * NSIS installer — one install format per platform (two on Linux, where no one format fits every
 * distribution), and no zip beside them: there is no auto-updater to consume one.
 *
 * A .cjs file rather than YAML because two decisions here depend on the environment, and spelling
 * them out as code is clearer than a config that silently means different things on different
 * machines:
 *
 *  1. **Signing.** With a Developer ID available (`CSC_LINK` + `CSC_KEY_PASSWORD` for a .p12 in
 *     CI, or `CSC_NAME` naming a certificate already in the login keychain), the app is signed
 *     with it under the hardened runtime, which is what notarization requires. Without one, the
 *     app is **ad-hoc signed** (`identity: "-"`). electron-builder has no automatic ad-hoc
 *     fallback — unsigned is the default — and an unsigned bundle whose resources differ from
 *     Electron's own is exactly the thing Apple Silicon refuses to launch, so the fallback is
 *     explicit here. Ad-hoc signing runs on this machine and passes a smoke test; it does not
 *     satisfy Gatekeeper for a downloaded copy. The hardened runtime is off in that case because
 *     it enforces library validation, which rejects the pre-signed Electron frameworks under an
 *     ad-hoc identity (the builder's own docs say so); it is only meaningful alongside a real
 *     identity anyway.
 *
 *  2. **Notarization.** On only when the app is being signed with a Developer ID *and* one of
 *     electron-builder's credential sets is in the environment (`APPLE_API_KEY` +
 *     `APPLE_API_KEY_ID` + `APPLE_API_ISSUER`, or `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` +
 *     `APPLE_TEAM_ID`). Asking the builder to notarize an ad-hoc build would fail the build for a
 *     reason that has nothing to do with the code.
 *
 * So the switch from "unsigned CI artifact" to "shippable release" is a secrets change — see
 * README.md → "Signing and notarization" and .github/workflows/desktop-macos.yml — not a code
 * change. Everything else here is the same on both paths.
 *
 * Windows signing is the same kind of switch (see `windowsSigning` below): a code-signing
 * certificate (`WIN_CSC_LINK` + `WIN_CSC_KEY_PASSWORD`) or Azure Trusted Signing (`AZURE_*`) signs
 * the executables, the installer and the uninstaller; with neither, the build is unsigned and
 * SmartScreen warns on first run ("More info → Run anyway").
 *
 * Linux needs no credentials at all: its integrity story is the published, signed SHA256SUMS (see
 * README.md → "Linux"), not a package signature. Two Linux choices are load-bearing and explained
 * where they are made below: the AppImage toolset (no FUSE2, and no `--no-sandbox` in its desktop
 * entry) and the .deb's AppArmor profile (electron-builder's own, granting the sandbox `userns`).
 *
 * Versioning: the app's version is the collector's version, read from the repo root's
 * package.json, so a DMG named 0.19.1 contains the 0.19.1 collector. desktop/package.json's own
 * version is not consulted (`extraMetadata` overrides it); scripts/afterPack.cjs asserts that the
 * staged collector agrees.
 */

const path = require('path')
const rootManifest = require('../package.json')
const afterPack = require('./scripts/afterPack.cjs')

// CI maps repository secrets onto these, and a secret that does not exist arrives as an empty
// string. electron-builder reads them itself and resolves an empty CSC_LINK as a path (the cwd:
// "desktop not a file"), so an empty value is removed here: absent and empty mean the same.
for (const name of [
  'CSC_LINK', 'CSC_KEY_PASSWORD', 'CSC_NAME',
  'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER',
  'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID',
  'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD',
  'AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET',
  'AZURE_TRUSTED_SIGNING_ENDPOINT', 'AZURE_TRUSTED_SIGNING_ACCOUNT', 'AZURE_TRUSTED_SIGNING_PROFILE',
  'AZURE_TRUSTED_SIGNING_PUBLISHER',
]) {
  if (process.env[name] === '') delete process.env[name]
}

// The NSIS installer carries the app as a 7z archive and unpacks it with the Nsis7z plugin, whose
// 7-Zip is older than the ARM64 branch filter. Current 7-Zip applies that filter to arm64 PE files
// by itself, so an arm64 installer installed every file *except* the .exe and .dlls — Nsis7z could
// not decode them, and the install still "succeeded" (seen on the windows-11-arm runner). Forcing
// the x86 BCJ filter, which Nsis7z has always understood, is lossless for any input; it only
// affects how well arm64 code compresses. A value set in the environment still wins.
if (!process.env.ELECTRON_BUILDER_7Z_FILTER) process.env.ELECTRON_BUILDER_7Z_FILTER = 'BCJ'

const hasDeveloperId = Boolean(process.env.CSC_LINK || process.env.CSC_NAME)
const hasNotaryCredentials =
  Boolean(process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER) ||
  Boolean(process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID)

/**
 * Windows signing, from the environment alone, in this order:
 *
 *  1. Azure Trusted Signing — `AZURE_TRUSTED_SIGNING_ENDPOINT`, `_ACCOUNT`, `_PROFILE` and
 *     `_PUBLISHER` (the certificate's subject CN) name the profile; `AZURE_TENANT_ID`,
 *     `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET` are the service principal electron-builder's
 *     `Invoke-TrustedSigning` authenticates with. Windows hosts only.
 *  2. A code-signing certificate — `WIN_CSC_LINK` (base64 or path of a .pfx/.p12) and
 *     `WIN_CSC_KEY_PASSWORD`, which electron-builder reads itself and hands to signtool.
 *  3. Neither — unsigned. Every Windows build until the owner has one of the above.
 */
const azureSigning = ['ENDPOINT', 'ACCOUNT', 'PROFILE', 'PUBLISHER'].every(k => process.env[`AZURE_TRUSTED_SIGNING_${k}`]) &&
  ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET'].every(k => process.env[k])
const certificateSigning = Boolean(process.env.WIN_CSC_LINK)
const windowsSigning = azureSigning ? 'azure' : certificateSigning ? 'certificate' : 'none'

if (process.platform === 'win32') {
  console.log(windowsSigning === 'none'
    ? 'electron-builder.config: no Windows signing credentials (WIN_CSC_LINK, or AZURE_TRUSTED_SIGNING_*) — unsigned; SmartScreen will warn on first run'
    : `electron-builder.config: Windows signing with ${windowsSigning === 'azure' ? 'Azure Trusted Signing' : 'the WIN_CSC_LINK certificate'}`)
}

if (process.platform !== 'darwin') {
  // Linux, Windows (and any cross-build) need none of the Apple credentials below.
} else if (!hasDeveloperId) {
  console.log('electron-builder.config: no Developer ID in the environment (CSC_LINK / CSC_NAME) — ad-hoc signing; the result will not pass Gatekeeper when downloaded')
} else if (!hasNotaryCredentials) {
  console.log('electron-builder.config: signing with a Developer ID but no notarization credentials are set — the app will be signed but not notarized')
}

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'com.traceroost.desktop',
  productName: 'TraceRoost',
  copyright: 'Copyright © 2026 Roger Reed',
  // Only ever built as the core edition; the staged collector is checked for that in afterPack.
  extraMetadata: { version: rootManifest.version },

  directories: {
    output: 'dist',
    // Holds icon.png (converted to .icns by the builder) and the entitlements. The builder keeps
    // this directory out of the app, which is why the tray PNGs below travel as extraResources.
    buildResources: 'build',
  },

  // The app itself is small: the bundled main process and its manifest. Everything the collector
  // needs lives outside the asar (extraResources) because it runs as a child process and
  // `require.resolve` cannot look inside an archive — see src/resources.ts.
  files: ['out/main.js', 'package.json'],
  asar: true,
  // There are no production npm dependencies (electron is a devDependency and is the runtime), so
  // there is nothing to rebuild and nothing to hoist.
  npmRebuild: false,
  nodeGypRebuild: false,

  extraResources: [
    // The staged collector, at <Resources>/collector — the path resources.ts resolves when packaged.
    { from: 'resources/collector', to: 'collector' },
    // sql.js separately, from inside its own directory. electron-builder applies a blanket
    // `!**/node_modules/**` exclusion to every extraResources copy, so the entry above silently
    // drops `collector/node_modules/sql.js` — the one real package the collector resolves at run
    // time for its WASM (see scripts/stage-resources.mjs). Copying from the package directory
    // itself leaves no `node_modules` segment for that pattern to match. afterPack checks the
    // result, because the first build without this line produced a perfectly launchable app whose
    // commit-outcomes cache would quietly recompute everything forever.
    { from: 'resources/collector/node_modules/sql.js', to: 'collector/node_modules/sql.js' },
    // What ships, legally: this project's license and the notices for everything bundled.
    // Electron's own two (its MIT license, and the 20 MB of Chromium/Node/third-party notices) are
    // placed beside the executable by electron-builder on Linux and Windows, and copied into the
    // bundle's Resources on macOS (below), where the builder does not place them — never both.
    { from: '../LICENSE', to: 'LICENSE' },
    { from: 'resources/THIRD_PARTY_NOTICES.md', to: 'THIRD_PARTY_NOTICES.md' },
  ],

  // The UI is English only, so Chromium's other 54 locale packs (~8 MB unpacked) are dropped.
  // en-US must stay: Chromium refuses to start without the locale it falls back to.
  electronLanguages: ['en-US'],
  // The smallest downloads the builder can make; it costs build time, not install time.
  compression: 'maximum',

  mac: {
    // Menu bar icons, read at run time by src/tray.ts via main.ts's trayAssetDir.
    extraResources: [
      { from: 'build/trayTemplate.png', to: 'tray/trayTemplate.png' },
      { from: 'build/trayTemplate@2x.png', to: 'tray/trayTemplate@2x.png' },
      // Electron's licenses — see the top-level extraResources.
      { from: 'node_modules/electron/dist/LICENSE', to: 'LICENSE.electron.txt' },
      { from: 'node_modules/electron/dist/LICENSES.chromium.html', to: 'LICENSES.chromium.html' },
    ],
    category: 'public.app-category.developer-tools',
    icon: 'build/icon.png',
    // Architectures come from the command line (`--arm64 --x64`, or none for the host's), so a
    // developer's quick local build and CI's two-architecture build share this one config. A DMG
    // per architecture rather than one universal app, which would double every download.
    target: ['dmg'],
    artifactName: 'TraceRoost-${version}-mac-${arch}.${ext}',
    darkModeSupport: true,
    minimumSystemVersion: '12.0',

    // Signing — see the header. `undefined` lets the builder find the Developer ID that CSC_LINK
    // imported or CSC_NAME names; '-' is explicit ad-hoc.
    identity: hasDeveloperId ? undefined : '-',
    hardenedRuntime: hasDeveloperId,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    // `spctl --assess` is a Gatekeeper check that only passes for a notarized build; running it
    // during the build would fail every unsigned one for a known reason. The real Gatekeeper
    // validation is a downloaded, quarantined artifact on a fresh user account (README.md).
    gatekeeperAssess: false,
    notarize: hasDeveloperId && hasNotaryCredentials,

    extendInfo: {
      // No document types, no URL schemes, no Apple Events: the app opens its own local dashboard
      // and nothing else.
      NSHumanReadableCopyright: 'Copyright © 2026 Roger Reed',
    },
  },

  dmg: {
    // The .app inside is what gets signed and (eventually) notarized and stapled; signing the disk
    // image as well buys nothing and is the usual source of "DMG signature invalid" noise.
    sign: false,
    contents: [
      { x: 140, y: 180, type: 'file' },
      { x: 400, y: 180, type: 'link', path: '/Applications' },
    ],
  },

  linux: {
    // Tray icon (the glyph on its tile — Linux panels recolour nothing) and the window / AppImage
    // launcher icon, read at run time from <resources>/tray via main.ts's trayAssetDir.
    extraResources: [
      { from: 'build/trayLinux.png', to: 'tray/trayLinux.png' },
      { from: 'build/trayLinux@2x.png', to: 'tray/trayLinux@2x.png' },
      { from: 'build/icons/512x512.png', to: 'tray/iconLinux.png' },
    ],
    // Architectures come from the command line, as for macOS. x64 first; arm64 is built too but
    // listed for download only once its own smoke test runs on an arm64 runner.
    target: ['deb', 'AppImage'],
    // The command on PATH (/usr/bin/traceroost-desktop) and the binary in /opt/TraceRoost. Not
    // `traceroost`: that is the npm/Homebrew CLI, which a user may well have installed alongside.
    executableName: 'traceroost-desktop',
    // The hicolor set, 16…512 (scripts/make-icons.mjs), installed under /usr/share/icons by the .deb.
    icon: 'build/icons',
    // Names the .desktop file after desktop/package.json's `desktopName` and sets StartupWMClass
    // to match, which is also the app_id Electron gives its windows on Wayland — so GNOME and KDE
    // group the running window with its launcher instead of showing a generic icon.
    syncDesktopName: true,
    category: 'Development',
    synopsis: 'Local observability for coding agents',
    // Also the launcher's Comment, so it is kept to one line.
    description: 'See what your coding agents did, what it cost, and what landed — recorded and shown on this machine.',
    maintainer: 'TraceRoost <support@traceroost.com>',
    vendor: 'TraceRoost',
    // `${arch}` expands to each format's own name: amd64/arm64 for the .deb, x86_64/arm64 for the
    // AppImage (the download chooser's names).
    artifactName: 'TraceRoost-${version}-linux-${arch}.${ext}',
    desktop: {
      entry: {
        Name: 'TraceRoost',
        GenericName: 'Coding agent observability',
        Keywords: 'claude;codex;copilot;agent;telemetry;otel;observability;',
      },
    },
  },

  deb: {
    // What Electron 44's binary links against, by Debian package name (checked with `ldd` on clean
    // Ubuntu 22.04/24.04 and Debian 12 — see README.md → "Linux"). The t64 transition renamed several
    // of these on Ubuntu 24.04 (libasound2t64, libgtk-3-0t64, …); the new packages Provide the old
    // names, so one list covers every supported release. No `nodejs`: the collector runs on
    // Electron's own Node.
    //
    // libasound2 is *versioned* on purpose. On Ubuntu 24.04 the name is provided both by
    // libasound2t64 (versioned) and by liboss4-salsa-asound2 (unversioned), and apt may pick the
    // latter — whose libasound.so.2 lacks symbols Electron needs, so the app dies at launch with
    // "undefined symbol: snd_device_name_get_hint". A version constraint only an unversioned Provides
    // cannot satisfy rules it out (the same constraint Chrome's and VS Code's packages use).
    depends: [
      'libgtk-3-0', 'libnotify4', 'libnss3', 'libxss1', 'libxtst6', 'xdg-utils', 'libatspi2.0-0',
      'libuuid1', 'libsecret-1-0', 'libgbm1', 'libasound2 (>= 1.0.17)', 'libdrm2', 'libxkbcommon0',
      'libxrandr2', 'libxcomposite1', 'libxdamage1',
    ],
    priority: 'optional',
    packageCategory: 'devel',
    // electron-builder recommends libappindicator3-1 by default, which Debian 12 and Ubuntu 24.04
    // no longer have. Electron's tray talks StatusNotifierItem over D-Bus itself and needs no such
    // library.
    recommends: [],
    // Post-install links /usr/bin/traceroost-desktop, installs /etc/apparmor.d/traceroost-desktop
    // (electron-builder's `unconfined` profile granting `userns` — Ubuntu 24.04's restriction is
    // what it exists for) where AppArmor supports it, and makes chrome-sandbox setuid only where
    // the sandbox cannot get user namespaces. It is electron-builder's default script with that
    // last test fixed: upstream runs it as root, which always passes, and the app then aborts at
    // launch on Ubuntu 24.04 without the profile or on Debian with unprivileged namespaces off —
    // see the script. Post-remove is the default and undoes exactly those. Neither touches a home
    // directory, ~/.traceroost or a systemd user unit; scripts/check-deb.sh checks that.
    afterInstall: 'build/linux/after-install.tpl',
  },

  appImage: {
    // No `--no-sandbox` in the desktop entry. (The legacy toolset's default puts it there.)
    executableArgs: [],
  },

  win: {
    // Notification-area icon (the multi-size tile .ico), read at run time by src/tray.ts from
    // <resources>/tray via main.ts's trayAssetDir. In development it is read from build/.
    extraResources: [
      { from: 'build/trayWindows.ico', to: 'tray/trayWindows.ico' },
    ],
    // Architectures come from the command line (`--x64` / `--arm64`), one per run: an NSIS build
    // given both would wrap them in one installer carrying both apps, and the downloads are one
    // file per architecture, as on macOS and Linux. See package.json's `pack:win`.
    target: ['nsis'],
    artifactName: 'TraceRoost-${version}-win-${arch}.${ext}',
    // traceroost-desktop.exe, not traceroost.exe: `traceroost` is the npm CLI, which may well be on
    // PATH beside it. (The installer adds nothing to PATH either way.)
    executableName: 'traceroost-desktop',
    // The app, installer and uninstaller icon: the tile, 16…256 (scripts/make-icons.mjs).
    icon: 'build/icon.ico',
    // A per-user app: it never asks for elevation itself.
    requestedExecutionLevel: 'asInvoker',
    legalTrademarks: 'TraceRoost',
    // Signing: see `windowsSigning` above. With a certificate, electron-builder reads
    // WIN_CSC_LINK / WIN_CSC_KEY_PASSWORD itself; Azure needs its profile spelled out here.
    ...(azureSigning ? {
      azureSignOptions: {
        publisherName: process.env.AZURE_TRUSTED_SIGNING_PUBLISHER,
        endpoint: process.env.AZURE_TRUSTED_SIGNING_ENDPOINT,
        codeSigningAccountName: process.env.AZURE_TRUSTED_SIGNING_ACCOUNT,
        certificateProfileName: process.env.AZURE_TRUSTED_SIGNING_PROFILE,
      },
    } : {}),
    // Unsigned: do not even try. (electron-builder would otherwise look for signtool on a
    // Windows host and sign nothing, which is the same result with more noise.)
    signExecutable: windowsSigning !== 'none',
  },

  nsis: {
    // One click: double-click the .exe and it installs for the current user — into
    // %LOCALAPPDATA%\Programs\traceroost-desktop, no administrator rights, no pages to step
    // through — and opens the app. A silent install (`/S`) does the same without the window.
    oneClick: true,
    perMachine: false,
    // Start Menu → TraceRoost. No desktop shortcut: the app lives in the notification area.
    createStartMenuShortcut: true,
    createDesktopShortcut: false,
    shortcutName: 'TraceRoost',
    uninstallDisplayName: 'TraceRoost',
    // Opens the app when the (interactive) installer finishes.
    runAfterFinish: true,
    // The uninstaller removes the app and its shortcuts. It never touches %USERPROFILE%\.traceroost
    // (spans, config, desktop.log) or Electron's own state in %APPDATA%\TraceRoost — the same
    // promise as the .deb's purge. README.md → Windows → Uninstalling.
    deleteAppDataOnUninstall: false,
    // build/installer.nsh — picked up from buildResources by that name — asks a running
    // TraceRoost to quit (and flush its collector) before the installer or uninstaller replaces or
    // removes its files.
    installerIcon: 'build/icon.ico',
    uninstallerIcon: 'build/icon.ico',
  },

  toolsets: {
    // The static type-2 runtime: no libfuse2 needed on the host (it was dropped from Ubuntu 22.04+
    // and Fedora's defaults), and electron-builder then leaves `--no-sandbox` out of the AppImage's
    // desktop entry. The AppImage's own launcher still adds `--no-sandbox` when user namespaces are
    // unavailable; the app refuses to run that way (src/sandbox.ts).
    appimage: '1.0.3',
  },

  // Never publish from the builder. Release artifacts go through the repo's own release workflow,
  // and only once they are signed and notarized; until then the CI job uploads them as build
  // artifacts for inspection.
  publish: null,

  afterPack,
}

