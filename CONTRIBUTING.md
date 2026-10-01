# Contributing to TraceRoost

Thank you for your interest in contributing.

## Project scope and license zones

Most of this repo — the local agent, the dashboard, the log/OTEL ingestion, the free local
attribution/turnover engine — is MIT-licensed and stays that way. Features that make TraceRoost
more useful for a single developer watching their own agent traces belong here, and PRs for them
are welcome.

`src/cloud/`, `src/test/cloud/`, `media/src/cloud/`, and `standalone/cloud/` are a different
license zone: Business Source License 1.1, not MIT. That's the client side of the org/cloud
feature — cross-machine trace aggregation, team roster/link, and the forwarding pipeline that
funds the project's continued development. See [NOTICE.md](NOTICE.md) for the exact scope and
[src/cloud/README.md](src/cloud/README.md) for why it's split out this way. It isn't a hedge
against contributions — PRs there are welcome too — but new work in that zone ships under BSL,
not MIT, so if you're unsure which license your change would land under, open an issue first.

## Reporting bugs

Open an issue at <https://github.com/traceroost/core/issues> and use the bug report template. Include:

- The agent you were using (Copilot, Claude Code, Codex, OpenCode, Cursor CLI)
- Whether you're using the VS Code extension or standalone mode
- The TraceRoost version (visible in the Traces tab footer)
- Relevant output from the **TraceRoost** output channel (*View → Output → TraceRoost*)

## Development setup

```bash
git clone https://github.com/traceroost/core
cd core
pnpm install
```

`pnpm install` also points git at the repo's hooks (`git config core.hooksPath .githooks`, via the
`prepare` script — skipped in CI and outside a git checkout). The `post-merge` / `post-rewrite`
hooks re-run `node esbuild.js` so `standalone/cli.js` and the other bundles stay in sync after a
pull or rebase. Run that `git config` line yourself if you installed with `--ignore-scripts`.

**Run in VS Code:** Press `F5` to open a VS Code Extension Development Host with TraceRoost loaded.

**Run standalone:** `pnpm run local` — starts the OTLP collector on port `4318` and the dashboard UI on port `3000`.

**Build:**

```bash
pnpm run check-types   # TypeScript type check
pnpm run lint          # ESLint
pnpm run test:unit     # Unit tests (Mocha)
node esbuild.js        # Bundle — outputs to dist/ and media/
```

### Editions

The same sources build two editions (README → Editions): **full** (the default — what `F5`,
`pnpm run local`, `pnpm run package` and the unit tests use) and **core**, which contains no
TraceRoost Cloud (org link + upload) code. The split is made at build time, not with a runtime flag:

- Non-cloud code reaches `src/cloud/`, `media/src/cloud/` and `standalone/cloud/` only through
  three seams — `src/cloudBridge.ts` (extension host + standalone server), `media/src/orgPanel.ts`
  (webview) and `standalone/cliCloud.ts` (CLI). Each has a full implementation inside a `cloud/`
  directory and an inert core stub beside it (`src/cloudBridge.core.ts`,
  `media/src/orgPanel.core.tsx`, `standalone/cliCloud.core.ts`). **Don't import from a `cloud/`
  directory anywhere else** — add what you need to a seam (both implementations) instead.
  `import type` is fine; it's erased. `pnpm run lint` flags a runtime import from a `cloud/`
  directory in `src/` or `media/src/` outside the seams.
- `node esbuild.js --edition=core` resolves each seam to its stub, defines
  `process.env.TRACEROOST_EDITION`, and fails the build if any module under a `cloud/` directory
  would still be bundled. Cloud-only code outside the seams (a VS Code command registration, a
  standalone route, Help-tab sections) is wrapped in a literal
  `process.env.TRACEROOST_EDITION !== 'core'` check so the core build drops it entirely.
- `node scripts/check-edition.mjs core` then greps the five shipped bundles for Cloud markers
  (cloud module paths, Cloud endpoints and hostnames, queue/link identifiers) and checks the
  packaged manifest; `check-edition.mjs full` checks the markers are still present in a full build.

