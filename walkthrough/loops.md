The **Traces** tab continuously scans your traces for sixteen stuck-agent and waste signals — the five most common are below (the Help tab's Signals section lists them all). Expand any trace and open the **Overview** sub-tab to see Insights:

| Signal | What it detects |
| --- | --- |
| **Tool Call Deadlock** | The same tool call (same arguments) ran 30+ times with no file edit in between — the agent isn't using what it already got back |
| **Edit Reverted** | A file's edit exactly undone by a later edit — often two requirements in conflict |
| **Repeated Error** | The same error 3+ times — fix attempts not reaching the cause |
| **Ambiguous Success / Escalating Scope** | Too many steps for task complexity — unclear success criteria |
| **Context Runaway** | Input growing 15,000+ tokens while output collapses — no forward progress |

Each detected signal shows the evidence and concrete examples (tool names, file paths, error messages), the action for you, and a one-line instruction written for the agent. **Copy** puts that instruction on the clipboard with the evidence under it — paste it into the running agent. Use **Ignore** to dismiss a signal that represents intentional behavior; the Help tab's Signals section says how well each threshold has been checked against real traces.

Open the **Alerts** panel (bell icon) and its **Configure** tab to set proactive notifications when traces exceed thresholds for context window usage, turn count, error rate, active time, tool repetition, cache utilization, plan-limit windows, or daily cost.
