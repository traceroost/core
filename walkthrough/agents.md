TraceRoost runs a built-in OTel receiver. It asks before it changes any agent's settings — **Not now** asks again next time, **Don't set up** stops asking. When you choose **Set up agents** — in that question, or later with the **TraceRoost: Set Up Agents…** command — it writes telemetry config for each agent it detects:

## OpenTelemetry (primary — real-time, richest data)

| Agent | Config written |
| --- | --- |
| **Claude Code** | `~/.claude/settings.json` |
| **GitHub Copilot** | VS Code user settings |
| **Codex CLI** | `~/.codex/config.toml` |

OTel gives you real-time span timing, time-to-first-token, loop detection, file diffs, and streaming speed. Traces from OTel show an **OTel** badge.

> **Restart any running agents** to pick up the OTel config. Chose **Don't set up**, or turned auto-configuration off? Run **TraceRoost: Set Up Agents…** from the Command Palette ([run it now](command:traceRoost.setUpAgents)), or set it up by hand (dashboard Help tab → Setup). **TraceRoost: Remove Agent Setup…** takes out only what TraceRoost added. No external infrastructure is required — everything stays on-device.

## Log files (fallback — history, no extra setup)

TraceRoost also loads trace history from local log files each agent writes automatically:

| Agent | What is loaded |
| --- | --- |
| **Claude Code** | `~/.claude/projects/` — conversation history, token counts, tool calls |
| **Copilot CLI** | `~/.copilot/session-state/` — runs, token counts, prompts |
| **Codex CLI** | `~/.codex/sessions/` — runs and token counts |
| **Copilot Chat** | each VS Code-family IDE's `workspaceStorage/…/chatSessions/` — prompts, model, output tokens |
| **OpenCode** | `~/.local/share/opencode/opencode.db` — runs, token counts, tool calls, file paths, user prompts. No OTel config needed. |
| **Cursor CLI** | `~/.cursor/projects/…/agent-transcripts/` — prompts and tool calls (Cursor records no token counts). No OTel config needed. |

Traces from log files show a **Log** badge. When TraceRoost can match a log trace to OTel data for the same trace (always for Claude Code), the OTel entry wins and replaces it.