```bash
pnpm run build:core                        # dev core build + bundle check
node esbuild.js --production --edition=core
node scripts/check-edition.mjs core --skip-manifest
node scripts/prepare-edition.mjs core      # package.json → the core manifest, for packing
node scripts/prepare-edition.mjs restore   # …and back
pnpm run test:unit                         # tests run against the sources — same for both editions
```

CI builds and checks both (`build-and-test` and `core-edition` in `.github/workflows/ci.yml`).
Releases are core until TraceRoost Cloud launches — see
[runbooks/RELEASING.md](runbooks/RELEASING.md#editions).

## Continuous integration

| Workflow | Runs on | What it covers |
| --- | --- | --- |
| `ci.yml` | every push/PR to `main`/`cloud`; Ubuntu + Windows | lint, types, unit tests, production build, edition checks, Playwright UX evaluations |
| `windows-e2e.yml` | every push/PR to `main`/`cloud`, nightly, manual, on release; Windows x64 + ARM64, macOS, Ubuntu | the extension inside a real VS Code, the npm package installed globally and run (including `traceroost service` on Task Scheduler / launchd / systemd), both VSIXes installed into a fresh VS Code, and `scripts/configure-*.ps1` under PowerShell 7 and 5.1. Its `real-agents` job (nightly/manual/release only) drives the real Claude Code and Codex CLIs and needs the `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` repository secrets — it skips with a notice without them |

The end-to-end suites live in `tests/e2e/` (plain Node scripts) and `src/test/integration/`
(`*.itest.ts`, run inside VS Code by `tests/e2e/vscode/run.mjs` — not part of `pnpm test` /
`test:unit`). Each runs locally too; see [runbooks/WINDOWS_VALIDATION.md](runbooks/WINDOWS_VALIDATION.md)
for what each job proves and the commands.

## Project structure

| Path | Purpose |
| --- | --- |
| `src/` | VS Code extension host code (Node.js, no DOM) |
| `media/src/` | Dashboard webview (Preact, browser) |
| `standalone/server.ts` | Standalone HTTP server |
| `src/summarizers/` | Per-agent span → trace summarizers |
| `src/otlpCollector.ts` | OTLP/HTTP ingestion for the VS Code extension |
| `src/attribution/`, `src/turnover/` | Free, local commit-attribution and turnover engines (MIT) |
| `src/repoKey.ts` | Repository-key derivation — the repo hash shown in the Traces table's Repo (ID) column, and the HMAC primitives the cloud client builds on (MIT) |
| `standalone/local/` | Free, local CLI analysis — `find`, `trace`, `patterns`, `cohort`, `advise` (MIT) |
| `src/cloud/`, `media/src/cloud/`, `standalone/cloud/` | Org/cloud client (link + upload) — BSL-licensed, see [NOTICE.md](NOTICE.md). Local code never imports from these directories |

## Branching and commit conventions

**Branch naming:** `feat/<slug>` for new features, `fix/<slug>` for bug fixes. Branch from `main`; delete after merge.

**Commit format:** [Conventional Commits](https://www.conventionalcommits.org/) — `type(scope): imperative subject`. Common types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`. Keep each commit a single logical unit.

**Merging:** PRs are squash-merged into `main` so the history stays one-line-per-change readable.

**Releases:** bump `version` in `package.json` and add a `CHANGELOG.md` entry in the same PR. After merge, tag `main` with `vX.Y.Z` — the release and Docker workflows refuse a tag that doesn't match `package.json`'s version.

## Submitting a pull request

1. Fork the repo and create a branch (`feat/<slug>` or `fix/<slug>`)
2. Make your changes and verify `pnpm run check-types && pnpm run lint` pass
3. Bump the version and update `CHANGELOG.md` if your change is user-facing
4. Open a PR with a clear description of what changed and why; the PR title should follow Conventional Commits format

Please keep PRs focused on a single change. Large refactors should be discussed in an issue first.

**Contributor License Agreement:** a bot will ask you to sign the
[CLA](.github/CLA.md) on your first pull request — a one-time comment, no account or
external service needed. PRs can't be merged until it's signed.

## Demo data and fixtures

See [DEMO.md](DEMO.md) for generating synthetic demo traces, capturing real telemetry as a fixture, and the redaction step required before committing any fixture file.
