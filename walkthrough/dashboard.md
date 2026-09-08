The sidebar gives you a compact live view. For the full experience, open the **editor panel dashboard** — a 5-tab interface, plus a Help icon and a gear-icon Settings panel, that you can open alongside your code.

## Dashboard tabs

| Tab | What it shows |
| --- | --- |
| **Traces** | Trace list as a sortable table — timestamp, prompt, model, tokens, duration, and estimated cost per row. Sort by Cost, Duration, or Tokens using the pills in the filter bar. Click any row to expand in-place and drill into five sub-tabs: Overview (stat tiles, burn rate, and Insights), Trace (LLM and tool call waterfall), Flow (turn-to-tool graph), Tools (donut chart), and Files (modified files with inline diffs, a one-shot/retry-rate summary, and a git-outcome banner showing whether each file's changes were committed, reverted, or left uncommitted) |
| **Analytics** | Aggregate charts across all traces: per-agent breakdown (token totals, cache rates, one-shot rate, top tools), Estimated Cost (bar chart + daily total line, day-grouped cost table, model breakdown), Token Usage Per Trace, and Context Growth |
| **Advisor** | Project-scoped suggestions for improving your agent instruction file — detects hot files the agent rediscovers each trace, behavioral loop patterns, high turn counts, and open-ended prompt habits. Each suggestion includes ready-to-copy instruction text and an inquiry prompt to paste directly into your agent. Also includes an efficiency scatter plot and hot files table. Select a project from the workspace filter for tailored suggestions. |
| **Export** | Export recorded traces — full (includes prompt text) or redacted — as JSON, CSV, or Markdown, from the full SQLite trace history |
| **Import** | Preview and import traces from a previously exported TraceRoost JSON file |
| **Help** | Overview, setup instructions, agent OTEL data shapes, Insights reference, loop signal documentation, and glossary |

Two icons in the top-right of the tab bar handle alerting and configuration without cluttering the tabs themselves:

- **Bell icon** — shows a badge when an alert threshold is currently triggered; click it for a status card with severity and detail per alert.
- **Gear icon** — opens a slide-in Settings panel with two collapsible sections: **Alerts** (configurable thresholds — context window size, turn count, error spike, active trace time, cache utilization, identical tool repeats, and daily cost across all agents) and **Automation** (automated prompts triggered when thresholds are crossed — Loop Breaker, Turn Limit Wrap-up, and Context Dump). Also holds the OTEL/log ingestion toggles.

Use the **time range**, **agent filter**, and **text search** controls at the top to focus on what matters.
