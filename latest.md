# OpenTelemetry upstream watch — 2026-11-09

## Claude Code

Read by: `src/spanSummarizer.ts`, `src/claudeTurnJoin.ts`, `src/otlpIngest.ts`, `src/otelTraceKeys.ts`

### Monitoring docs (metrics, events, span attributes)

<https://code.claude.com/docs/en/monitoring-usage.md>

- Changed: 5 line(s)

```diff
- > Cost metrics are approximations. For official billing data, refer to your API provider (Claude Console, Amazon Bedrock, or Google Cloud's Agent Platform).
+ >
+ > [!WARNING]
+ > Set `ENABLE_BETA_TRACING_DETAILED` only for debugging, not in production. Detailed beta tracing has a high export volume, and its [content attributes](#new-context-gates) aren't part of the stable span schema.
+ > Cost metrics are approximations. For official billing data, see [Manage costs for your organization](https://code.claude.com/docs/en/costs.md#manage-costs-for-your-organization).
```

### CHANGELOG.md (telemetry lines only)

<https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md>

- Changed: 11 telemetry-related line(s) (and 309 other changed line(s) not shown)

```diff
+ - Changed auto mode with telemetry or feature flags off, including behind LLM gateways: calls the server can't check are asked about or denied, with no fallback to the built-in classifier; set `CLAUDE_CODE_AUTO_MODE_SERVER=0` to keep using it (Bedrock, Vertex and Foundry are unchanged)
+ - Added the `CLAUDE_CODE_DISABLE_FEATURE_FLAGS` environment variable, which stops feature-flag fetching without turning off telemetry; every flag then uses its built-in default
+ - Fixed detailed beta tracing not presenting `CLAUDE_CODE_CLIENT_CERT` to collectors that require a client certificate
+ - Fixed the OpenTelemetry `claude_code.session.count` metric counting Agent SDK `prewarm()` processes that were never claimed; a pre-started process now counts once, when it is claimed
+ - Fixed a terminal whose Claude apps gateway sign-in had expired sending telemetry and managed-settings requests that the gateway refused and logged as `invalid_token`
+ - Changed subagent progress summaries on Bedrock, Vertex, Foundry, or with telemetry off: on a cold prompt cache, one can now wait up to 5 minutes for the subagent's pending response
+ - Added `anthropic.plan`, `anthropic.seat_type`, `anthropic.provider` and `anthropic.custom_base_url` to OTel metrics, events and spans
+ - Fixed OpenTelemetry exports to an `https://` endpoint through a proxy never being sent when they started while another export was still in progress
+ - Fixed a flood of connection attempts to a proxy that blocks (HTTP 403) OpenTelemetry exports to an `http://` endpoint
+ - Fixed OpenTelemetry exports hanging indefinitely behind a proxy that never answers; they now time out after 10 seconds, or `OTEL_EXPORTER_OTLP_TIMEOUT` up to 30 seconds
+ - [VSCode] Fixed `ultrathink` not raising effort for its turn or showing its rainbow when telemetry is off
```

## Codex

Read by: `src/otlpParser.ts`, `src/spanSummarizer.ts`, `src/otelTraceKeys.ts`

### codex-rs/otel crate and the otel config

<https://github.com/openai/codex>

- 6 commit(s) touched `codex-rs/otel`, `codex-rs/core/src/config/otel.rs`, `codex-rs/core/src/otel_init.rs`:
  - 2026-11-07 [`5226f2f`](https://github.com/openai/codex/commit/5226f2fb4bcbc4aa3ec1863b6ba0bd2c4ddb0486) Add metrics for incremental exec catalog updates (#60177)
  - 2026-11-06 [`74417e9`](https://github.com/openai/codex/commit/74417e9c6bd77bee8b7bb315084d6743f9390394) Reuse decoded WebSocket event kinds in telemetry (#59769)
  - 2026-11-04 [`bd7cfa3`](https://github.com/openai/codex/commit/bd7cfa3f69a899598a2c5103ee8aa7d1d1bcc212) Record saved multi-agent opt-outs in session telemetry (#59478)
  - 2026-11-03 [`dec38fc`](https://github.com/openai/codex/commit/dec38fc9bb8304f3e34d00d7cee77f5c0488584f) Add WebSocket connection metrics with reauthentication labels (#59018)
  - 2026-11-02 [`66e3b5a`](https://github.com/openai/codex/commit/66e3b5a02c17acafb470f0929f0b729259ba394c) Record turn critical path metrics and trace fields (#58980)
  - 2026-11-02 [`1a604d5`](https://github.com/openai/codex/commit/1a604d58da344c84528fecd5b5154105f597d70b) Refine additional-context byte histogram buckets (#58939)

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

- Changed: 23 telemetry-related line(s) (and 1333 other changed line(s) not shown)

```diff
+ - copilot help monitoring now describes the github.copilot.sandbox.operation.count metric as counting every sandbox decision by kind, not only deduplicated posture changes.
+ - Include session start, resume, and model-change events in `-p --output-format json` output
+ - A turn that ends while the session event log cannot be written now still ends with `session.idle`, so `sendAndWait` no longer times out on a turn that completed.
+ - Add MATS telemetry for Entra authentication through OneAuth, respecting client telemetry opt-out.
+ - Add MATS telemetry for Entra authentication through OneAuth, respecting client telemetry opt-out.
+ - `copilot help monitoring` now says an `http://` OTLP endpoint disables export only when an OTLP CA certificate or client certificate/key variable is set, not for every `http://` endpoint.
+ - `copilot help monitoring` now says an `http://` OTLP endpoint disables export only when an OTLP CA certificate or client certificate/key variable is set, not for every `http://` endpoint.
+ - /chronicle cost reports count each newly recorded model call once, even when its usage event is received again
+ - /chronicle cost reports count each newly recorded model call once, even when its usage event is received again
+ - Searching a `/share html` export or an exported research report now highlights the text you searched for, instead of a shifted span or a broken emoji, when the conversation contains a capital dotted I (İ).
+ - Searching a `/share html` export or an exported research report now highlights the text you searched for, instead of a shifted span or a broken emoji, when the conversation contains a capital dotted I (İ).
+ - Warn when older messages are dropped for context limits and include compaction/truncation events in JSON output.
+ - Warn when older messages are dropped for context limits and include compaction/truncation events in JSON output.
+ - A telemetry-disabled warning raised while resuming a session is saved to the session history, so later events no longer reference a missing parent.
+ - A telemetry-disabled warning raised while resuming a session is saved to the session history, so later events no longer reference a missing parent.
+ - Resuming a session with an unreadable event log now reports a load error instead of not found
+ - Resuming a session with an unreadable event log now reports a load error instead of not found
+ - Code blocks in assistant replies keep their lines and indentation after a line that starts with a triple-backtick code span, a fence line with a language inside another code block, or indented text right after a closing fence, instead of being joined into one line.
+ - Code blocks in assistant replies keep their lines and indentation after a line that starts with a triple-backtick code span, a fence line with a language inside another code block, or indented text right after a closing fence, instead of being joined into one line.
+ - An invalid server entry in a trusted workspace `.mcp.json`, or a file that is malformed or unreadable, is now reported as an MCP warning in interactive sessions and in `copilot -p` (stderr, or a `session.warning` event with `--output-format json`) instead of the server silently missing; before, only `copilot mcp list` said why.
+ - An invalid server entry in a trusted workspace `.mcp.json`, or a file that is malformed or unreadable, is now reported as an MCP warning in interactive sessions and in `copilot -p` (stderr, or a `session.warning` event with `--output-format json`) instead of the server silently missing; before, only `copilot mcp list` said why.
+ - copilot help no longer crashes with a stack trace when its output is piped to a command that exits early
+ - copilot help no longer crashes with a stack trace when its output is piped to a command that exits early
```

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

