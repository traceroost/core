TraceRoost gives you local observability into your AI agent traces — see what GitHub Copilot, Claude Code, and Codex are doing, how efficiently, and when they get stuck. No data leaves your machine.

## Two data sources, one dashboard

**OpenTelemetry traces (primary)** — the extension runs a built-in OTEL receiver and auto-configures each agent to stream live telemetry. OTEL is the richest source: real-time span timing, time-to-first-token, loop detection, file diffs, and streaming speed. Traces show an **OTEL** badge.

**Local log files (fallback)** — the extension also reads log files each agent writes automatically to your home directory, including OpenCode's local SQLite database. No setup required — trace history appears immediately. Traces show a **Log** badge and are automatically upgraded to OTEL when live telemetry arrives for the same trace.

## What you can see

- **Token usage** per trace, turn, and tool call
- **Latency breakdown** across LLM calls, tool executions, and I/O (OTEL)
- **Files changed** with before/after diffs (OTEL)
- **Loop and malfunction detection** — tool deadlocks, error spirals, context accumulation (OTEL)
- **Efficiency recommendations** with one-click actions
- **Cost estimates** per trace and per day

Click **TraceRoost** in the Activity Bar (the icon on the left) to open the sidebar panel.
