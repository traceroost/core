# OpenTelemetry upstream watch — 2026-11-02

## Claude Code

Read by: `src/spanSummarizer.ts`, `src/claudeTurnJoin.ts`, `src/otlpIngest.ts`, `src/otelTraceKeys.ts`

### Monitoring docs (metrics, events, span attributes)

<https://code.claude.com/docs/en/monitoring-usage.md>

- Changed: 10 line(s)

```diff
- * **Claude Tag channels use organization-level environments**: channel sessions run in organization-level environments rather than members' personal ones, so make the allowlist and any environment-variable changes on the [shared environment](https://code.claude.com/docs/en/cloud-environments.md#organization-shared-environments) set as your organization's default or pinned to the channel.
- When `prometheus` is the only exporter listed in `OTEL_METRICS_EXPORTER`, Claude Code omits the `USD`, `tokens`, and `s` units from the exported metrics so the scrape stays valid Prometheus text format. Metric names don't change, and configurations that combine exporters, such as `otlp,prometheus`, keep the units. Before v2.1.216, the Prometheus scrape included OpenMetrics-only `# UNIT` lines that some scrapers rejected.
-     Claude Code also reports `"config"` when the permission prompt request itself fails. For example, that request fails when the Agent SDK's [`canUseTool`](https://code.claude.com/docs/en/agent-sdk/typescript#canusetool) callback or the [`--permission-prompt-tool`](https://code.claude.com/docs/en/cli-reference#cli-flags) tool returns an invalid result, or when the input stream closes while the request is pending. Before v2.1.216, Claude Code reported these failures as `"user_reject"`.
-   * `"user_abort"`: Emitted when the user dismissed the permission prompt without answering. In Agent SDK and non-interactive `-p` sessions, this includes interrupting the turn while a `canUseTool` or `--permission-prompt-tool` permission request is pending; before v2.1.216, Claude Code reported that interrupt as `"user_reject"`. Treated as a reject.
+ * **Claude Tag channels**: make the allowlist and any environment-variable changes on the [shared environment](https://code.claude.com/docs/en/cloud-environments.md#organization-shared-environments) set as your organization's default or pinned to the channel.
+ When `prometheus` is the only exporter listed in `OTEL_METRICS_EXPORTER`, Claude Code omits the `USD`, `tokens`, and `s` units from the exported metrics so the scrape stays valid Prometheus text format. Metric names don't change, and configurations that combine exporters, such as `otlp,prometheus`, keep the units.
+ * `cache_creation_5m_tokens`, `cache_creation_1h_tokens`: the number of tokens the API response reports as written to the cache with a five-minute [cache lifetime](https://code.claude.com/docs/en/prompt-caching.md#cache-lifetime) and the number written with a one-hour lifetime. Both are `0` when the API response doesn't report them, even when `cache_creation_tokens` is above zero. Requires Claude Code v2.1.300 or later
+     Claude Code also reports `"config"` when the permission prompt request itself fails. For example, that request fails when the Agent SDK's [`canUseTool`](https://code.claude.com/docs/en/agent-sdk/typescript#canusetool) callback or the [`--permission-prompt-tool`](https://code.claude.com/docs/en/cli-reference#cli-flags) tool returns an invalid result, or when the input stream closes while the request is pending.
+   * `"user_abort"`: Emitted when the user dismissed the permission prompt without answering. In Agent SDK and non-interactive `-p` sessions, this includes interrupting the turn while a `canUseTool` or `--permission-prompt-tool` permission request is pending. Treated as a reject.
+   * `"remote_settings_unknowable"`: A session in Claude Desktop's Code tab on a third-party deployment requested [server-managed settings](https://code.claude.com/docs/en/server-managed-settings.md). It received no usable response, so `cleanupPeriodDays` may be set to a value Claude Code can't see
```

### CHANGELOG.md (telemetry lines only)

<https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md>

- Changed: 9 telemetry-related line(s) (and 300 other changed line(s) not shown)

```diff
+ - Fixed PowerShell hooks not blocking on exit code 2 when the command begins with a type cast, `param`, `using` or an attribute
+ - Updated the `/claude-api` skill: its Datadog setup for API tracing now sends the `dd-llmobs-enabled: true` header, as the Console does, and its `ant` install instructions drop the outdated macOS `xattr` step
+ - Changed idle compaction to also run for subscribers with telemetry turned off, and on Bedrock, Vertex, Foundry and LLM gateways once the one-hour prompt cache is on
+ - Fixed the spinner, OpenTelemetry `effort` values and transcripts naming a newly picked effort level during a task before the model applied it; they now show the level in force
+ - Changed prompt and agent hooks to run at most 24 at a time per session, sub-agents included, plus at most 12 that have waited longer than their event's timeout; a `timeout` under 1 second now counts as 1 second
+ - Changed OpenTelemetry `mcp_server.name` to report the real name of fixed-URL remote MCP servers declared by plugins from the official Anthropic marketplace, instead of `custom`
+ - Changed Claude Code to stop sending the `claude_code.safety_event` OpenTelemetry event
+ - [Code Review] Fixed Code Review reviewing an outdated commit, or none at all, when GitHub delivered a push event late; it now reviews the pull request's current commit
+ - [VSCode] Changed the extension to start Claude Code sessions with `DISABLE_TELEMETRY` set while VS Code's telemetry setting is off, so they send no usage metrics or error reports and fetch no feature flags
```

## Codex

Read by: `src/otlpParser.ts`, `src/spanSummarizer.ts`, `src/otelTraceKeys.ts`

### codex-rs/otel crate and the otel config

<https://github.com/openai/codex>

- 9 commit(s) touched `codex-rs/otel`, `codex-rs/core/src/config/otel.rs`, `codex-rs/core/src/otel_init.rs`:
  - 2026-10-31 [`67f0994`](https://github.com/openai/codex/commit/67f0994b532b8740f14b5b738af7b7b2a915b1d6) Tighten Bazel CI snapshot handling and OTLP test cleanup (#58459)
  - 2026-10-29 [`2ca71f1`](https://github.com/openai/codex/commit/2ca71f1683524176427aaa5fdfbf0358d541fd15) Record additional context counts, sizes, and truncation metrics (#58144)
  - 2026-10-29 [`588a277`](https://github.com/openai/codex/commit/588a277b301c3994455885d7f771d7d9db5d82b8) Add an option to disable successful SSE delta logs (#58034)
  - 2026-10-28 [`fc916a2`](https://github.com/openai/codex/commit/fc916a22b57e9d7b17988f044a54794d2222ae2c) Expose Guardian assessments in response streams (#57757)
  - 2026-10-28 [`154e873`](https://github.com/openai/codex/commit/154e8736a51224e12b2d990753622a2cd8118f54) Support managed OpenTelemetry metadata and PEM client identities (#57658)
  - 2026-10-28 [`0736b26`](https://github.com/openai/codex/commit/0736b26422266631c8df55c465fafc6a7fbf7dd3) Fix trace exporter activation after account switches (#57657)
  - 2026-10-28 [`bea47c0`](https://github.com/openai/codex/commit/bea47c06dfac12ecce362090418e12a6faeedbf9) Redact OTEL exporter headers in app-server config responses (#57654)
  - 2026-10-28 [`727283c`](https://github.com/openai/codex/commit/727283cea5ba30e8cf8bbac6b68a03a4d91cf1b7) Support managed OpenTelemetry configuration requirements (#57649)
  - 2026-10-27 [`2cab11c`](https://github.com/openai/codex/commit/2cab11ca40aad193382348a7bda46da2fc47596a) Pin the Rust toolchain to 1.95.0 (#57373)

### codex-rs/otel/README.md (events, attributes, config keys)

<https://raw.githubusercontent.com/openai/codex/main/codex-rs/otel/README.md>

- Changed: 2 line(s)

```diff
-     span_attributes: std::collections::BTreeMap::new(),
+     span_attributes: std::collections::HashMap::new(),
```

## GitHub Copilot (Chat)

Read by: `src/spanSummarizer.ts`, `src/otlpIngest.ts`

### OTel service, GenAI attributes and events, monitoring docs

<https://github.com/microsoft/vscode-copilot-chat>

- No commits.

## GitHub Copilot (CLI)

Read by: `src/logReader.ts`

### changelog.md (telemetry lines only) — the CLI itself is closed source

<https://raw.githubusercontent.com/github/copilot-cli/main/changelog.md>

- Changed, but no line matched the telemetry pattern (7 line(s) differ).

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

