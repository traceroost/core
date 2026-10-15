# TraceRoost desktop shell

An Electron shell that runs the existing standalone collector and dashboard as a normal desktop app
with a menu bar icon (macOS) or a system tray icon (Windows) — no terminal, no separately installed
Node.

**Status: macOS Stages 1–2 of [`.staged-features/macos-desktop-menu-bar-app.md`](../.staged-features/macos-desktop-menu-bar-app.md);
Windows Stage 1 of [`windows-desktop-tray-app.md`](../.staged-features/windows-desktop-tray-app.md) in progress.**
The app runs from a checkout and its lifecycle is complete and tested. It is **not** signed,
notarized, packaged as a DMG or installer, or self-updating — that is Stages 3–4 of each plan, and
[what is not done](#what-is-not-done-yet) says exactly where the line falls.

Nothing here changes the npm, VSIX, Docker or Homebrew builds. It consumes their output.

## Running it

```sh
cd desktop
npm install          # Electron only; deliberately not in the repo's pnpm workspace
pnpm run build       # type-check, bundle the main process, stage the collector
pnpm start           # or: ./node_modules/.bin/electron .   (electron.cmd . on Windows)
```

Same commands on macOS and Windows. If `node_modules/electron/dist/` is missing afterwards (npm
skipped the postinstall download), run `node node_modules/electron/install.js`, then
`pnpm run runtime-check` prints the bundled Node version and fails if it is below the collector's
`engines.node`.

`pnpm run build` does three things: type-checks `src/` against the Electron types, bundles the main
process to `out/main.js` with esbuild, and runs [`scripts/stage-resources.mjs`](scripts/stage-resources.mjs),
which builds the **core edition** at the repo root and copies what the app ships into
`resources/collector/`.

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
rather than letting the collector bundle die on unsupported syntax:

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
in `scripts/check-edition.mjs`, and build/test wiring). It is optional, so a collector from an
older release simply reports no version — which is why **confirm-attach** exists instead of a
refusal.

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
collector's stdout and stays on the machine.

The shell registers **no launchd job**. "Launch at Login" registers *this app* through the OS login
item API; the `traceroost service install` job is a separately managed thing the app attaches to,
never duplicates or rewrites.

## Tests

Desktop tests run with the rest of the repo's suite — `pnpm run test:unit` at the root — and are
compiled by [`tsconfig.test.desktop.json`](../tsconfig.test.desktop.json). `pnpm run test:desktop`
runs just them. In CI the `desktop` job of `.github/workflows/windows-e2e.yml` builds the shell and
runs them on Windows x64, Windows ARM64, macOS and Linux with `TRACEROOST_DESKTOP_REQUIRE_STAGED=1`,
which turns the integration suite's skip (below) into a failure — there, a skip would hide exactly
what the job exists to catch.

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

These tests redirect `HOME` — and, because `os.homedir()` reads it on Windows, `USERPROFILE`, plus
`APPDATA` and `LOCALAPPDATA` — to a temporary directory. The collector **auto-configures the agents
it finds at startup**, writing OTEL endpoints into `~/.claude/settings.json`, `~/.codex/config.toml`
and VS Code's settings. Running one against the real profile points a developer's live agents at a
test port that is about to disappear. `stagedCollector.test.ts` asserts the redirection holds; keep
it that way in anything added here.

## What is not done yet

Stages 3–4 of the plan, which need credentials and hardware rather than code:

- **Signing, notarization, DMG** — an Apple Developer Program membership (**US$99/year**),
  Developer ID certificates, hardened runtime and entitlements, stapling, and CI secrets. Also the
  validation that matters: a *downloaded, quarantined* artifact opening on a fresh user account.
  Nothing here has been through Gatekeeper.
- **Automatic updates** — signed artifacts from a trusted manifest origin, coordinated collector
  shutdown, recoverable interrupted installs, and a guard against opening migrated data with an
  older collector (a binary rollback is not a database rollback). Desktop update notices must stay
  separate from the existing npm version check and honour the no-update-check preference.
- **Universal/arch artifacts and packaged smoke tests** — arm64 and x64 (or a verified universal
  build) and the Stage 4 matrix: offline launch, port collisions, stale locks, crashes, login,
  sleep, update failure, Homebrew-service attachment.

Smaller, genuinely open items:

- **Windows: what is and is not proven.** The stop request is closing the collector's stdin
  (`TRACEROOST_SHUTDOWN_ON_STDIN_END=1`, see `collector.ts`), not a signal, so owned mode works
  where `child.kill()` is `TerminateProcess`; the tray swaps between white and black ICOs with the
  taskbar's appearance (`trayIcon.ts`); Launch at Login uses a marker argument because Windows has
  no `wasOpenedAtLogin`. **Proven in CI on Windows 11 x64 and ARM64** (`windows-latest`,
  `windows-11-arm`): Electron 44.7.1 installs, the shell builds, the core-edition collector stages
  and runs on Electron's Node 24, binds its ports, serves the dashboard, resolves `sql.js` with its
  WASM, and stops cleanly over stdin, releasing the lock. That is the supported-matrix record for
  Stage 1; both architectures are in scope. Nothing has been *packaged* for Windows yet.
  Not yet done from the Windows plan's Stage 1: attaching to and handing off from a Scheduled Task
  collector has only the generic lock-and-probe handshake behind it (no explicit handoff flow);
  non-ASCII profile paths, log rotation under Windows file locking, and Explorer-restart/sleep
  behaviour have not been exercised; no human has seen the tray in a Windows session.
- **Unverified on this machine, needing a GUI session:** clicking the window's close button
  (close-to-menu-bar), Dock reopen, the Launch at Login toggle actually registering a login item,
  sleep/wake, and how the template icon looks in a light vs dark menu bar. The code paths exist and
  the equivalent programmatic paths were exercised; the human-interaction ones were not.
- `desktop/src` is **not** linted. The repo's ESLint config covers `src` and `media/src` only
  (`standalone/` is likewise outside it), so widening it is its own change.
