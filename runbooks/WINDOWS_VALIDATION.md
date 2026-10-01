# Windows validation

**Most of this is automated now.** `.github/workflows/windows-e2e.yml` runs the product for real on
`windows-latest` (x64) and `windows-11-arm` (ARM64), with `macos-latest` and `ubuntu-latest`
alongside for comparison — on every push/PR to `main`/`cloud`, nightly, on manual dispatch, and
when a release is published. `ci.yml`'s `windows-latest` leg still covers lint, types, unit tests,
the production build and the Playwright UX evaluations (against a stub server).

**Trigger for the manual pass below:** before cutting a release, or after touching anything in the
"still manual" list. Before that, check the latest `Windows E2E` run is green — if it is, only the
manual items are left.

## What CI proves on Windows

| Job | What it does | What it proves (runbook items) |
| --- | --- | --- |
| `extension-host` | Launches VS Code 1.118.0 (the `engines.vscode` floor) with the dev-built extension, an isolated `--user-data-dir` / `--extensions-dir` and a temp `USERPROFILE`/`HOME`/`APPDATA`/`LOCALAPPDATA`; runs `src/test/integration/extension.itest.ts` (`tests/e2e/vscode/run.mjs`) | Activation with no failure lines in the TraceRoost Output channel (read from VS Code's on-disk log); every contributed command registered; the sql.js WASM loads and `traceroost.db` is written to the extension's **globalStorage** (`%APPDATA%\Code\User\globalStorage\<ext id>\traceroost.db` for a real install — the extension never used `%USERPROFILE%\.traceroost`, that's the standalone server's data dir); auto-config writes `%USERPROFILE%\.claude\settings.json` and `%USERPROFILE%\.codex\config.toml`; a fixture Claude Code OTLP trace **and** the same conversation's transcript under `%USERPROFILE%\.claude\projects\…` end up as **one** session with workspace = the fixture git repo, model, tokens and cost (via the MCP server); background reconciliation runs `git` and records a committed/merged outcome; the dashboard webview panel opens; Show Storage Stats and Export write real files with portable names (items 1, 2, 3, 5 partly, 6) |
| `artifact-smoke` | `tests/e2e/artifact-smoke.mjs`: builds and `npm pack`s both editions (via `scripts/prepare-edition.mjs`), `npm install -g`s each tarball into a temp prefix, runs `traceroost --help`, starts the server on free ports, ingests the same fixture pair, checks workspace/tokens/cost/`/api/git-outcome`; then `traceroost service install` → `status` → ingest through the service → re-install on a new port → `uninstall` on **Task Scheduler** (launchd on macOS, `systemd --user` on Linux). Then packages both VSIXes the way `release.yml` does (`tests/e2e/package-vsix.mjs`), installs each into a fresh VS Code with `code --install-extension`, and runs the same extension-host suite against the installed copy | The `.cmd` npm shim, the published file list (sql.js WASM included), `%USERPROFILE%\.traceroost` for the standalone server, the scheduled-task wrapper script, and a clean-profile VSIX install with no missing-module errors (item 7) |
| `configure-scripts` | `tests/e2e/configure-scripts.mjs`: every `scripts/configure-*.ps1` under `pwsh`, and under Windows PowerShell 5.1 (`powershell.exe` — what a Windows user runs by default) on Windows | Exact files/values written, with and without `-Port`/`-Token`/`-HostName` (and the `TRACEROOST_*` env defaults); unrelated settings and TOML comments survive; a second run changes nothing; bad input is refused without writing; TraceRoost's own auto-config reads the result and finds nothing to change; `configure-copilot.ps1`'s user environment variables (Windows only — restored afterwards) |
| `real-agents` | Nightly / manual / release only. Installs `@anthropic-ai/claude-code` and `@openai/codex` from npm, starts the extension (whose auto-config points both at it), runs `claude -p …` and `codex exec …` with a tiny deterministic prompt in a temp git repo (`src/test/integration/realAgents.itest.ts`) | Real OTEL + the real on-disk transcript for each agent, deduped into one session, with workspace = the repo, tokens > 0, cost > 0, model set, and a git outcome. Uploads the raw transcripts, exported OTEL spans and database; `node tests/e2e/captures-to-fixtures.mjs <artifact dir>` turns them into redacted fixtures |

**Secrets** (Settings → Secrets and variables → Actions): `ANTHROPIC_API_KEY` (Claude Code) and
`OPENAI_API_KEY` (Codex) — only the `real-agents` job reads them, and it skips an agent (with a
run-summary notice) when its key is missing. Nothing else needs a secret.

**Windows on ARM:** `windows-11-arm` runs `extension-host`, `artifact-smoke` and
`configure-scripts` with the same steps as x64 (Node 24, pnpm, sql.js's WASM and VS Code's
`win32-arm64` build all work there). `real-agents` runs on x64 Windows and macOS only.

**Reproducing locally** (any OS): `node esbuild.js && pnpm run compile-tests`, then
`node tests/e2e/vscode/run.mjs` (Linux: under `xvfb-run -a`), `node tests/e2e/artifact-smoke.mjs`
(add `--service` only on a throwaway machine — it registers a real service for your user),
`node tests/e2e/configure-scripts.mjs`. On a Mac with no Windows machine, the workflow's
`workflow_dispatch` button is the way to get a Windows run on demand.

## Still manual

These need a person — an interactive sign-in, a human eye, or hardware CI doesn't have. Use a
Windows VM (UTM on Apple Silicon runs ARM64 Windows 11 for free; Parallels/VMware Fusion for x64),
install VS Code, [Git for Windows](https://git-scm.com/download/win), Node 24 and `pnpm`, then
install the VSIX artifact from the latest `Windows E2E` or `Release` run.

1. **GitHub Copilot in VS Code.** Copilot Chat needs an interactive GitHub sign-in, so no CI job
   drives it. Run one Copilot Chat agent turn and confirm the session appears (TraceRoost
   auto-configures `github.copilot.chat.otel.*` — check it did). Same for Cursor/OpenCode if you
   have them.
2. **Session timeline blobs.** Open a session's timeline detail view and confirm blob content
   (tool output, thinking) loads — `sessionRepository.ts`'s `getStorageStats()` joins blob paths
   with a literal `/`, which CI exercises for the stats but not for rendering blob content.
3. **Org / Cloud linking (full edition).** Link to an org (`traceRoost.orgLink`) and confirm the
   browser sign-in opens the system browser (`vscode.env.openExternal`), the forwarding queue
   drains, and the Org panel's transport stats update.
4. **Webview look and feel.** Cycle every dashboard tab (Traces, Analytics, Advisor, Export,
   Import) plus the Help and Pricing pages and the Settings and Org panels, toggle light/dark theme, resize, and try each copy-to-clipboard button (Windows clipboard
   permissions through a webview have been quirkier than macOS). CI only proves the panel opens
   without errors.
5. **A real logon.** CI starts the Task Scheduler task with `schtasks /run`; confirm once that it
   also starts on its own at the next Windows sign-in.
6. **Git outcomes in a real repo.** In a local git repo with actual commits, confirm the outcome
   badges (merged / committed / uncommitted) resolve on the Traces tab, and that the Analytics
   "Outcome & token spend over time" chart populates. Both go through `execFile('git', args, { cwd, timeout })`
   in `gitOutcome.ts`, `repoRemote.ts`, and `repoKey.ts` — `execFile` (not `exec`) means no shell
   is involved, so this should resolve `git`/`git.exe` via PATH cleanly, but confirm it doesn't
   hang: process startup is generally slower on Windows, and `GIT_TIMEOUT_MS` was only ever tuned
   against Unix behavior.

If something breaks, fix it, add a regression test at the lowest level that can see it (unit test,
or a step in one of the `tests/e2e/` suites), and re-run just the affected item.
