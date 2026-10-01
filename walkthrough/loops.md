The **Traces** tab continuously scans your traces for seventeen stuck-agent and waste signals — the five most common are below (the Help tab's Signals section lists them all). Expand any trace and open the **Overview** sub-tab to see Insights:

| Signal | What it detects |
| --- | --- |
| **Tool Call Deadlock** | Same tool + arguments called 30+ times in a row — agent not retaining results |
| **State Corruption Spiral** | File edited then reverted — agent oscillating between conflicting states |
| **Hallucination Amplification Loop** | Same error recurring 3+ times — fix attempts not resolving root cause |
| **Ambiguous Success / Escalating Scope** | Too many steps for task complexity — unclear success criteria |
| **Infinite Loop — Context Accumulation** | Input tokens growing while output collapses — agent stuck |

Each detected signal shows the evidence and concrete examples (tool names, file paths, error messages). Use the **Copy** button to copy the recommended prompt to your clipboard, then paste it into your agent. Use **Ignore** to dismiss a signal that represents intentional behavior.

Open the gear-icon **Settings** panel's Alerts section to configure proactive notifications when traces exceed thresholds for context window usage, turn count, error rate, active time, tool repetition, cache utilization, plan-limit windows, or daily cost.
