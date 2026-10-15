# TraceRoost desktop shell (macOS)

An Electron shell that runs the existing standalone collector and dashboard as a normal macOS app
with a menu bar icon — no terminal, no separately installed Node.

**Status: Stages 1–2 of [`.staged-features/macos-desktop-menu-bar-app.md`](../.staged-features/macos-desktop-menu-bar-app.md)
are done, and Stage 3 is done up to the point that needs an Apple Developer Program membership.**
The app builds as a `.app`, a DMG and a zip for arm64 and x64, verifies and smoke-tests itself,
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
pnpm run pack        # arm64 + x64: dist/TraceRoost-<version>-mac-{arm64,x64}.{dmg,zip} + SHA256SUMS
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
| `LICENSE.electron.txt`, `LICENSES.chromium.html` | Electron's own, and the Chromium/Node notices it carries |

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
to the app flushes the collector, releases the lock and exits 0 with no orphan left behind.

### Installing

Open the DMG and drag TraceRoost to Applications, or unzip the zip. Then:

- **An unsigned build** (every build until the Apple credentials exist): the first open is refused
  with "cannot be opened because the developer cannot be verified" or "is damaged". That is
  Gatekeeper reacting to the quarantine flag on a downloaded, un-notarized app. Right-click the app
  → **Open**, then **Open** again in the dialog; macOS remembers the choice. Or clear the flag:
  `xattr -d com.apple.quarantine /Applications/TraceRoost.app`. A build you made locally has no
  quarantine flag and opens normally.
- **A signed and notarized build** opens like any other app.

Check a download against the published `SHA256SUMS` with `shasum -a 256 -c SHA256SUMS` in the
directory holding the files.

On first launch the app decides who owns the data directory (below), starts a collector if nothing
else does, and opens the dashboard. It uses the same `~/.traceroost` data directory and
`~/.traceroost/config.json` (ports, data dir, bind host, token) as `npx traceroost` and the
Homebrew service, so existing data appears as is. It creates `~/.traceroost/desktop.log`
(owner-only, rotated at 5 MB with one generation kept) and, like every collector, configures the
coding agents it finds on the machine to send telemetry to it.

Requires macOS 12 or later. Git is optional: without it, sessions are still recorded but commit
outcomes are unavailable, and the menu bar says so.

### Signing and notarization

[`electron-builder.cjs`](electron-builder.cjs) reads the environment and nothing else branches on
it, so the switch from the current unsigned CI artifact to a shippable one is a secrets change:

| Environment | Effect |
| --- | --- |
| nothing | **ad-hoc signed**, hardened runtime off, no notarization. Launches locally; refused by Gatekeeper when downloaded |
| `CSC_LINK` (base64 `.p12` of a *Developer ID Application* certificate) + `CSC_KEY_PASSWORD`, or `CSC_NAME` naming one already in the login keychain | signed with that identity under the hardened runtime, with [`build/entitlements.mac.plist`](build/entitlements.mac.plist) |
| …plus `APPLE_API_KEY` (path to an App Store Connect API `.p8`), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` — or `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | …and notarized and stapled |

Ad-hoc is explicit rather than electron-builder's default (which is to skip signing entirely when
no identity is found): Apple Silicon refuses to launch an unsigned binary whose bundle differs from
the one Electron shipped, so an unsigned build would pass every check and then die on launch. The
hardened runtime is off on the ad-hoc path because it enforces library validation, which rejects
the pre-signed Electron frameworks under an ad-hoc identity; it is only meaningful with a real one.

The CI job ([`.github/workflows/desktop-macos.yml`](../.github/workflows/desktop-macos.yml))
maps repository secrets `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_API_KEY_P8`,
`APPLE_API_KEY_ID` and `APPLE_API_ISSUER` onto those variables. Until they exist the job builds
ad-hoc, exactly as a developer's machine does. The membership itself is **US$99/year**
([Apple](https://developer.apple.com/programs/whats-included/)).

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
- **Packaged** (`pnpm run smoke`, above): the built `.app`, launched and quit.

These tests redirect `HOME` to a temporary directory. The collector **auto-configures the agents it
finds at startup**, writing OTEL endpoints into `~/.claude/settings.json`, `~/.codex/config.toml`
and VS Code's settings. Running one against the real `HOME` points a developer's live agents at a
test port that is about to disappear. `stagedCollector.test.ts` and the smoke test both assert the
redirection holds; keep it that way in anything added here.

**CI**: [`desktop-macos.yml`](../.github/workflows/desktop-macos.yml) runs on every pull request
that touches the desktop, collector, dashboard or build inputs (and on `main` for `desktop/`
changes). On an Apple Silicon runner it builds and packs both architectures (afterPack verifying
each), smoke-tests the arm64 app, runs the staged-collector integration suite, prints the
signature state, and uploads the DMGs, zips, `SHA256SUMS` and `THIRD_PARTY_NOTICES.md` as a build
artifact for 14 days. It publishes nothing: that waits for signing.

## What is not done yet

Needs the Apple Developer Program membership and the secrets above:

- **Developer ID signing, notarization and stapling** — the code path exists and is exercised by
  the config, but nothing has been through it, and nothing here has been through Gatekeeper. The
  validation that matters is a *downloaded, quarantined* artifact opening on a fresh user account.
- **A release job** that promotes the CI artifacts to a GitHub release once they are signed.
  Deliberately not wired into `release.yml` until then: publishing an unsigned DMG would hand
  users the right-click-to-open workaround as the installation experience.

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

- **Owned mode is refused on Windows.** `child.kill()` there is `TerminateProcess`: no handler
  runs, so an owned collector would lose whatever it had not flushed. The shell says so and points
  at the Windows feature, whose plan covers adding a cooperative shutdown channel. Attached mode is
  unaffected.
- **Unverified in a GUI session:** clicking the window's close button (close-to-menu-bar), Dock
  reopen, the Launch at Login toggle actually registering a login item, sleep/wake, and how the
  template icon looks in a light vs dark menu bar. The code paths exist and the equivalent
  programmatic paths were exercised; the human-interaction ones were not.
