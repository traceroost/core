# OpenTelemetry upstream watch: 2026-11-23

## Claude Code

Read by: `src/spanSummarizer.ts`, `src/claudeTurnJoin.ts`, `src/otlpIngest.ts`, `src/otelTraceKeys.ts`

### Monitoring docs (metrics, events, span attributes)

<https://code.claude.com/docs/en/monitoring-usage.md>

- Changed: 61 line(s)

```diff
- > Wrapping values in quotes doesn't escape spaces. For example, `org.name="My Company"` results in the literal value `"My Company"` with the quotes included, not `My Company`.
- To see which remote machine a [Desktop SSH session](https://code.claude.com/docs/en/desktop.md#ssh-sessions) ran on, name each machine in a custom attribute. Metrics and events don't name the machine a session ran on.
- When nothing else sets the variable, `host.name` arrives in the resource block, in Desktop SSH sessions and in the CLI on that machine. For where else custom attributes appear, see [Multi-team organization support](#multi-team-organization-support).
- If the name doesn't arrive, check for one of these causes:
- * **A value has a space inside it**: Claude Code then copies none of the keys onto events or datapoints. To see which value has the space, run `/status` in a session on the remote machine. [Take the space out of the value](#multi-team-organization-support).
- * `request_id`: the [`request_id`](#event-correlation-attributes) of the API response that contained this tool call, so you can join the call to that response's API events. Absent when that response had no request ID, or when no API response contained the call. Requires Claude Code v2.1.310 or later
- * `request_id`: the [`request_id`](#event-correlation-attributes) of the API response that contained this tool call, so you can join the call to that response's API events. Absent when that response had no request ID, or when no API response contained the call. Requires Claude Code v2.1.310 or later
- * `classifier_category` (when `OTEL_LOG_TOOL_DETAILS=1`): The name of the [built-in rule](https://code.claude.com/docs/en/auto-mode-config.md#inspect-the-defaults-and-your-effective-config) the classifier named when it blocked the call, in lowercase with underscores, such as `"data_exfiltration"` for the Data Exfiltration rule. Requires Claude Code v2.1.301 or later. The attribute is present when both of these hold:
-   * The classifier named exactly one rule, and that rule is a built-in one rather than one you wrote
-   Before v2.1.302, the attribute was also absent on any block that [server-side classifier review](https://code.claude.com/docs/en/permission-modes.md#server-side-classifier-review) decided.
- * `classifier_category`: With `OTEL_LOG_TOOL_DETAILS=1`, the [built-in rule](https://code.claude.com/docs/en/auto-mode-config.md#inspect-the-defaults-and-your-effective-config) behind an auto mode block, such as `"data_exfiltration"`
- * `total_tool_uses`: Number of tool calls the subagent made across the whole run
- * `"skipped"`: Claude Code couldn't safely determine the retention period, so it paused the sweep and the event carries no counts. If `skip_reason` is `"settings_unknowable"` or `"settings_invalid_key_set"`, fix the settings error that `/status` reports on that machine so a later session can run the sweep
-   * `"settings_unknowable"`: A settings file couldn't be read or parsed, so `cleanupPeriodDays` or `desktopSessionCleanupPeriodDays` may be set to a value Claude Code can't see
- * `managed_settings.resolved_sha256` (when `OTEL_LOG_MANAGED_SETTINGS=1`): SHA-256 of the resolved managed settings before redaction, serialized as JSON with keys sorted recursively and no whitespace. Machines with the same digest run the same policy. Claude Code sends the digest only with the opt-in because a short policy can be recovered by hashing guesses. Absent when no managed settings resolved, and on `refused` events
+ ```
+ ```json theme={null}
+ {
+   "env": {
+   }
+ }
+ | `OTEL_RESOURCE_INCLUDE_HOST` | Add the machine's name and ID to the resource attributes of metrics, events, and traces (default: disabled). See [Identify the machine a session ran on](#identify-the-machine-a-session-ran-on). Requires Claude Code v2.1.326 or later | `1` to enable |
+ ### Identify the machine a session ran on
+ To see which machine each session ran on, set `OTEL_RESOURCE_INCLUDE_HOST=1` on Claude Code v2.1.326 or later. Set it under `env` in [managed settings](https://code.claude.com/docs/en/managed-settings.md) or user settings, or in the shell you start `claude` from, not in [project or local settings](https://code.claude.com/docs/en/settings-reference.md#variables-claude-code-ignores-in-env).
+ The following example sets it in a settings file:
+     "OTEL_RESOURCE_INCLUDE_HOST": "1"
+ The attributes `host.name` and `host.id` then appear in the resource block of metrics, events, and traces, not on metric datapoints:
+ * `host.name`: the machine's host name
+ * `host.id`: the operating system's machine ID, not hashed. That's the contents of `/etc/machine-id` on Linux, `IOPlatformUUID` on macOS, and the `MachineGuid` registry value on Windows. It's left out when Claude Code can't read one, for example in a container whose image has no machine ID.
+ Both attributes name the machine that Claude Code runs on. In a Desktop SSH session that's the remote machine, so set the variable there: see [Attribute telemetry to Desktop SSH sessions](#attribute-telemetry-to-desktop-ssh-sessions). In a container, `host.name` is the container's own host name, so to name the machine that runs the container, declare the name yourself in [`OTEL_RESOURCE_ATTRIBUTES`](#multi-team-organization-support).
+ #### Troubleshoot missing host attributes
+ If `host.name` and `host.id` are missing, check where and when you set `OTEL_RESOURCE_INCLUDE_HOST` and what started the session. Then check your exporter and endpoint variables and how your backend shows resource attributes:
+ * **The session's Claude Code is older than v2.1.326**: update it
+ * **You set the variable only in project or local settings**: set it in managed settings, user settings, or your shell. Run `/status` to see which variables Claude Code ignored.
+ * **The variable is `0` in a managed or user settings file**: if you set `1` [in your shell or in a lower-precedence file](https://code.claude.com/docs/en/settings-reference.md#how-env-values-interact-with-your-shell), the `0` still applies. Change the `0`, or ask your administrator if it's in managed settings.
+ * **You set the variable after the session started**: start a new session, because Claude Code reads it once at startup
+ * **The desktop app started the session**: a local session gets some variables from your shell profile, but not this one, so set it in managed or user settings. For a Desktop SSH session, set it on the remote machine: see [Attribute telemetry to Desktop SSH sessions](#attribute-telemetry-to-desktop-ssh-sessions).
+ * **The session is a cloud session in an Anthropic-hosted environment**: the attributes aren't added there. To tell cloud sessions apart, see [Attribute telemetry to cloud sessions](#attribute-telemetry-to-cloud-sessions).
+ * **Any exporter variable lists `console`**: remove `console` from `OTEL_METRICS_EXPORTER`, `OTEL_LOGS_EXPORTER`, and `OTEL_TRACES_EXPORTER`, and the attributes arrive at your other exporters
+ * **A per-signal endpoint variable, such as `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`, isn't a URL**: write a bare `10.0.0.1:4317` as a URL, such as `http://10.0.0.1:4317`
+ * **Your metrics backend doesn't surface resource attributes**: with the `prometheus` exporter, look for the `host_name` and `host_id` labels of the `target_info` metric. Otherwise, look in the resource block of events and traces, or declare the name yourself in [`OTEL_RESOURCE_ATTRIBUTES`](#multi-team-organization-support), which by default also reaches metric datapoints.
+ > Wrapping values in quotes doesn't escape spaces.
+ To see which remote machine a [Desktop SSH session](https://code.claude.com/docs/en/desktop.md#ssh-sessions) ran on, either set [`OTEL_RESOURCE_INCLUDE_HOST=1`](#identify-the-machine-a-session-ran-on) or [name each machine in a custom attribute](#name-each-remote-machine-in-a-custom-attribute). Choose the custom attribute if you need the name on metric datapoints: with `OTEL_RESOURCE_INCLUDE_HOST=1`, `host.name` appears in the resource block only.
+ Set `OTEL_RESOURCE_INCLUDE_HOST` on the remote machine, in the `env` block that turns telemetry on, in the [managed settings file the session reads](https://code.claude.com/docs/en/desktop.md#managed-settings). The [copy of Claude Code that the session runs](https://code.claude.com/docs/en/desktop.md#files-and-processes-on-the-remote-machine) must be v2.1.326 or later. If `host.name` and `host.id` don't arrive, see [Troubleshoot missing host attributes](#troubleshoot-missing-host-attributes).
+ #### Name each remote machine in a custom attribute
+ `host.name` arrives in the resource block and, by default, on metric datapoints and events. Desktop SSH sessions and the CLI on that machine both send it. To keep it off datapoints, see [Multi-team organization support](#multi-team-organization-support).
+ If the name that you set in `OTEL_RESOURCE_ATTRIBUTES` doesn't arrive, check for one of these causes:
+ * **A value has a space inside it**: Claude Code can then leave `host.name` off events and datapoints. To see which value has the space, run `/status` in a session on the remote machine. [Take the space out of the value](#multi-team-organization-support).
+ * `request_id`: the [`request_id`](#event-correlation-attributes) of the API response that contained this tool call or the [Code Mode](https://code.claude.com/docs/en/code-mode.md#monitor-code-mode-with-opentelemetry) code that made it. Use it to join the call to that response's API events. Absent when that response had no request ID, or when no API response contained the call or its code. Requires Claude Code v2.1.310 or later
+ * `request_id`: the [`request_id`](#event-correlation-attributes) of the API response that contained this tool call or the [Code Mode](https://code.claude.com/docs/en/code-mode.md#monitor-code-mode-with-opentelemetry) code that made it. Use it to join the call to that response's API events. Absent when that response had no request ID, or when no API response contained the call or its code. Requires Claude Code v2.1.310 or later
+   * In [Code Mode](https://code.claude.com/docs/en/code-mode.md#monitor-code-mode-with-opentelemetry), the classifier's review of the code covered the call
+ * `classifier_category` (when `OTEL_LOG_TOOL_DETAILS=1`): The name of the [policy](https://code.claude.com/docs/en/auto-mode-config.md#fix-a-policy-denial) or [built-in rule](https://code.claude.com/docs/en/auto-mode-config.md#inspect-the-defaults-and-your-effective-config) the classifier named when it blocked the call, in lowercase with underscores, such as `"data_exfiltration"` for the Data Exfiltration rule. Requires Claude Code v2.1.301 or later. The attribute is present when both of these hold:
+   * The classifier gave exactly one name, and Claude Code recognizes it as a policy or a built-in rule
+   Before v2.1.302, the attribute was also absent on any block that [server-side classifier review](https://code.claude.com/docs/en/permission-modes.md#server-side-classifier-review) decided. Before v2.1.323, it was absent on blocks that named a policy.
+ * `classifier_category`: With `OTEL_LOG_TOOL_DETAILS=1`, the [built-in rule](https://code.claude.com/docs/en/auto-mode-config.md#inspect-the-defaults-and-your-effective-config) behind an auto mode block, such as `"data_exfiltration"`, under the same conditions as on [`tool_decision`](#tool-decision-event)
+ * `total_tool_uses`: Number of tool calls the subagent made across the whole run, excluding [`SubagentHandback`](https://code.claude.com/docs/en/tools-reference)
+ * `"skipped"`: Claude Code couldn't safely determine the retention period, so it paused the sweep and the event carries no counts. If `skip_reason` is `"settings_unknowable"` or `"settings_invalid_key_set"`, fix any settings error that `/status` reports on that machine so a later session can run the sweep
+   * `"settings_unknowable"`: A settings source couldn't be read or parsed, so `cleanupPeriodDays` or `desktopSessionCleanupPeriodDays` may be set to a value Claude Code can't see
+ * `managed_settings.resolved_sha256` (when `OTEL_LOG_MANAGED_SETTINGS=1`): SHA-256 of the resolved managed settings before redaction, serialized as JSON with keys sorted recursively and no whitespace. Machines with the same digest resolved the same managed settings. The event carries the digest only with the opt-in because a short policy can be recovered by hashing guesses. Absent when no managed settings resolved, and on `refused` events
+ * `host.name`, `host.id`: The machine's name and ID, off by default. See [Identify the machine a session ran on](#identify-the-machine-a-session-ran-on).
+ * The machine's name and ID aren't included by default. To include them as `host.name` and `host.id`, set [`OTEL_RESOURCE_INCLUDE_HOST=1`](#identify-the-machine-a-session-ran-on). A host name often contains a person's name, and `host.id` is a lasting identifier for the machine. If you set the variable in managed settings, tell the people who use those machines, because Claude Code shows them no notice.
```

### CHANGELOG.md (telemetry lines only)

<https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md>

- Changed: 25 telemetry-related line(s) (and 936 other changed line(s) not shown)

```diff
+ - Added easel, a built-in mod that draws charts when asked and under MCP metrics results, on Pro, Max and, where available, Team and Enterprise on macOS and Linux; turn automatic charts off in `/config`
+ - Added `claude_code_self_hosted_runner_order_to_registered_seconds` to the self-hosted runner's `/metrics`: seconds from work order issued to registration accepted, on orchestrator-spawned runners
+ - Added `claude_code_self_hosted_runner_order_to_first_session_seconds` to the self-hosted runner's `/metrics`: seconds from work order to first session handed over, on runners started for a session
+ - Self-hosted runner: Fixed tool calls behind a permission prompt vanishing with no result when a new runner took over the prompt, in sessions with telemetry off
+ - Fixed scheduled tasks on self-hosted runners having no tool to notify their owner when telemetry is off or a third-party provider is used
+ - Added support for turning on Code Mode while OpenTelemetry events and metrics are enabled; each tool call the code makes sends its events; tracing still keeps it off
+ - Improved auto mode's handling of a short reply such as "yes" to Claude's question when telemetry is off, behind a gateway to the Anthropic API, or on Microsoft Foundry
+ - Changed Code Mode to also start when telemetry, nonessential traffic or feature flags are turned off; an administrator can keep it off in managed settings
+ - Added a notice in `/status` and `claude doctor` when an OpenTelemetry exporter has no endpoint and its data would likely be lost
+ - Self-hosted runner: Added `claude_code_self_hosted_orchestrator_session_queue_wait_by_reason_seconds` to the orchestrator's `/metrics`, so a re-opened session's wait can be told from a new one's
+ - Self-hosted runner: Added an orchestrator metric, `claude_code_self_hosted_orchestrator_sessions_given_up_total`, that counts by cause how often Anthropic gave up starting a runner for a session
+ - Fixed saving a scheduled task erasing the project's other saved tasks when the scheduled tasks file can't be read, on third-party providers or with telemetry or feature flags turned off
+ - Fixed MCP tools whose input schema starts with `anyOf`, `oneOf` or `allOf` going missing on third-party providers or with telemetry or feature flags turned off
+ - Fixed an MCP tool with an invalid input schema failing requests on third-party providers or with telemetry or feature flags turned off; the tool is now left out and Claude is told why
+ - Fixed one malformed `OTEL_RESOURCE_ATTRIBUTES` entry dropping the variable's other labels from metric points, events, and spans. Now only that entry is left off
+ - Changed Claude Desktop and Agent SDK sessions on third-party providers or with telemetry or feature flags off to end the turn when closed with a question open, instead of continuing without an answer
+ - Changed pasted text to be marked for Claude as pasted, on third-party providers or with telemetry or feature flags turned off
+ - Changed subagent progress summaries in terminal sessions on the Anthropic API to be written by the default small fast model from short notes, also with telemetry off, using far fewer tokens
+ - Added `OTEL_RESOURCE_INCLUDE_HOST` to include `host.name` and `host.id` in OpenTelemetry resource attributes (off by default)
+ - Fixed PreToolUse hooks in managed settings leaving no OpenTelemetry `tool_decision` event or `permission_denials` entry when they refused a direct tool call
+ - Fixed compaction on Bedrock, Vertex and Foundry, and with telemetry turned off, sometimes replying to one of your messages instead of summarizing, or leaving Claude's last reply out of the summary
+ - Fixed a crashed Node or Python hook showing only the first line of its stack trace; the error is now shown, and Ctrl+O shows up to 10,000 characters of the output
+ - Improved Monitor: when a watch expires with no events and its command wrote to stderr, Claude is now told so and told which file holds the output
+ - Changed Cowork cloud sessions to hold an organization's OpenTelemetry export until the first turn; a session that gets no message now sends nothing, so `claude_code.session.count` can fall
+ - [VSCode] Changed the text of extension errors in event listeners, views and activation to stay out of the editor's own error telemetry
```

## Codex

Read by: `src/otlpParser.ts`, `src/spanSummarizer.ts`, `src/otelTraceKeys.ts`

### codex-rs/otel crate and the otel config

<https://github.com/openai/codex>

- 6 commit(s) touched `codex-rs/otel`, `codex-rs/core/src/config/otel.rs`, `codex-rs/core/src/otel_init.rs`:
  - 2026-11-20 [`548dd62`](https://github.com/openai/codex/commit/548dd628df95e01dbaee503ca9cbb216242baaf1) Specialize OpenTelemetry providers for HTTP traces and metrics (#62854)
  - 2026-11-19 [`65454c7`](https://github.com/openai/codex/commit/65454c7b994e01cfe594b4c3b0f9971bf70aafdb) Add OpenTelemetry for subagent lifecycles (#62567)
  - 2026-11-19 [`617ad20`](https://github.com/openai/codex/commit/617ad20df0a3658ab7cff155531260b5edeac3ef) Remove the real-time wait from the OTLP headers helper timeout test (#62566)
  - 2026-11-19 [`39c29c3`](https://github.com/openai/codex/commit/39c29c3bb620f91e84a3bb266bb496dfb697c101) Add Statsig counters for `exec_command` latency (#62507)
  - 2026-11-17 [`8fca6ff`](https://github.com/openai/codex/commit/8fca6ffb92a602875a0b97e3e535eb48375bdd8c) Support OTel header helpers in local managed requirements (#62110)
  - 2026-11-16 [`56e4366`](https://github.com/openai/codex/commit/56e43660f8c8743a43117da53add23c0608e6a8e) Default Statsig metrics exports to Zstandard compression (#61911)

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

### changelog.md (telemetry lines only); the CLI itself is closed source

<https://raw.githubusercontent.com/github/copilot-cli/main/changelog.md>

- Changed, but no line matched the telemetry pattern (4 line(s) differ).

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

