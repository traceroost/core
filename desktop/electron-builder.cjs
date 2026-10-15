/**
 * electron-builder configuration for the macOS app.
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
 * Versioning: the app's version is the collector's version, read from the repo root's
 * package.json, so a DMG named 0.19.1 contains the 0.19.1 collector. desktop/package.json's own
 * version is not consulted (`extraMetadata` overrides it); scripts/afterPack.cjs asserts that the
 * staged collector agrees.
 */

const path = require('path')
const rootManifest = require('../package.json')
const afterPack = require('./scripts/afterPack.cjs')

const hasDeveloperId = Boolean(process.env.CSC_LINK || process.env.CSC_NAME)
const hasNotaryCredentials =
  Boolean(process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER) ||
  Boolean(process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID)

if (!hasDeveloperId) {
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
    // Menu bar icons, read at run time by src/tray.ts via main.ts's trayAssetDir.
    { from: 'build/trayTemplate.png', to: 'tray/trayTemplate.png' },
    { from: 'build/trayTemplate@2x.png', to: 'tray/trayTemplate@2x.png' },
    // What ships, legally: this project's license, the notices for everything bundled, and
    // Electron's own two (its MIT license, and the Chromium/Node/third-party notices it carries).
    // electron-builder does not place the latter two in a macOS bundle by itself.
    { from: '../LICENSE', to: 'LICENSE' },
    { from: 'resources/THIRD_PARTY_NOTICES.md', to: 'THIRD_PARTY_NOTICES.md' },
    { from: 'node_modules/electron/dist/LICENSE', to: 'LICENSE.electron.txt' },
    { from: 'node_modules/electron/dist/LICENSES.chromium.html', to: 'LICENSES.chromium.html' },
  ],

  mac: {
    category: 'public.app-category.developer-tools',
    icon: 'build/icon.png',
    // Architectures come from the command line (`--arm64 --x64`, or none for the host's), so a
    // developer's quick local build and CI's two-architecture build share this one config.
    target: ['dmg', 'zip'],
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

  // Never publish from the builder. Release artifacts go through the repo's own release workflow,
  // and only once they are signed and notarized; until then the CI job uploads them as build
  // artifacts for inspection.
  publish: null,

  afterPack,
}
