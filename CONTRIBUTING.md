# Contributing to TraceRoost

Thank you for your interest in contributing.

## Project scope

TraceRoost the local agent — everything in this repo — is MIT-licensed and stays that way. Features
that make it more useful for a single developer watching their own sessions belong here, and PRs
for them are welcome.

A few features are out of scope for this repo, reserved for a separate, source-available team
server built on top of the local agent: cross-machine session aggregation, SSO/SCIM, RBAC,
multi-team rollup views, extended retention and audit export, and license-key issuance. That's the
boundary that funds the project's continued development — not a hedge against contributions, and
not a signal that those features are unwanted in general. If you'd like to work on something in
that list, open an issue first so we can talk about where it should live before you spend time on
the PR.

## Reporting bugs

Open an issue at <https://github.com/traceroost/core/issues> and use the bug report template. Include:

- The agent you were using (Copilot, Claude Code, Codex)
- Whether you're using the VS Code extension or standalone mode
- The TraceRoost version (visible in the sidebar footer)
- Relevant output from the **TraceRoost** output channel (*View → Output → TraceRoost*)

## Development setup

```bash
git clone https://github.com/traceroost/core
cd traceroost
pnpm install
```

**Run in VS Code:** Press `F5` to open a VS Code Extension Development Host with TraceRoost loaded.

**Run standalone:** `pnpm run local` — starts the OTLP collector on port `4318` and the dashboard UI on port `3000`.

**Build:**

```bash
pnpm run check-types   # TypeScript type check
pnpm run lint          # ESLint
pnpm run test:unit     # Unit tests (Mocha)
node esbuild.js        # Bundle — outputs to dist/ and media/
```

## Project structure

| Path | Purpose |
| --- | --- |
| `src/` | VS Code extension host code (Node.js, no DOM) |
| `media/src/` | Dashboard webview (Preact, browser) |
| `standalone/server.ts` | Standalone HTTP server |
| `src/summarizers/` | Per-agent span → session summarizers |
| `src/otlpCollector.ts` | OTLP/HTTP ingestion for the VS Code extension |

## Branching and commit conventions

**Branch naming:** `feat/<slug>` for new features, `fix/<slug>` for bug fixes. Branch from `main`; delete after merge.

**Commit format:** [Conventional Commits](https://www.conventionalcommits.org/) — `type(scope): imperative subject`. Common types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`. Keep each commit a single logical unit.

**Merging:** PRs are squash-merged into `main` so the history stays one-line-per-change readable.

**Releases:** bump `version` in `package.json` and add a `CHANGELOG.md` entry in the same PR. After merge, tag `main` with `vX.Y.Z`.

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

See [DEMO.md](DEMO.md) for generating synthetic demo sessions, capturing real telemetry as a fixture, and the redaction step required before committing any fixture file.
