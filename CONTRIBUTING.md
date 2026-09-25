# Contributing to TraceRoost

Thank you for your interest in contributing.

## Project scope and license zones

Most of this repo — the local agent, the dashboard, the log/OTEL ingestion, the free local
Outcomes/attribution engine — is MIT-licensed and stays that way. Features that make TraceRoost
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

- The agent you were using (Copilot, Claude Code, Codex)
- Whether you're using the VS Code extension or standalone mode
- The TraceRoost version (visible in the Traces tab footer)
- Relevant output from the **TraceRoost** output channel (*View → Output → TraceRoost*)

## Development setup

```bash
git clone https://github.com/traceroost/core
cd core
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
| `src/summarizers/` | Per-agent span → trace summarizers |
| `src/otlpCollector.ts` | OTLP/HTTP ingestion for the VS Code extension |
| `src/cloud/`, `media/src/cloud/`, `standalone/cloud/` | Org/cloud client — BSL-licensed, see [NOTICE.md](NOTICE.md) |

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

See [DEMO.md](DEMO.md) for generating synthetic demo traces, capturing real telemetry as a fixture, and the redaction step required before committing any fixture file.
