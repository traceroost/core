# OpenTelemetry upstream watch — 2026-10-26

## Claude Code

Read by: `src/spanSummarizer.ts`, `src/claudeTurnJoin.ts`, `src/otlpIngest.ts`, `src/otelTraceKeys.ts`

### Monitoring docs (metrics, events, span attributes)

<https://code.claude.com/docs/en/monitoring-usage.md>

- Changed: 4 line(s)

```diff
- * **You exported it in a login file**: only login shells read a file such as `/etc/profile`. A value you `export` there reaches Claude Code that you start from a login shell. It doesn't reach a Desktop SSH session, because Desktop doesn't start Claude Code through a login shell.
- * `precompute_reuse`: Only set when `trigger` is `"manual"` or for an [idle compaction](https://code.claude.com/docs/en/settings-reference.md#idlecompaction), which reports `trigger` as `"auto"`. Auto-compaction can prepare a summary in the background before the context window fills, and this attribute records whether the compaction reused that prepared summary. `"hit"` means it was reused; `"miss_custom_instructions"`, `"miss_hook"`, and `"miss_not_ready"` give the reason a fresh summary was computed instead
+ * **You exported it in `/etc/profile` or another file that only login shells read**: the name arrives when you run `claude` from a login shell, but not in a Desktop SSH session. Desktop doesn't start Claude Code through a login shell. Set the variable under `env` in the [managed settings file](https://code.claude.com/docs/en/desktop.md#managed-settings) on the remote machine instead.
+ * `precompute_reuse`: Only set when `trigger` is `"manual"`, or when `trigger` is `"auto"` for an [idle compaction](https://code.claude.com/docs/en/settings-reference.md#idlecompaction) in an interactive terminal session. Auto-compaction can prepare a summary in the background before the context window fills, and this attribute records whether the compaction reused that prepared summary. `"hit"` means it was reused; `"miss_custom_instructions"`, `"miss_hook"`, and `"miss_not_ready"` give the reason a fresh summary was computed instead
```

### CHANGELOG.md (telemetry lines only)

<https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md>

- No change.

## Codex

Read by: `src/otlpParser.ts`, `src/spanSummarizer.ts`, `src/otelTraceKeys.ts`

### codex-rs/otel crate and the otel config

<https://github.com/openai/codex>

- No commits.

### codex-rs/otel/README.md (events, attributes, config keys)

<https://raw.githubusercontent.com/openai/codex/main/codex-rs/otel/README.md>

- No change.

## GitHub Copilot (Chat)

Read by: `src/spanSummarizer.ts`, `src/otlpIngest.ts`

### OTel service, GenAI attributes and events, monitoring docs

<https://github.com/microsoft/vscode-copilot-chat>

- No commits.

## GitHub Copilot (CLI)

Read by: `src/logReader.ts`

### changelog.md (telemetry lines only) — the CLI itself is closed source

<https://raw.githubusercontent.com/github/copilot-cli/main/changelog.md>

- No change.

## OpenCode

_TraceRoost reads OpenCode's SQLite database, not its (experimental, undocumented) OTel export — this watches the export so we know when it is worth ingesting._

Read by: `src/logReader.ts`

### packages/util observability (OTLP export)

<https://github.com/anomalyco/opencode>

- No commits.

## Cursor

_Nothing public to watch: Cursor's OpenTelemetry export is enterprise-only and its CLI is closed source. Add a source here when one appears._

Read by: `src/logReader.ts`

No sources watched.

---

Snapshots and past reports: https://github.com/traceroost/core/tree/otel-watch

