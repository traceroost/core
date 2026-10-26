Start an agent run to begin receiving live OTel telemetry:

**Claude Code** — open a terminal and run:

```bash
claude
```

**GitHub Copilot** — ask a question in the Copilot Chat panel.

**Codex CLI** — open a terminal and run:

```bash
codex
```

**OpenCode** and **Cursor CLI** need no setup: their runs appear from local history (Log badge), without live telemetry.

The sidebar updates in real time as spans arrive. Each trace is one prompt-to-response cycle: a user prompt plus every LLM call and tool invocation the agent made.

Past traces are also already shown — loaded from local log files on startup as a fallback.

## Understanding the badges

Every trace row shows a source badge:

- **OTel** — full telemetry: real-time timing, loop detection, file diffs, streaming speed
- **Log** — log file fallback: token counts, tool calls, prompts where available; no timing data

When TraceRoost can match OTel data to a trace already shown as **Log** (always for Claude Code), the richer OTel entry replaces it.
