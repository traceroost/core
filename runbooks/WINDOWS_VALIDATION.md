# Windows manual validation

**Trigger:** before cutting a release, or after touching anything in the risk areas below —
`.github/workflows/ci.yml`'s `windows-latest` leg catches build/lint/test breakage, but nothing
in CI actually opens VS Code, so it can't catch a real runtime bug in how the extension behaves
once it's running there.

**Setup:** a Windows VM on the release machine works fine for this — UTM (free, native ARM64
Windows 11 on Apple Silicon) or Parallels/VMware Fusion (x64) if you specifically need x64
fidelity. Install VS Code, [Git for Windows](https://git-scm.com/download/win), a current Node
LTS, and `pnpm`, then `git clone`, `pnpm install`, and `F5` to launch the Extension Development
Host — same as any other dev loop, just on Windows.

This isn't a blind "click around" pass. Each item below traces back to a specific place in the
code that does something OS-sensitive and has never actually run on Windows before:

## 1. First run / local storage

- Confirm `%USERPROFILE%\.traceroost\traceroost.db` gets created (not a literal `~/.traceroost` —
  `os.homedir()` should resolve the real Windows profile dir; see `database/db.ts` and
  `serviceConfig.ts:defaultDataDir`).
- Confirm the sql.js WASM binary loads with no error in the Output channel (`dist/sql-wasm.wasm`,
  copied at build time — `database/db.ts`'s `openDatabase` locates it via `extensionPath`, not a
  hardcoded path).
- Open a session's timeline detail view and confirm blob content (tool output, thinking) actually
  loads. `sessionRepository.ts`'s `getStorageStats()` builds a blob path as
  `` `${blobsDir}/${f}` `` — a hardcoded forward slash instead of `path.join` — which happens to
  work on Windows (its fs APIs tolerate `/`), but it's the one spot in this codebase that isn't
  doing path joining the safe way, so it's worth confirming directly rather than assuming.

## 2. Session ingestion

- Open a real workspace, run whichever of Claude Code / Copilot / Codex / Cursor you have
  installed, and confirm sessions populate in the dashboard live.
- Confirm log-file discovery finds each agent's logs at its Windows location (e.g. Claude Code at
  `%USERPROFILE%\.claude\projects\`, not `~/.claude/projects/`) — `LogReader` resolves these via
  `os.homedir()` too, same class of risk as item 1.

## 3. Git integration

- In a real local git repo with actual commits, confirm the outcome badges (merged / committed /
  uncommitted) resolve on the Sessions tab, and that the new Analytics "Outcome vs. tokens" chart
  populates. Both go through `execFile('git', args, { cwd, timeout })` in `gitOutcome.ts`,
  `repoRemote.ts`, and `cloud/forward/repoKey.ts` — `execFile` (not `exec`) means no shell is
  involved, so this should resolve `git`/`git.exe` via PATH cleanly, but confirm it doesn't hang:
  process startup is generally slower on Windows, and `GIT_TIMEOUT_MS` was only ever tuned against
  Unix behavior.

## 4. Org / Cloud linking

- Link this machine to an org (`cloud/org` module) and confirm the OAuth browser flow actually
  opens the system browser (`vscode.env.openExternal`).
- Confirm the forwarding queue drains and the Org panel's transport stats ("hashed traces sent —
  last 5 min / last hour / all time") update — this reads `~/.traceroost/traceroost.db` via the
  same `os.homedir()` path as item 1, so a failure here usually means that failed first.

## 5. Webview / UI

- Cycle every dashboard tab (Sessions, Analytics, Advisor, Export, Org panel) and confirm no
  layout breakage.
- Confirm every copy-to-clipboard button actually copies — Windows clipboard access through a
  VS Code webview has historically had more permission quirks than macOS.
- Toggle VS Code's light/dark theme and resize the window; confirm the CSS custom properties still
  track correctly (nothing here is Windows-specific in theory, but it's cheap to check while
  you're in there).

## 6. Export

- Export sessions to JSON, CSV, and Markdown. Confirm the write succeeds and the generated
  filename is valid on Windows — `exportFormats.ts` builds it from digits and underscores only
  (no `:` from a raw timestamp), which should already be safe, but confirm the actual file lands
  where expected rather than trusting the naming logic in the abstract.

## 7. Packaging

- Build the `.vsix` (`pnpm run package`, then `vsce package` if you don't already have one from a
  release), install it via VS Code's "Install from VSIX…" on a *clean* Windows profile (not the
  dev-loop `F5` host), and confirm activation succeeds with no missing-module errors — this is the
  real test of whether every asset the build copies (sql.js WASM in particular) actually made it
  into the packaged extension.

## Verifying

There's nothing to run afterward beyond noting the result — this is exploratory, not a
build/test/lint gate. If something breaks, fix it, add a regression test if the bug is in code
`windows-latest` CI can actually exercise (most of these are), and re-run just the affected
section rather than the whole checklist.
