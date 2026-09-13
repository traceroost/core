# TraceRoost Test Data Strategy

TraceRoost uses three categories of test data. Each category is intended to detect a different class of parser, summarizer, and dashboard regression.

## 1. Synthetic Golden Fixtures

Synthetic fixtures are deterministic and suitable for source control. They should cover the parser and summarizer contracts for each supported agent:

- Claude Code: `claude_code.interaction`, `claude_code.llm_request`, `claude_code.tool`, tool errors, missing/available file paths.
- GitHub Copilot: `invoke_agent`, `chat/*`, `execute_tool/*`, edits, tool results, TTFT, cache tokens.
- Codex: `codex.user_prompt`, `codex.sse_event`, `codex.tool_decision`, `codex.tool_result`, raw tool trace spans joined by `otel.trace_id`, startup/background spans.
- Stress cases: repeated tool calls, error recurrence, large token growth, prompt redaction, and in-progress traces.

Fixture maintenance commands:

```sh
pnpm run fixtures:generate
pnpm run fixtures:validate
pnpm run fixtures:check
```

Fixture replay command:

```sh
pnpm run standalone
pnpm run demo -- --fixture agent-matrix --speed 8
```

## 2. Captured Real-Agent Fixtures

Real captures are used to detect drift in agent telemetry schemas.

Claude Code and Codex can be captured through the standalone server:

```sh
pnpm run standalone
pnpm run capture -- claude-task-api --duration 180 --clear
```

The agent should be run in a separate terminal with a fixed prompt. Capture must be started before the prompt is submitted.

Capture procedure:

1. Stop any VS Code TraceRoost collector or standalone server already using the OTLP port.
2. Start `pnpm run standalone` and wait for `OTLP receiver -> http://127.0.0.1:4318`.
3. Restart the agent terminal after standalone configures OTEL. Existing Claude/Codex processes keep their old telemetry settings.
4. Start `pnpm run capture -- <fixture-name> --duration 180 --clear`.
5. Send one prompt to the agent.
6. Confirm the standalone terminal prints `[OTLP] ... ingested` lines. If it does not, the agent is not sending to this collector/port.
7. Press `s` in the capture terminal to save and exit early, or wait for `--duration`.

Each agent/scenario pair should produce one clean fixture. For Codex captures, the `[otel]` configuration must include `log_user_prompt`, `exporter`, and `trace_exporter`.

Copilot telemetry flows through the VS Code extension rather than the standalone collector. Copilot captures require running the extension, performing the scenario in VS Code, and exporting via the dashboard **Export** tab (or the `TraceRoost: Export OTEL Data` command). A small redacted Copilot export should be retained as a manual regression fixture or converted to the fixture span format.

## 3. Application-Build Simulations

Application-build simulations should use small disposable applications. These scenarios allow agents to perform realistic work without affecting production code. Prompts should remain stable across repeated runs.

Recommended scenario matrix:

| Scenario | Purpose |
| --- | --- |
| Build a tiny CRUD API with tests | Normal multi-step app creation |
| Add validation to a form | Frontend edit and file tracking |
| Fix a seeded failing test | Error recovery and repeated command behavior |
| Search for a lifecycle call such as `dispose()` | Codex trace/log joining and tool result output |
| Refactor a module across files | File read/write attribution |
| Force a repeated failing command in a sandbox repo | Loop and malfunction detection |
| Large codebase-wide TODO audit | Token growth and compaction signals |

Each run should preserve:

- Raw fixture JSON.
- Summary validation output.
- Agent version/model and configuration.
- The exact prompt.
- Any redaction notes.

The purpose of this strategy is not to benchmark agent quality. The purpose is to preserve telemetry contracts so TraceRoost continues to group traces, span waterfalls, summaries, tokens, files, and loop signals correctly as agent telemetry evolves.
