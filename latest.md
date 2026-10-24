# OpenTelemetry upstream watch — 2026-10-24

## Claude Code

Read by: `src/spanSummarizer.ts`, `src/claudeTurnJoin.ts`, `src/otlpIngest.ts`, `src/otelTraceKeys.ts`

### Monitoring docs (metrics, events, span attributes)

<https://code.claude.com/docs/en/monitoring-usage.md>

- Baseline recorded (1816 lines); changes are reported from the next run on.

### CHANGELOG.md (telemetry lines only)

<https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md>

- Baseline recorded (9483 lines); changes are reported from the next run on.

## Codex

Read by: `src/otlpParser.ts`, `src/spanSummarizer.ts`, `src/otelTraceKeys.ts`

### codex-rs/otel crate and the otel config

<https://github.com/openai/codex>

- Baseline recorded (latest commit d4e03ac on 2026-10-20); changes are reported from the next run on.

### codex-rs/otel/README.md (events, attributes, config keys)

<https://raw.githubusercontent.com/openai/codex/main/codex-rs/otel/README.md>

- Baseline recorded (266 lines); changes are reported from the next run on.

## GitHub Copilot (Chat)

Read by: `src/spanSummarizer.ts`, `src/otlpIngest.ts`

### OTel service, GenAI attributes and events, monitoring docs

<https://github.com/microsoft/vscode-copilot-chat>

- Baseline recorded (latest commit ae752d9 on 2026-03-31); changes are reported from the next run on.

## GitHub Copilot (CLI)

Read by: `src/logReader.ts`

### changelog.md (telemetry lines only) — the CLI itself is closed source

<https://raw.githubusercontent.com/github/copilot-cli/main/changelog.md>

- Baseline recorded (3569 lines); changes are reported from the next run on.

## OpenCode

_TraceRoost reads OpenCode's SQLite database, not its (experimental, undocumented) OTel export — this watches the export so we know when it is worth ingesting._

Read by: `src/logReader.ts`

### packages/util observability (OTLP export)

<https://github.com/anomalyco/opencode>

- Baseline recorded (latest commit 1aae67e on 2026-10-09); changes are reported from the next run on.

## Cursor

_Nothing public to watch: Cursor's OpenTelemetry export is enterprise-only and its CLI is closed source. Add a source here when one appears._

Read by: `src/logReader.ts`

No sources watched.

---

Snapshots and past reports: https://github.com/traceroost/core/tree/otel-watch

