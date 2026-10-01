TraceRoost ran a built-in OTEL receiver and wrote telemetry config for each agent it detected:

## OpenTelemetry (primary — real-time, richest data)

| Agent | Config written |
| --- | --- |
| **Claude Code** | `~/.claude/settings.json` |
| **GitHub Copilot** | VS Code user settings |
| **Codex CLI** | `~/.codex/config.toml` |

OTEL gives you real-time span timing, time-to-first-token, loop detection, file diffs, and streaming speed. Traces from OTEL show an **OTEL** badge.

> **Restart any running agent sessions** to pick up the OTEL config. No external infrastructure is required — everything stays on-device.

## Log files (fallback — history, no extra setup)

TraceRoost also loaded trace history from local log files each agent writes automatically:

| Agent | What was loaded |
| --- | --- |
| **Claude Code** | `~/.claude/projects/` — conversation history, token counts, tool calls |
| **Copilot CLI** | `~/.copilot/session-state/` — sessions, token counts, prompts |
| **Codex CLI** | `~/.codex/sessions/` — sessions and token counts |
| **Copilot Chat** | each VS Code-family IDE's `workspaceStorage/…/chatSessions/` — prompts, model, output tokens |
| **OpenCode** | `~/.local/share/opencode/opencode.db` — sessions, token counts, tool calls, file paths, user prompts. No OTEL config needed. |
| **Cursor CLI** | `~/.cursor/projects/…/agent-transcripts/` — prompts and tool calls (Cursor records no token counts). No OTEL config needed. |

Traces from log files show a **Log** badge. When TraceRoost can match a log trace to OTEL data for the same trace (always for Claude Code), the OTEL entry wins and replaces it.
