TraceRoost ran a built-in OTEL receiver and wrote telemetry config for each agent it detected:

## OpenTelemetry (primary — real-time, richest data)

| Agent | Config written |
| --- | --- |
| **Claude Code** | `~/.claude/settings.json` |
| **GitHub Copilot** | VS Code user settings |
| **Codex CLI** | `~/.codex/config.toml` |

OTEL gives you real-time span timing, time-to-first-token, loop detection, file diffs, and streaming speed. Sessions from OTEL show an **OTEL** badge.

> **Restart any running agent sessions** to pick up the OTEL config. No external infrastructure is required — everything stays on-device.

## Log files (fallback — history, no extra setup)

TraceRoost also loaded session history from local log files each agent writes automatically:

| Agent | What was loaded |
| --- | --- |
| **Claude Code** | `~/.claude/projects/` — conversation history, token counts, tool calls |
| **Copilot CLI** | `~/.copilot/session-state/` — sessions, token counts, prompts |
| **Codex CLI** | `~/.codex/sessions/` — sessions and token counts |
| **OpenCode** | `~/.local/share/opencode/opencode.db` — sessions, token counts, tool calls, file paths, user prompts. No OTEL config needed. |

Sessions from log files show a **Log** badge. When OTEL data arrives for the same session, the badge automatically upgrades to **OTEL** and the richer data replaces the log entry.
