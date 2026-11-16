# OpenTelemetry upstream watch: 2026-11-16

## Claude Code

Read by: `src/spanSummarizer.ts`, `src/claudeTurnJoin.ts`, `src/otlpIngest.ts`, `src/otelTraceKeys.ts`

### Monitoring docs (metrics, events, span attributes)

<https://code.claude.com/docs/en/monitoring-usage.md>

- Changed: 74 line(s)

```diff
- | `OTEL_EXPORTER_OTLP_PROTOCOL` | Protocol for OTLP exporter, applies to all signals. Claude Code has no default protocol, so set this or the signal-specific protocol variable for each `otlp` exporter you enable | `grpc`, `http/json`, `http/protobuf` |
- The following environment variables control which attributes are included in metrics to manage cardinality:
- | `OTEL_METRICS_INCLUDE_SESSION_ID` | Include session.id and, on cloud sessions, ccr.session.id attributes in metrics | `true` | `false` |
- | `OTEL_METRICS_INCLUDE_VERSION` | Include app.version attribute in metrics | `false` | `true` |
- | `OTEL_METRICS_INCLUDE_ACCOUNT_UUID` | Include user.account\_uuid and user.account\_id attributes in metrics | `true` | `false` |
- | `OTEL_METRICS_INCLUDE_ENTRYPOINT` | Include app.entrypoint attribute in metrics | `false` | `true` |
- | `OTEL_METRICS_INCLUDE_RESOURCE_ATTRIBUTES` | Include keys from `OTEL_RESOURCE_ATTRIBUTES` as attributes on metric datapoints | `true` | `false` |
- > * **Special characters**: characters outside the allowed range must be percent-encoded
- * **A value has a space inside it**: Claude Code then copies none of the keys onto events or datapoints and reports no error. [Take the space out of the value](#multi-team-organization-support).
- * **Something else already sets the variable**: in a session that the desktop app starts, a variable already set in the launch environment [takes precedence over settings files](https://code.claude.com/docs/en/settings-reference.md#how-env-values-interact-with-your-shell). The [debug log](https://code.claude.com/docs/en/debug-your-config.md) names each ignored variable. When a third-party Desktop deployment [names an OTLP endpoint](#how-managed-settings-lock-the-otlp-destination) in the environment it provides, that environment carries Desktop's own `OTEL_RESOURCE_ATTRIBUTES`.
- export OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=http://metrics.example.com:4318
- * **Identify Claude Tag sessions**: set `OTEL_METRICS_INCLUDE_ENTRYPOINT=true`, as described under [Metrics cardinality control](#metrics-cardinality-control). Metrics then carry `app.entrypoint`, whose value is `claude-in-slack` for Claude Tag sessions.
- | `app.entrypoint` | How the session was launched, such as `cli`, `sdk-cli`, `sdk-ts`, `sdk-py`, `claude-vscode`, or `claude-in-slack` for Claude Tag sessions | `OTEL_METRICS_INCLUDE_ENTRYPOINT` (default: false) |
- | `claude_code.session.count` | Count of CLI sessions started | none |
- Incremented at the start of each session.
- * `query_source`: Category of the subsystem that issued the request. One of `"main"`, `"subagent"`, or `"auxiliary"`
- * `query_source`: Category of the subsystem that issued the request. One of `"main"`, `"subagent"`, or `"auxiliary"`
- * `plugin.name`: Owning plugin when the active skill or subagent is provided by a plugin. Official-marketplace plugin names appear verbatim. Third-party plugin names are replaced with `"third-party"`. Absent when neither the skill nor the subagent has an owning plugin.
- * `mcp_tool.name`: MCP tool whose result this request consumed, with the same redaction and version behavior as `mcp_server.name`. Absent when the request consumed no MCP tool result.
- * `agent.name`, `skill.name`, `plugin.name`, `marketplace.name`, `mcp_server.name`, `mcp_tool.name`: Skill, plugin, agent, and MCP attribution for the request. See [Cost counter](#cost-counter) for definitions and redaction behavior.
- * `agent.name`, `skill.name`, `plugin.name`, `marketplace.name`, `mcp_server.name`, `mcp_tool.name`: Skill, plugin, agent, and MCP attribution for the request. See [Cost counter](#cost-counter) for definitions and redaction behavior.
-     The `source` value doesn't indicate which of these sources matched. To find which one refused a call, look for the [Safety event](#safety-event) with the same `tool_use_id` and read its `category` and `rule_source` attributes. Some refused calls [have no safety event](#calls-without-a-safety-event).
- Logged when a check refuses a tool call or requires a permission prompt, except for [calls without a safety event](#calls-without-a-safety-event). Also logged when the [sandbox's network proxy](https://code.claude.com/docs/en/sandboxing.md#network-isolation) refuses a connection or request, and when a hook blocks a result. Requires Claude Code v2.1.307 or later.
- When Claude Code can't safely determine the retention period, it pauses the sweep and emits the event with `result` set to `"skipped"` and a `skip_reason`. When [managed settings](https://code.claude.com/docs/en/server-managed-settings.md) set `cleanupPeriodDays`, the managed value pins the retention period and the sweep runs even when a settings file in a lower-priority scope is broken or invalid. When `managed-settings.json` itself can't be read, Claude Code still pauses the sweep unless the [managed tier](https://code.claude.com/docs/en/managed-settings.md#how-claude-code-combines-managed-sources) supplies `cleanupPeriodDays` from elsewhere, such as server-managed settings or a `managed-settings.d/` drop-in beside the broken file. The deletion counter attributes are present only when `result` is `"complete"`.
- * `period_days`: The `cleanupPeriodDays` value from merged settings, in days, or `30` when no source sets it. On skipped events, the value the sweep would have used, computed from the settings sources Claude Code could read
- * `used_default`: `"true"` when no readable settings source sets `cleanupPeriodDays`, `"false"` otherwise. On complete events, `"true"` means the 30-day default applied
- | `claude_code.session.count` | Track adoption and engagement over time |
- | Policy hook blocked an action | `hook_execution_complete` | `hook_event`, `num_blocking` |
- | Which tool call a hook refused, and which result or turn end a hook blocked | [`safety_event`](#safety-event) where `category` is `"hook"` and `decision` is `"reject"` for a refused call, or `category` is `"hook_review"` for a blocked result or turn end | `category`, `decision`, `hook_event`; `tool_use_id` for a tool call |
- * Raw file contents and code snippets are not included in metrics or events. Trace spans are a separate data path: see the `OTEL_LOG_TOOL_CONTENT` bullet below
+ | `OTEL_EXPORTER_OTLP_PROTOCOL` | Protocol for OTLP exporter, applies to all signals. Defaults to `http/protobuf` for a valid `http://` or `https://` endpoint. For a gRPC endpoint such as `http://localhost:4317`, set this to `grpc`. The default requires Claude Code v2.1.323 or later | `grpc`, `http/json`, `http/protobuf` |
+ The following environment variables control which attributes are included in metrics and events to manage cardinality:
+ | `OTEL_METRICS_INCLUDE_SESSION_ID` | Include session.id and cloud sessions' ccr.session.id attributes in metrics and events | `true` | `false` |
+ | `OTEL_METRICS_INCLUDE_VERSION` | Include app.version attribute in metrics and events | `false` | `true` |
+ | `OTEL_METRICS_INCLUDE_ACCOUNT_UUID` | Include user.account\_uuid and user.account\_id attributes in metrics and events | `true` | `false` |
+ | `OTEL_METRICS_INCLUDE_ENTRYPOINT` | Include app.entrypoint attribute in metrics and events | `false` | `true` |
+ | `OTEL_METRICS_INCLUDE_RESOURCE_ATTRIBUTES` | Include keys from `OTEL_RESOURCE_ATTRIBUTES` as attributes on metric datapoints and events | `true` | `false` |
+ > * **Special characters**: characters outside the allowed range must be percent-encoded, and an `=` inside a value must be written as `%3D`
+ * **A value has a space inside it**: Claude Code then copies none of the keys onto events or datapoints. To see which value has the space, run `/status` in a session on the remote machine. [Take the space out of the value](#multi-team-organization-support).
+ * **Something else already sets the variable**: in a session that the desktop app starts, a variable already set in the launch environment [takes precedence over settings files](https://code.claude.com/docs/en/settings-reference.md#how-env-values-interact-with-your-shell). The [debug log](https://code.claude.com/docs/en/debug-your-config.md) can name an ignored variable. When a third-party Desktop deployment [names an OTLP endpoint](#how-managed-settings-lock-the-otlp-destination) in the environment it provides, that environment carries Desktop's own `OTEL_RESOURCE_ATTRIBUTES`.
+ export OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=http://metrics.example.com:4318/v1/metrics
+ * **Identify Claude Tag sessions**: set `OTEL_METRICS_INCLUDE_ENTRYPOINT=true`, as described under [Metrics cardinality control](#metrics-cardinality-control). Metrics and events then carry `app.entrypoint`, whose value is `claude-in-slack` for Claude Tag sessions.
+ | `app.entrypoint` | How the session was launched, such as `cli`, `sdk-cli`, `sdk-ts`, `sdk-py`, `claude-vscode`, `claude-desktop` for Claude Desktop Code tab sessions outside the cloud, `claude-desktop-3p` for the same sessions on a [third-party deployment](https://claude.com/docs/third-party/claude-desktop/overview), or `claude-in-slack` for Claude Tag sessions. Cloud session values include `remote`, plus `remote_desktop` and `remote_mobile` for sessions you start from Claude Desktop or the mobile app | `OTEL_METRICS_INCLUDE_ENTRYPOINT` (default: false) |
+ | `claude_code.session.count` | Count of sessions started | none |
+ Incremented at the start of each session. To count people instead, see [Usage monitoring](#usage-monitoring).
+ * `query_source`: Category of the subsystem that issued the request. One of `"main"`, `"subagent"`, `"auxiliary"`, `"plugin_model_complete"`, or `"plugin_model_classify"`. The last two mark the requests a [mod](https://code.claude.com/docs/en/plugins/mods/overview.md) makes with `$.model.complete` or `$.model.classify`. Claude Code counts those requests from v2.1.324, so totals can step up after you upgrade.
+ * `plugin.name`: Owning plugin when the active skill or subagent is provided by a plugin, or the plugin whose `$.model` call made the request. Official-marketplace plugin names appear verbatim. Third-party plugin names are replaced with `"third-party"`. Absent for other requests.
+   * From v2.1.312, the name of a remote server with a fixed URL that a plugin from Anthropic's official marketplace declares also appears verbatim, as `plugin_<plugin>_<server>`. That name is replaced with `"custom"` when the plugin's marketplace copy didn't come from Anthropic's registered source, such as one mounted from a seed directory in a cloud session.
+ * `mcp_tool.name`: MCP tool whose result this request consumed, with the same redaction and version behavior as `mcp_server.name`, except that it can read `"custom"` when `mcp_server.name` shows a `plugin_<plugin>_<server>` name. Absent when the request consumed no MCP tool result.
+ * `query_source`: Category of the subsystem that issued the request. See [Cost counter](#cost-counter) for the values.
+ * `agent.name`, `skill.name`, `plugin.name`, `marketplace.name`, `mcp_server.name`, `mcp_tool.name`: Skill, plugin, agent, and MCP attribution for the request. See [Cost counter](#cost-counter) for definitions and redaction behavior. When a [mod](https://code.claude.com/docs/en/plugins/mods/overview.md) from outside the official marketplace and built-in bundle calls [`$.model`](https://code.claude.com/docs/en/plugins/mods/api#call-a-model), `marketplace.name` is also present, redacted to `"third-party"` unless you set `OTEL_LOG_TOOL_DETAILS=1`.
+ * `agent.name`, `skill.name`, `plugin.name`, `marketplace.name`, `mcp_server.name`, `mcp_tool.name`: Skill, plugin, agent, and MCP attribution for the request. See [Cost counter](#cost-counter) for definitions and redaction behavior. For `marketplace.name` on a mod's `$.model` calls, see [`api_request`](#api-request-event).
+     The `source` value doesn't indicate which of these sources matched. When `classifier_verdict` is present, it gives the classifier outcome that decided the call. No `tool_decision` attribute names the permission rule or setting that refused the call.
+ Claude Code has stopped sending `claude_code.safety_event`:
+ * **v2.1.312 and later**: these versions don't send the event, and no setting turns it on
+ * **v2.1.307 through v2.1.311**: a session stops sending the event at its next feature-flag refresh. A session that doesn't [fetch feature flags](https://code.claude.com/docs/en/env-vars.md#features-that-need-feature-flag-fetching), such as on Amazon Bedrock, Google Cloud's Agent Platform, or Microsoft Foundry, can keep sending it.
+ To see refused tool calls, query [`tool_decision`](#tool-decision-event) events, which show that a call was refused but not always which check refused it.
+ The event details here describe events from v2.1.307 through v2.1.311, where a safety event records [cases](#safety-event-categories) such as these:
+ * A check refuses a tool call or requires a permission prompt, except for [calls without a safety event](#calls-without-a-safety-event)
+ * The [sandbox's network proxy](https://code.claude.com/docs/en/sandboxing.md#network-isolation) refuses a connection or request
+ * A hook blocks a result or the end of a turn
+ Read `result` to see whether the sweep ran:
+ * `"complete"`: the sweep ran, and the event carries its counts
+ * `"skipped"`: Claude Code couldn't safely determine the retention period, so it paused the sweep and the event carries no counts. If `skip_reason` is `"settings_unknowable"` or `"settings_invalid_key_set"`, fix the settings error that `/status` reports on that machine so a later session can run the sweep
+ When [managed settings](https://code.claude.com/docs/en/server-managed-settings.md) set `cleanupPeriodDays`, the managed value pins the retention period and the sweep runs even when a settings file in a lower-priority scope is broken or invalid.
+ * `period_days`: The retention period the sweep started with, in days: `cleanupPeriodDays` from merged settings, with any change from a [`settings.read` hook](https://code.claude.com/docs/en/plugins/mods/events#settings-read-hook) applied. `30` when that leaves the key unset. On skipped events, the value the sweep would have used, computed from the settings sources Claude Code could read
+ * `used_default`: `"true"` when `period_days` fell back to `30`, `"false"` otherwise. On complete events, `"true"` means the 30-day default applied
+ To compare active users across surfaces, set `OTEL_METRICS_INCLUDE_ENTRYPOINT=true` to add [`app.entrypoint`](#standard-attributes) to metrics and events. Then count distinct `user.account_uuid` values per entrypoint on [`claude_code.user_prompt`](#user-prompt-event) events, or on `claude_code.token.usage` if you export only metrics. For example, use `cli` for interactive CLI sessions, and group `claude-desktop`, `claude-desktop-3p`, and `remote_desktop` for the Claude Desktop Code tab.
+ `user.account_uuid` doesn't identify people in Claude Tag channel sessions and is missing from sessions with no Claude account: see [Attribute actions to users](#attribute-actions-to-users). When one person starts many sessions, or a session receives no prompt, [`claude_code.session.count`](#session-counter) goes up without adding an active user.
+ Rows for `safety_event` apply only to a session on v2.1.307 through v2.1.311 that [still sends the event](#safety-event).
+ | Policy hook blocked an action | `hook_execution_complete`, which isn't tied to a call or to `tool_use_id` | `hook_event`, `num_blocking` |
+ | Tool call a hook refused | [`tool_decision`](#tool-decision-event) where `decision` is `"reject"` and `source` is `"hook"` | `decision`, `source`, `tool_use_id` |
+ | Which result or turn end a hook blocked | [`safety_event`](#safety-event) where `category` is `"hook_review"` | `category`, `hook_event`; `tool_use_id` for a tool call |
+ * By default, raw file contents and code snippets aren't included in metrics or events. If you set a variable such as `OTEL_LOG_TOOL_DETAILS` or `OTEL_LOG_RAW_API_BODIES`, events can include them. Trace spans are a separate data path: see the `OTEL_LOG_TOOL_CONTENT` bullet below
```

### CHANGELOG.md (telemetry lines only)

<https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md>

- Changed: 14 telemetry-related line(s) (and 546 other changed line(s) not shown)

```diff
+ - Fixed a missing OpenTelemetry `user_prompt` event for a message sent while tool calls run. The event has `delivery.mode: "mid_turn"` and the running turn's `prompt.id`
+ - Fixed the OpenTelemetry `user_prompt` event leaving out earlier messages' text when queued messages merged into one turn in VS Code, or when one message had an image
+ - Changed `/cost`, `$.session.usage()`, `--max-budget-usd` and the cost and token metrics to count a mod's `$.model.complete` and `$.model.classify` calls
+ - Fixed OpenTelemetry export failing silently when an `otlp` exporter had an endpoint but no `OTEL_EXPORTER_OTLP_PROTOCOL`: it now defaults to `http/protobuf`
+ - Fixed OpenTelemetry export to the default `localhost:4318` endpoint going through a configured proxy
+ - Fixed one malformed `OTEL_RESOURCE_ATTRIBUTES` entry dropping all of that variable's attributes from the OpenTelemetry resource; the others are now kept, and `/status` names the one left off
+ - Fixed OpenTelemetry `user_prompt` events and interaction spans recording a background agent's reply when `OTEL_LOG_ASSISTANT_RESPONSES=0`
+ - Fixed OpenTelemetry exports failing when a proxy took over 10 seconds to reach the collector; it now has 25 seconds, also the most that `OTEL_EXPORTER_OTLP_TIMEOUT` can allow (previously 30)
+ - Fixed OpenTelemetry `agent.name` showing a user-defined subagent's name instead of `custom` when an official plugin's skill launched it
+ - Changed which MCP servers are reported by name in OpenTelemetry exports to follow the current connector directory
+ - [Claude Tag] Added a Scope filter to the Network events tab of Claude Tag's Activity page, so admins can download one scope's events instead of the whole organization's
+ - Fixed OpenTelemetry repository attributes (`vcs.*`) missing from Claude Desktop sessions that start on a pre-started process
+ - Fixed NotebookEdit reporting success to hooks and telemetry when the edit failed, for example when the notebook changed while the permission prompt was open
+ - Changed OpenTelemetry hook events in non-interactive sessions to leave two built-in hooks out of `num_hooks` and `num_success` after Bash and PowerShell calls
```

## Codex

Read by: `src/otlpParser.ts`, `src/spanSummarizer.ts`, `src/otelTraceKeys.ts`

### codex-rs/otel crate and the otel config

<https://github.com/openai/codex>

- 6 commit(s) touched `codex-rs/otel`, `codex-rs/core/src/config/otel.rs`, `codex-rs/core/src/otel_init.rs`:
  - 2026-11-14 [`de83e76`](https://github.com/openai/codex/commit/de83e7674a69b9ae18544dd1fbf53f31bfe8c640) Instrument MCP OAuth credential store locks (#61430)
  - 2026-11-12 [`1f175fa`](https://github.com/openai/codex/commit/1f175fa3c4af6a3f2e8d51971c3734b4a0aaca6b) Clean up Rust error handling and OTLP test assertions (#61201)
  - 2026-11-12 [`c0cc9fc`](https://github.com/openai/codex/commit/c0cc9fc820f62e4dbdde68214dd6d792d6c8a7ee) Add refreshable headers for OTLP HTTP exporters (#61028)
  - 2026-11-12 [`64b8d01`](https://github.com/openai/codex/commit/64b8d019c8881acf1a8bc337db6a1f91eaef3076) Record reasoning replay removal metrics (#61017)
  - 2026-11-10 [`3cd64c8`](https://github.com/openai/codex/commit/3cd64c8d7c688a7ed800742bd0effb81013f1ffb) Preserve MCP trace context when tracing is disabled (#60506)
  - 2026-11-10 [`0e6f153`](https://github.com/openai/codex/commit/0e6f153732cc12bb8d82672c05b4d4840268af33) Derive sandbox telemetry labels directly from permission profiles (#60500)

### codex-rs/otel/README.md (events, attributes, config keys)

<https://raw.githubusercontent.com/openai/codex/main/codex-rs/otel/README.md>

- Changed: 10 line(s)

```diff
- use codex_otel::config::OtelExporter;
- use codex_otel::config::OtelHttpProtocol;
- use codex_otel::config::OtelSettings;
+ use codex_http_client::{HttpClientFactory, OutboundProxyPolicy};
+ use codex_otel::OtelExporter;
+ use codex_otel::OtelHttpProtocol;
+ use codex_otel::OtelSettings;
+     headers_helper: None,
+     http_client_factory: HttpClientFactory::new(OutboundProxyPolicy::ReqwestDefault),
+     runtime_metrics: false,
```

## GitHub Copilot (Chat)

Read by: `src/spanSummarizer.ts`, `src/otlpIngest.ts`

### OTel service, GenAI attributes and events, monitoring docs

<https://github.com/microsoft/vscode-copilot-chat>

- No commits.

## GitHub Copilot (CLI)

Read by: `src/logReader.ts`

### changelog.md (telemetry lines only); the CLI itself is closed source

<https://raw.githubusercontent.com/github/copilot-cli/main/changelog.md>

- Changed: 8 telemetry-related line(s) (and 560 other changed line(s) not shown)

```diff
+ - Sandboxed MCP startup errors identify refused filesystem operations even when the server prints a stack trace
+ - After /compact, the runtime no longer keeps a CPU core busy until the next event, and the session's live event stream no longer skips events that arrive after a compaction removed earlier ones
+ - When an extension fails to load, its log now shows the full error report, including the file and line of a syntax error, the stack trace and any cause, instead of a single line.
+ - Starting `copilot` from a directory that has since been deleted now says the directory no longer exists and how to recover, instead of crashing with a Node stack trace, and `-C <directory>` now works from there.
+ - Assistant replies no longer indent or wrap the row after an inline code span that ends exactly at the right edge
+ - Hook events and other JSON settings can be saved from their editor in /settings; unset hook events now open as an empty list
+ - Resuming a session by name with --resume no longer sends the session name in telemetry; only a session ID is reported
+ - The session.usage_info event now reports isInitial as true only for the session's first usage report, as documented, instead of for the first model request of every message.
```

## OpenCode

_TraceRoost reads OpenCode's SQLite database, not its (experimental, undocumented) OTel export. This watches the export so we know when it is worth ingesting._

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

