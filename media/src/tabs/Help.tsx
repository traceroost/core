import { useEffect, useState } from 'preact/hooks'
import { BrandMark } from '../BrandMark'

// ── Data ──────────────────────────────────────────────────────────────────────

const TERMS: [string, string][] = [
  ['Agent Loop / Malfunction', 'A behavioral pattern in which an AI agent is stuck, oscillating, or spiraling into unproductive work. TraceRoost detects five patterns: Tool Call Deadlock, State Corruption Spiral, Hallucination Amplification Loop, Ambiguous Success / Escalating Scope, and Infinite Loop — Context Accumulation.'],
  ['Agent',                  'The AI coding assistant (e.g. GitHub Copilot, Claude Code, Codex) that receives your prompt, reasons about the task, and decides which tools to use. It manages the workflow, breaks down tasks, and may call the underlying LLM multiple times per trace to complete a single request. The agent is the orchestrator; the LLM is the engine it drives.'],
  ['Avg Input/Call',         'Average number of input tokens sent to the language model per LLM call. Lower means leaner prompts. Under 10K is lean; 10-30K is normal; 30K+ suggests large instruction files, verbose tool definitions, or accumulated context bloat.'],
  ['Avg Turns/Trace',        'Average number of LLM round-trips per trace. Lower is more efficient. 1-3 turns is typical for simple tasks; 5+ may indicate the agent is struggling or the prompt needs more specifics.'],
  ['Background Span',        'A span that runs outside the main request/response cycle — e.g., telemetry uploads, extension lifecycle events, or periodic health checks.'],
  ['Cache Create Tokens',    'Tokens written into the prompt cache on the server during this request. These tokens become available for cache hits on subsequent requests.'],
  ['Cache Hit Rate',         'The percentage of input tokens served from a server-side prompt cache instead of being reprocessed. Higher rates reduce latency and cost.'],
  ['Cache Read Tokens',      'Input tokens served from the server-side prompt cache, avoiding reprocessing. Shown in efficiency metrics.'],
  ['Context',                'The content sent to the model on a given LLM call: system instructions, conversation history, tool definitions, and the current prompt. Must fit within the context window. Every token costs money — agents that read large files or accumulate long conversation histories use more context per call, driving up cost.'],
  ['Context Bloat',          'An efficiency insight triggered when input tokens grow significantly across turns within a trace.'],
  ['Context Window',         'The maximum number of tokens an LLM can process in a single request, counting both input and output tokens combined. For example, Claude Sonnet has a 200K token context window. This is a hard per-call limit set by the model architecture — not the same as context, which is what actually fills that window on a given call.'],
  ['Conversation',           'The real, continuous back-and-forth a user had with an agent, which may contain several Traces. Claude Code, Codex, and Copilot Chat (VS Code) each write one log file per working period on disk, but a single file can span multiple genuinely separate conversations if a long idle gap (30+ minutes) separates them; TraceRoost splits that file into one trace per conversation rather than one entry with a misleading multi-hour (or multi-day) duration. Traces split from the same file are marked with a matching colored bar in the Traces tab — click it to isolate just that conversation. Only Claude Code, Codex, and Copilot Chat (VS Code) can produce a multi-trace conversation; Copilot CLI and legacy imported traces are always exactly one trace.'],
  ['Files Changed',          'Unique files that were created or modified by the agent during the current data collection period.'],
  ['Git Outcome',            'Compares each file a trace changed against local git history to classify what happened to the work afterward: Committed (survived and is in a commit), Reverted (back to its pre-trace content), Uncommitted (still sitting in the working tree), or Unknown. Computed on demand when a trace\'s Files sub-tab is opened. Needs direct access to the local git repo, so it works in both the VS Code extension and standalone (native process) mode — not available in Docker mode.'],
  ['Input Tokens',           'The number of tokens sent to the language model in a request, including system instructions, conversation history, tool definitions, and the user prompt. In the Traces list, the Tokens column shows total input across all turns — because each turn re-sends the full conversation history, this grows with trace length. Use Peak ctx/turn (visible in the trace detail) to see the actual context window size per call.'],
  ['Loop Signal',            'A behavioral signal in the Insights panel (inside the Overview sub-tab of each trace) indicating the agent is stuck, oscillating, or making no forward progress. Shown with a ↺ icon.'],
  ['LLM',                    'Large Language Model. The underlying AI model (e.g. GPT-4o, Claude Sonnet) that generates text, answers questions, or produces code. The agent sends requests to the LLM as needed; the model itself does not manage tools or workflow. It is the engine that generates language and code for the agent to act on.'],
  ['LLM Call',               'A single request-response cycle to the language model. One trace typically includes multiple LLM calls as the agent iterates.'],
  ['One-Shot Rate',          'The percentage of files edited during a trace that needed only one edit pass to reach their final state, versus files that needed retries (2+ edit passes). A proxy for correction effort, not a signal that the resulting code actually worked. Needs at least 2 edited files to show a rate; shown in the Traces tab\'s Files sub-tab and aggregated per-agent in Analytics.'],
  ['OTLP',                   'OpenTelemetry Protocol — the standard format used to collect and transmit telemetry from AI agents to this extension. TraceRoost accepts trace spans and log-derived events.'],
  ['Outcome',                'How a trace concluded: "text" means the agent responded with a text answer; "tool" means the last action was a tool call.'],
  ['Output Tokens',          'The number of tokens generated by the language model in its response, including reasoning, tool call instructions, and final answers.'],
  ['Output Ratio',           'Percentage of total tokens that are output (generated by the model). In cached agentic coding traces this can be naturally tiny, so TraceRoost no longer uses it as a standalone alert.'],
  ['Prompt',                 'The text you type into the AI chat to request work. Each prompt initiates a new trace.'],
  ['Request',                'The user-visible message sent to the agent in a single prompt. In OTEL terms, the request anchor differs by agent: Copilot uses invoke_agent, Claude uses claude_code.interaction, and Codex is normalized from prompt log events.'],
  ['Span',                   'A single timed operation recorded by OpenTelemetry — an LLM call, a tool call, a background task. TraceRoost displays true trace spans and normalized log events with a span-like name, duration, and attributes. Spans are the rows in a Trace\'s Waterfall.'],
  ['Span ID',                'A unique identifier for a single span within a trace. Used to establish parent-child relationships between operations.'],
  ['Sparkline',              'A small inline chart shown below summary cards, depicting the trend of a metric over recent time buckets.'],
  ['Tokens',                 'The fundamental unit language models use to process text. Roughly 1 token ≈ 4 characters or ¾ of a word.'],
  ['Tool Call',              'A single invocation of a tool by the agent — e.g., reading a file, running a search, or executing a terminal command.'],
  ['Tool Definition Overhead', 'An efficiency insight triggered when a large fraction of input tokens is consumed by tool definition schemas rather than actual content.'],
  ['Trace',                  'One prompt-to-response cycle — the unit shown as a row in the Traces tab. Starts when you send a prompt and ends when the agent delivers its final response, and includes every LLM call, tool call, and file change in between. In OpenTelemetry terms a trace is the spans sharing one Trace ID; TraceRoost normalizes the different Copilot, Claude, and Codex OTEL shapes (and log-only sources, which have no real trace) into this one model. One on-disk log file can produce more than one trace if a long idle gap separates two real conversations within it — see Conversation.'],
  ['Trace ID',               'The OpenTelemetry identifier that links all spans belonging to one trace. Present on OTEL-sourced traces; log-only traces are reconstructed without one.'],
  ['Turn',                   'One LLM call within a trace. A multi-turn trace involves the agent calling the LLM, executing tools, then calling the LLM again.'],
  ['TTFT',                   'Time to First Token — the latency between sending a prompt and receiving the first token of the response.'],
  ['Waterfall',              'The span visualization inside a Trace: every LLM call and tool call as a horizontal bar on a time axis, with nesting depth shown by indentation. Expand a bar for its arguments, results, tokens, and cost. It is the Waterfall sub-tab of an expanded trace row.'],
]

const HELP_SECTIONS = {
  overview:   { href: '#help-overview',   heading: 'Overview' },
  config:     { href: '#help-config',     heading: 'Setup' },
  otel:       { href: '#help-otel',       heading: 'OTEL Data' },
  traces:     { href: '#help-traces',    heading: 'Traces' },
  analytics:  { href: '#help-analytics',  heading: 'Analytics' },
  patterns:   { href: '#help-advisor',    heading: 'Advisor' },
  costs:      { href: '#help-costs',      heading: 'Costs' },
  settings:   { href: '#help-settings',   heading: 'Settings' },
  mcp:        { href: '#help-mcp',        heading: 'MCP' },
  export:     { href: '#help-export',     heading: 'Export' },
  import:     { href: '#help-import',     heading: 'Import' },
  badges:     { href: '#help-badges',     heading: 'Badges' },
  glossary:   { href: '#help-glossary',   heading: 'Glossary' },
} as const

const TOC_SECTIONS = Object.values(HELP_SECTIONS)

const AGENT_OTEL_SHAPES: Array<{
  agent: string
  format: string
  coverage: string
  gaps: string
}> = [
  {
    agent: 'Copilot',
    format: 'OpenTelemetry <a href="#gl-trace">trace</a> <a href="#gl-span">spans</a> with a clean single-trace hierarchy. Each conversation is one trace; <a href="#gl-llm-call">LLM calls</a> and tool calls are child spans nested under a session root. No extra configuration needed.',
    coverage: 'Prompt text, token counts (<a href="#gl-input-tokens">input</a>, <a href="#gl-output-tokens">output</a>, <a href="#gl-cache-read-tokens">cache read</a>), model name, <a href="#gl-ttft">TTFT</a>, tool names, tool arguments, tool results, and file paths are all present natively without any extra configuration.',
    gaps: 'Cache <em>write</em> token counts are not available — Copilot manages cache creation server-side and does not expose it in telemetry. Cache <em>read</em> tokens are available. No additional configuration unlocks further data — what Copilot exposes is already fully available.',
  },
  {
    agent: 'Claude Code',
    format: 'OpenTelemetry trace spans. The session root span closes when the interaction ends, with LLM calls and tool calls as children. Optional supplemental log records are emitted when enhanced telemetry env vars are set.',
    coverage: 'With the recommended configuration (all three OTEL_LOG_* vars set): prompt text, token counts, model, tool names, tool arguments, file paths, and full file diff content are all available.',
    gaps: 'The three OTEL_LOG_* env vars are not enabled by default — without them, tool arguments are absent, prompt text is omitted, and file diff content is unavailable. Cache token data is only present when using a model that supports prompt caching.',
  },
  {
    agent: 'Codex',
    format: 'Primarily flat OTLP log records (structured JSON events sent to /v1/logs), not trace spans. Each session is a stream of log events grouped by conversation and turn identifiers. Adding trace_exporter to ~/.codex/config.toml also emits timing spans to /v1/traces. Both the CLI and the VS Code extension read the same config file.',
    coverage: 'With the recommended configuration (log_user_prompt = true and both exporters set): prompt text, token counts, model name, TTFT, tool names, tool arguments, tool results, and span timing are all present.',
    gaps: 'The Traces timeline has less span granularity than Copilot or Claude Code since Codex is primarily log-based. Without trace_exporter, timing data is limited.',
  },
]

// ── Reusable styles ───────────────────────────────────────────────────────────

const codeStyle = 'font-size:11px;background:var(--panel-bg);padding:1px 4px;border-radius:3px'
const preStyle = 'background:var(--panel-bg);border:1px solid var(--border);border-radius:5px;padding:10px 14px;font-size:11.5px;line-height:1.6;overflow-x:auto;white-space:pre'
const h4Style = 'font-size:13px;font-weight:600;margin:0 0 6px;color:var(--fg,inherit)'
const mutedP = 'font-size:12px;color:var(--muted);margin:0 0 8px'
const subHeadStyle = 'font-size:13px;font-weight:600;margin:20px 0 8px;padding-bottom:5px;border-bottom:1px solid var(--border);color:var(--fg)'

// ── Sub-components ────────────────────────────────────────────────────────────

function InsightBlock({ id, title, why, steps, impact }: {
  id: string; title: string; why: string; steps: string; impact: string
}) {
  return (
    <div class="glossary-item" id={id} style="scroll-margin-top:12px;flex-direction:column;gap:0">
      <dt class="glossary-term" style="margin-bottom:6px">{title}</dt>
      <dd class="glossary-def" style="display:block">
        <p style="margin:0 0 8px"><strong style="color:var(--fg)">Why it happens: </strong><span dangerouslySetInnerHTML={{ __html: why }} /></p>
        <p style="margin:0 0 4px"><strong style="color:var(--fg)">How to fix:</strong></p>
        <ol style="margin:0 0 8px;padding-left:20px;font-size:12px;line-height:1.7" dangerouslySetInnerHTML={{ __html: steps }} />
        <p style="margin:0;font-size:11px;color:var(--muted)"><strong style="color:var(--fg);font-size:11px">Expected impact: </strong><span dangerouslySetInnerHTML={{ __html: impact }} /></p>
      </dd>
    </div>
  )
}

function LoopBlock({ id, title, why, example, steps, impact }: {
  id: string; title: string; why: string; example: string; steps: string; impact: string
}) {
  return (
    <div class="glossary-item" id={id} style="scroll-margin-top:12px;flex-direction:column;gap:6px">
      <div style="display:flex;gap:12px;align-items:flex-start">
        <dt class="glossary-term" style="min-width:200px">
          {title}
        </dt>
        <dd class="glossary-def" dangerouslySetInnerHTML={{ __html: why }} />
      </div>
      <div style="padding-left:8px;font-size:11px;color:var(--muted);line-height:1.5"><strong style="color:var(--fg)">Example: </strong><span dangerouslySetInnerHTML={{ __html: example }} /></div>
      <div style="padding-left:8px;font-size:11px;line-height:1.6">
        <p style="margin:0 0 3px"><strong style="color:var(--fg);font-size:11px">How to fix:</strong></p>
        <ol style="margin:0 0 6px;padding-left:18px;font-size:11px;line-height:1.7;color:var(--muted)" dangerouslySetInnerHTML={{ __html: steps }} />
        <p style="margin:0;font-size:10px;color:var(--muted)"><strong style="color:var(--fg);font-size:10px">Expected impact: </strong><span dangerouslySetInnerHTML={{ __html: impact }} /></p>
      </div>
    </div>
  )
}

// ── Section components ────────────────────────────────────────────────────────

function Toc() {
  const [activeHref, setActiveHref] = useState<string>(TOC_SECTIONS[0]?.href ?? '')

  // Highlight whichever section is nearest the top of the viewport as the page scrolls,
  // so the sidebar always shows roughly where you are — standard for a docs-style left rail.
  useEffect(() => {
    const targets = TOC_SECTIONS
      .map(s => document.querySelector(s.href))
      .filter((el): el is Element => el !== null)
    if (targets.length === 0) return
    const observer = new IntersectionObserver(
      entries => {
        const visible = entries.filter(e => e.isIntersecting)
        if (visible.length === 0) return
        const topMost = visible.reduce((a, b) => (a.boundingClientRect.top <= b.boundingClientRect.top ? a : b))
        setActiveHref('#' + topMost.target.id)
      },
      { rootMargin: '-44px 0px -70% 0px', threshold: 0 }
    )
    targets.forEach(el => observer.observe(el))
    return () => observer.disconnect()
  }, [])

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: 'html,body{scroll-behavior:smooth}.help-section{scroll-margin-top:44px}.glossary-item[id]{scroll-margin-top:44px}.help-toc{position:sticky;top:44px;flex:0 0 116px;display:flex;flex-direction:column;gap:1px;max-height:calc(100vh - 60px);overflow-y:auto}.help-toc a{display:block;padding:4px 8px;border-radius:4px;font-size:12px;font-weight:500;color:var(--muted);text-decoration:none;line-height:1.4;border-left:2px solid transparent;transition:color .1s,background .1s}.help-toc a:hover{color:var(--fg);background:var(--hover)}.help-toc a.active{color:var(--fg);background:var(--hover);border-left-color:var(--accent);font-weight:600}' }} />
      <nav class="help-toc" aria-label="Help sections">
        {TOC_SECTIONS.map(s => (
          <a href={s.href} class={s.href === activeHref ? 'active' : undefined}>{s.heading}</a>
        ))}
      </nav>
    </>
  )
}

function OverviewSection() {
  return (
    <div class="help-section" id="help-overview">
      <div style={{ textAlign: 'center', marginBottom: 16, color: 'var(--fg)' }}>
        <BrandMark size={132} style={{ display: 'block', margin: '0 auto' }} />
        <p style={{ textAlign: 'center', fontStyle: 'italic', color: 'var(--muted)', marginTop: 8, marginBottom: 0 }}>A high perch over every agent run.</p>
      </div>
      <div style="margin:0 0 16px;background:var(--hover);border:1px solid var(--border);border-left:4px solid var(--warning,#ffb74d);border-radius:6px;padding:12px 16px">
        <p style="font-size:13px;font-weight:700;margin:0 0 8px;color:var(--foreground)">Important: OTEL captures richer data than log-only history</p>
        <p style="font-size:13px;color:var(--muted);margin:0 0 10px;line-height:1.75">OpenTelemetry capture is live collection. TraceRoost must be running while your agent session runs to collect full OTEL spans, timing, tool payloads, and richer turn-level context. If TraceRoost was not running (or OTEL was not configured yet), TraceRoost can still backfill from local logs/databases, but those sessions are less detailed.</p>
        <ul style="margin:0 0 10px 18px;padding:0;font-size:12px;color:var(--muted);line-height:1.75">
          <li>
            <span style="font-size:9px;font-weight:600;padding:1px 5px;border-radius:2px;border:1px solid #90a4ae;letter-spacing:0.03em;vertical-align:middle;display:inline-block;margin-right:6px;color:#90a4ae">Log</span>
            sessions can have missing or reduced detail in Trace, Flow, Tools, and Files.
          </li>
          <li>
            <span style="font-size:9px;font-weight:600;padding:1px 5px;border-radius:2px;border:1px solid #ffffff;letter-spacing:0.03em;vertical-align:middle;display:inline-block;margin-right:6px;color:#ffffff">OTEL</span>
            sessions usually include fuller timing structure and richer event detail.
          </li>
        </ul>
        <p style="font-size:12px;color:var(--muted);margin:0 0 8px;line-height:1.75"><strong style="color:var(--fg)">How to get richer data with OTEL:</strong></p>
        <ul style="margin:0 0 0 18px;padding:0;font-size:12px;color:var(--muted);line-height:1.75">
          <li>Complete <a href="#help-config">Setup</a> and restart each agent.</li>
          <li>This improves future sessions only; it cannot retroactively add OTEL detail to already-finished log-only sessions.</li>
        </ul>
      </div>
      <h3 class="help-heading">{HELP_SECTIONS.overview.heading}</h3>
      <div class="help-overview-body">
        <p><strong>TraceRoost</strong> is a local observability tool that makes AI <a href="#gl-agent">agent</a> sessions more transparent — see what's happening inside each run. Available as a VS Code-family IDE extension (VS Code, Cursor, Windsurf, VSCodium, Trae, Kiro), a local web app (npx), or Docker, with no data leaving your machine. It captures <a href="#gl-otlp">OpenTelemetry</a> <a href="#gl-trace">traces</a> from GitHub Copilot, Claude Code, and Codex, and also reads <strong>local session files and databases</strong> written automatically by each agent as a zero-config fallback — including OpenCode's local SQLite database — so history loads even without OTEL configured. Both sources feed one unified dashboard and surface efficiency metrics, session cost estimates, human-readable summaries, and actionable insights in real time.</p>
        <p style="font-size:13px;margin:10px 0 4px"><strong>TraceRoost detects eight loop / malfunction patterns</strong> — each with a ready-to-paste correction prompt (see <a href="#help-loops">Loop Detection</a> below for details):</p>
        <ul style="margin:0 0 0 18px;padding:0;font-size:13px;color:var(--muted);line-height:1.75">
          <li><a href="#help-tool-deadlock">Tool Call Deadlock</a> — the same tool call repeated 5+ times</li>
          <li><a href="#help-state-spiral">State Corruption Spiral</a> — a file edited then reverted, oscillating</li>
          <li><a href="#help-hallucination">Hallucination Amplification Loop</a> — the same error recurring 3+ times</li>
          <li><a href="#help-runaway-steps">Ambiguous Success / Escalating Scope</a> — runaway step count, no stopping condition</li>
          <li><a href="#help-context-accumulation">Infinite Loop — Context Accumulation</a> — input tokens growing while output collapses</li>
          <li><a href="#help-chronic-tool-unreliability">Chronic Tool Unreliability</a> — an unusually high share of tool calls failing</li>
          <li><a href="#help-context-flooding-risk">Context Flooding Risk</a> — a tool result too large for the model to use well</li>
          <li><a href="#help-malformed-tool-call">Malformed Tool Call</a> — the agent's own harness rejected a call before it ran</li>
        </ul>
      </div>
    </div>
  )
}

function ConfigSection() {
  const standalone = window.__STANDALONE__ === true
  const kbdStyle = 'font-size:11px;background:var(--panel-bg);padding:1px 5px;border-radius:3px;border:1px solid var(--border)'
  const pathNote = (mac: string, win: string) => (
    <p style="font-size:11px;color:var(--muted);margin:0 0 6px">
      macOS/Linux: <code style={codeStyle}>{mac}</code> &nbsp;·&nbsp; Windows: <code style={codeStyle}>{win}</code>
    </p>
  )

  const callout = standalone ? (
    <div style="margin-bottom:20px;background:var(--hover);border:1px solid var(--border);border-left:3px solid var(--warning,#ffb74d);border-radius:4px;padding:10px 14px">
      <p style="font-size:12px;font-weight:600;margin:0 0 8px;color:var(--foreground)">Not seeing any detailed OTEL data?</p>
      <p style="font-size:12px;color:var(--muted);margin:0 0 6px">TraceRoost attempts to configure OTEL automatically when the standalone server starts. The VS Code-family extension does the same when it activates.</p>
      <p style="font-size:12px;color:var(--muted);margin:0 0 6px">Configuration is read at startup — restart each <a href="#gl-agent">agent</a> after making changes:</p>
      <table style="font-size:12px;border-collapse:collapse;width:100%">
        <tbody style="color:var(--muted)">
          <tr style="border-bottom:1px solid var(--border)">
            <td style="padding:4px 12px 4px 0;white-space:nowrap;vertical-align:top;color:var(--foreground)">Claude Code</td>
            <td style="padding:4px 0;vertical-align:top">Exit any running <code style={codeStyle}>claude</code> session and start a new one.</td>
          </tr>
          <tr style="border-bottom:1px solid var(--border)">
            <td style="padding:4px 12px 4px 0;white-space:nowrap;vertical-align:top;color:var(--foreground)">Codex</td>
            <td style="padding:4px 0;vertical-align:top">In Codex, type <code style={codeStyle}>/exit</code> (or press <kbd style={kbdStyle}>Ctrl+C</kbd>), close the terminal tab/window, open a new terminal, and run <code style={codeStyle}>codex</code> again. If Codex is running inside an IDE, reload the IDE window too.</td>
          </tr>
          <tr>
            <td style="padding:4px 12px 4px 0;white-space:nowrap;vertical-align:top;color:var(--foreground)">Copilot CLI</td>
            <td style="padding:4px 0;vertical-align:top">Open a new terminal (or restart your shell) to pick up the env vars, then run <code style={codeStyle}>copilot</code>.</td>
          </tr>
        </tbody>
      </table>
      <p style="font-size:12px;color:var(--muted);margin:8px 0 0">Start a short <a href="#gl-trace">trace</a> and check whether a session card appears in the sidebar to confirm data is arriving.</p>
      <p style="font-size:12px;color:var(--muted);margin:8px 0 6px">If configuration is missing or stale, use <strong>Configure OTEL</strong> in Settings, or review the <a href="https://github.com/traceroost/core/tree/main/scripts" target="_blank" rel="noreferrer">configuration scripts in the repository</a>.</p>
      <pre style="font-size:12px;background:var(--panel-bg);border:1px solid var(--border);border-radius:3px;padding:6px 10px;margin:0 0 8px;overflow-x:auto;white-space:pre">{`# macOS / Linux — make executable (once), then run:
chmod +x scripts/configure-agents.sh
./scripts/configure-agents.sh             # all agents
./scripts/configure-agents.sh --agent claude
./scripts/configure-agents.sh --agent codex
./scripts/configure-agents.sh --agent copilot

# Windows (PowerShell) — if blocked, allow scripts first (once):
# Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
.\\scripts\\configure-agents.ps1
.\\scripts\\configure-agents.ps1 -Agent claude
.\\scripts\\configure-agents.ps1 -Agent codex
.\\scripts\\configure-agents.ps1 -Agent copilot`}</pre>
      <p style="font-size:12px;color:var(--muted);margin:0 0 0">Prefer not to run the script? Use <strong>Configure OTEL</strong> in Settings to re-apply it manually. Check the server terminal or TraceRoost Output channel for configuration messages. If the server itself isn't running, data has nowhere to go — see <a href="#help-config">Run as a Background Service</a> below to keep it running automatically.</p>
    </div>
  ) : (
    <div style="margin-bottom:20px;background:var(--hover);border:1px solid var(--border);border-left:3px solid var(--warning,#ffb74d);border-radius:4px;padding:10px 14px">
      <p style="font-size:12px;font-weight:600;margin:0 0 8px;color:var(--foreground)">Not seeing any detailed OTEL data?</p>
      <p style="font-size:12px;color:var(--muted);margin:0 0 8px">TraceRoost automatically configures all supported agents on startup/activation, including Codex's <code style={codeStyle}>[otel]</code> section. It only rewrites a file when a required setting is missing or differs, so this is silent after the first successful run. Works in VS Code, Cursor, Windsurf, VSCodium, Trae, Kiro, and other VS Code-family IDEs. After configuration, restart each <a href="#gl-agent">agent</a> once so it reads the new settings. Changed an agent's OTEL settings yourself? Use the <strong>Configure OTEL</strong> button in Settings (gear icon), or review the <a href="https://github.com/traceroost/core/tree/main/scripts" target="_blank" rel="noreferrer">repository scripts</a>. Disable auto-configuration entirely via the <code style={codeStyle}>traceRoost.autoConfigureAgents</code> setting.</p>
      <p style="font-size:11px;color:var(--muted);margin:0 0 6px">Config is read at startup — restart after TraceRoost activates:</p>
      <table style="font-size:11px;border-collapse:collapse;width:100%">
        <tbody style="color:var(--muted)">
          <tr style="border-bottom:1px solid var(--border)">
            <td style="padding:4px 12px 4px 0;white-space:nowrap;vertical-align:top;color:var(--foreground)">GitHub Copilot</td>
            <td style="padding:4px 0;vertical-align:top"><kbd style={kbdStyle}>Cmd+Shift+P</kbd> / <kbd style={kbdStyle}>Ctrl+Shift+P</kbd> → <em>Reload Window</em> to restart the extension host (works in all VS Code-family IDEs).</td>
          </tr>
          <tr style="border-bottom:1px solid var(--border)">
            <td style="padding:4px 12px 4px 0;white-space:nowrap;vertical-align:top;color:var(--foreground)">Claude Code (CLI)</td>
            <td style="padding:4px 0;vertical-align:top">Exit any running <code style={codeStyle}>claude</code> session and start a new one.</td>
          </tr>
          <tr style="border-bottom:1px solid var(--border)">
            <td style="padding:4px 12px 4px 0;white-space:nowrap;vertical-align:top;color:var(--foreground)">Claude Code (VS Code)</td>
            <td style="padding:4px 0;vertical-align:top">Reload the VS Code window (<em>Reload Window</em> from the Command Palette).</td>
          </tr>
          <tr>
            <td style="padding:4px 12px 4px 0;white-space:nowrap;vertical-align:top;color:var(--foreground)">Codex</td>
            <td style="padding:4px 0;vertical-align:top">Type <code style={codeStyle}>/exit</code> (or press <kbd style={kbdStyle}>Ctrl+C</kbd>), close the terminal tab/window, open a new terminal, and run <code style={codeStyle}>codex</code> again. For an IDE-hosted Codex extension, also use <em>Reload Window</em>.</td>
          </tr>
        </tbody>
      </table>
      <p style="font-size:11px;color:var(--muted);margin:8px 0 0">Open the <em>TraceRoost</em> output channel (<em>View → Output → TraceRoost</em>) to confirm spans are arriving.</p>
      <p style="font-size:11px;color:var(--muted);margin:6px 0 0"><strong style="color:var(--fg)">OpenCode:</strong> No configuration needed. TraceRoost reads OpenCode's local SQLite database automatically from <code style={codeStyle}>~/.local/share/opencode/</code> — sessions appear as <strong>Log</strong> badge entries without any OTEL setup.</p>
    </div>
  )

  const portNote = (
    <p style={mutedP}>Manual configuration — replace <code style={codeStyle}>4318</code> with your custom port if you changed <em>traceRoost.otlpPort</em>.</p>
  )

  const copilotSection = (
    <div style="margin-bottom:20px">
      <h4 style={h4Style}>GitHub Copilot</h4>
      {standalone ? (
        <>
          <p style={mutedP}>Set these environment variables so they are available when you run <code style={codeStyle}>copilot</code>. The configure script updates your shell profile automatically; or set them manually.</p>
          <pre style={preStyle}>{`# macOS / Linux — add to ~/.zshrc or ~/.bashrc, then: source ~/.zshrc
export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4318"
export OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true

# Windows — run once in PowerShell (persists across sessions):
[System.Environment]::SetEnvironmentVariable("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4318", "User")
[System.Environment]::SetEnvironmentVariable("OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT", "true", "User")`}</pre>
        </>
      ) : (
        <>
          <p style={mutedP}>Add to <strong>User Settings</strong> in your VS Code-family IDE (<kbd style={kbdStyle}>Cmd+Shift+P</kbd> / <kbd style={kbdStyle}>Ctrl+Shift+P</kbd> → <em>Preferences: Open User Settings (JSON)</em>). Works in VS Code, Cursor, Windsurf, VSCodium, Trae, and Kiro.</p>
          <pre style={preStyle}>{`{
  "github.copilot.chat.otel.enabled": true,
  "github.copilot.chat.otel.exporterType": "otlp-http",
  "github.copilot.chat.otel.otlpEndpoint": "http://localhost:4318"
}`}</pre>
        </>
      )}
    </div>
  )

  const claudeSection = (
    <div style="margin-bottom:20px">
      <h4 style={h4Style}>Claude Code</h4>
      <p style={mutedP}>The CLI and VS Code extension both read the same file. Add to the <code style={codeStyle}>"env"</code> block:</p>
      {pathNote('~/.claude/settings.json', '%USERPROFILE%\\.claude\\settings.json')}
      <pre style={preStyle}>{`{
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "CLAUDE_CODE_ENHANCED_TELEMETRY_BETA": "1",
    "OTEL_TRACES_EXPORTER": "otlp",
    "OTEL_EXPORTER_OTLP_PROTOCOL": "http/json",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "http://localhost:4318",
    "OTEL_LOG_TOOL_DETAILS": "1",
    "OTEL_LOG_TOOL_CONTENT": "1",
    "OTEL_LOG_USER_PROMPTS": "1"
  }
}`}</pre>
      <p style="font-size:11px;color:var(--muted);margin-top:6px;line-height:1.6">
        <strong>CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1</strong> enables span-level tracing — without it <a href="#gl-turn">turns</a> and <a href="#gl-llm-call">LLM calls</a> are indistinguishable and cache token breakdowns are unavailable.{' '}
        The three <strong>OTEL_LOG_*</strong> vars unlock tool details, file diff content (needed for the Files tab), and your typed prompt.
      </p>
    </div>
  )

  const codexSection = (
    <div style="margin-bottom:4px">
      <h4 style={h4Style}>Codex</h4>
      <p style={mutedP}>The CLI and VS Code extension both read the same file. Add an <code style={codeStyle}>[otel]</code> section:</p>
      {pathNote('~/.codex/config.toml', '%USERPROFILE%\\.codex\\config.toml')}
      <pre style={preStyle}>{`[otel]
log_user_prompt = true
exporter = { otlp-http = { endpoint = "http://localhost:4318", protocol = "json" } }
trace_exporter = { otlp-http = { endpoint = "http://localhost:4318", protocol = "json" } }`}</pre>
      <p style="font-size:11px;color:var(--muted);margin-top:6px;line-height:1.6">
        <strong>log_user_prompt=true</strong> includes your typed prompt; without it sessions show <code style={codeStyle}>[session in progress]</code>.{' '}
        <code style={codeStyle}>exporter</code> sends log events; <code style={codeStyle}>trace_exporter</code> sends <a href="#gl-span">trace spans</a>. Both point at the same endpoint.
      </p>
    </div>
  )

  const manualHeading = (
    <h4 style="font-size:13px;font-weight:600;margin:20px 0 6px;padding-bottom:5px;border-bottom:1px solid var(--border);color:var(--fg)">Manual Configuration</h4>
  )

  const backgroundServiceNote = standalone ? (
    <div style="margin-bottom:20px;background:var(--hover);border:1px solid var(--border);border-left:3px solid var(--accent,#42a5f5);border-radius:4px;padding:10px 14px">
      <p style="font-size:12px;font-weight:600;margin:0 0 8px;color:var(--foreground)">Run as a Background Service</p>
      <p style="font-size:12px;color:var(--muted);margin:0 0 8px">
        If TraceRoost isn't running, incoming OTEL data has nowhere to go and is lost — agents don't queue
        or retry failed exports. Running it in a terminal only lasts until that terminal closes, so a forgotten
        window, a closed laptop lid, or a reboot means a gap in your session history. Installing it as a
        background service keeps it running automatically instead:
      </p>
      <pre style="font-size:12px;background:var(--panel-bg);border:1px solid var(--border);border-radius:3px;padding:6px 10px;margin:0 0 8px;overflow-x:auto;white-space:pre">{`npx traceroost@latest service install`}</pre>
      <p style="font-size:12px;color:var(--muted);margin:0 0 8px">
        Works as a single command whether or not <code style={codeStyle}>traceroost</code> is
        already installed — if it's running via <code style={codeStyle}>npx</code>, which has no stable
        location to launch from later, it installs the package globally first (visibly, printing what
        it's doing) and then continues. On macOS this registers a <code style={codeStyle}>launchd</code> LaunchAgent,
        on Linux a <code style={codeStyle}>systemd --user</code> unit, and on Windows a Scheduled Task —
        all per-user, no admin/root privileges needed. Once installed, it starts automatically at login
        (and immediately on install) and restarts itself if it crashes.
      </p>
      <p style="font-size:12px;color:var(--muted);margin:0 0 8px">
        <code style={codeStyle}>traceroost service status</code> checks whether it's running,{' '}
        <code style={codeStyle}>logs</code> (or <code style={codeStyle}>logs --follow</code>) shows its
        output, <code style={codeStyle}>stop</code>/<code style={codeStyle}>start</code>/<code style={codeStyle}>restart</code> control
        it, and <code style={codeStyle}>uninstall</code> removes it — your data in{' '}
        <code style={codeStyle}>~/.traceroost</code> is untouched either way. See{' '}
        <a href="https://github.com/traceroost/core#background-service-macos--windows--linux" target="_blank" rel="noreferrer">the README</a> for
        the full command reference and custom port/data-dir options.
      </p>
      <p style="font-size:12px;color:var(--muted);margin:0;background:var(--panel-bg);border-radius:3px;padding:8px 10px">
        <strong style="color:var(--fg)">The background service does not auto-update.</strong> It keeps
        running whatever version was installed until you run{' '}
        <code style={codeStyle}>traceroost service update</code>, which installs the latest{' '}
        <code style={codeStyle}>traceroost</code> from npm and restarts the service on it.
      </p>
    </div>
  ) : null

  return (
    <div class="help-section" id="help-config">
      <h3 class="help-heading">{HELP_SECTIONS.config.heading}</h3>
      {callout}
      {backgroundServiceNote}
      {manualHeading}
      {portNote}
      {copilotSection}
      {claudeSection}
      {codexSection}
    </div>
  )
}

function AgentOtelSection() {
  return (
    <div class="help-section" id="help-otel">
      <h3 class="help-heading">{HELP_SECTIONS.otel.heading}</h3>
      <div class="help-overview-body">
        <p>TraceRoost normalizes three different <a href="#gl-otlp">OTEL</a> shapes into one dashboard model. The shared model is a prompt-to-response <a href="#gl-trace">trace</a> with <a href="#gl-turn">LLM turns</a>, <a href="#gl-tool-call">tool calls</a>, <a href="#gl-tokens">token</a> usage, timing, errors, and files, but the raw data arrives differently for each agent.</p>
        <div class="glossary">
          {AGENT_OTEL_SHAPES.map(row => (
            <div class="glossary-item" style="flex-direction:column;gap:6px">
              <dt class="glossary-term">{row.agent}</dt>
              <dd class="glossary-def" style="display:block">
                <p style="margin:0 0 6px"><strong style="color:var(--fg)">Format: </strong><span dangerouslySetInnerHTML={{ __html: row.format }} /></p>
                <p style="margin:0 0 6px"><strong style="color:var(--fg)">What's included: </strong><span dangerouslySetInnerHTML={{ __html: row.coverage }} /></p>
                <p style="margin:0"><strong style="color:var(--fg)">Gaps: </strong><span dangerouslySetInnerHTML={{ __html: row.gaps }} /></p>
              </dd>
            </div>
          ))}
        </div>
        <p style="margin-top:14px;font-size:12px;color:var(--muted)">The practical effect: Traces and Timeline stay closest to the raw OTEL structure, while Efficiency, Insights, Alerts, Automation, Agents, and Flow all use the normalized session model so the three agents can be compared side by side.</p>
        <h4 style={subHeadStyle}>Log-only agents (no OTEL)</h4>
        <div class="glossary">
          <div class="glossary-item" style="flex-direction:column;gap:6px">
            <dt class="glossary-term">OpenCode</dt>
            <dd class="glossary-def" style="display:block">
              <p style="margin:0 0 6px"><strong style="color:var(--fg)">Format: </strong>Local SQLite database at <code style={codeStyle}>~/.local/share/opencode/opencode.db</code> (Linux/Mac) or <code style={codeStyle}>%APPDATA%\opencode\opencode.db</code> (Windows). No OTEL support. TraceRoost reads the database directly using WASM SQLite, merging the WAL file at read time. Override the path with the <code style={codeStyle}>OPENCODE_DATA_DIR</code> environment variable.</p>
              <p style="margin:0 0 6px"><strong style="color:var(--fg)">What's included: </strong>Session ID, workspace directory, model name, timestamps, all token counts (input, output, cache read/write), user request (last user message in the session), tool call names and inputs/outputs, file paths accessed by tools, and a full per-turn timeline of LLM calls and tool calls.</p>
              <p style="margin:0"><strong style="color:var(--fg)">Not available: </strong>OTEL traces, time-to-first-token, per-tool execution timing, streaming speed, and loop detection signals. Sessions show a <strong>Log</strong> badge and a blue info banner in the Overview tab noting these limitations.</p>
            </dd>
          </div>
        </div>
      </div>
    </div>
  )
}

function SessionsSection() {
  return (
    <div class="help-section" id="help-traces">
      <h3 class="help-heading">{HELP_SECTIONS.traces.heading}</h3>
      <div class="help-overview-body">
        <p>The Traces tab shows every recorded <a href="#gl-trace">trace</a> — one prompt-to-response cycle — as a sortable table: timestamp, prompt, model, tokens, duration, and estimated cost per row. Use the filter bar to search by text, filter by agent, data source (OTEL / Log), or initiator (User / Agent / API), set a time range, or cap the number of rows shown. The Reset button clears all active filters back to defaults.</p>
        <p>Claude Code, Codex, and Copilot Chat (VS Code) each write one log file per working period on disk — but a single file can span multiple genuinely separate <a href="#gl-conversation">conversations</a> if a long idle gap (30+ minutes) separates them, so TraceRoost splits it into one trace per conversation rather than showing one entry with a misleading multi-hour (or multi-day) duration. A colored bar on the left edge of a row marks traces that came from the same original conversation — same color means same conversation, split apart by time. Hover the bar for its position (e.g. "Part 2 of 5"), or click it to isolate just that conversation's traces — a banner appears above the filter bar naming the conversation's first prompt, with a <strong>Show all traces</strong> button to clear it (or click the same bar again — the active bar renders slightly wider). Only traces still visible under the active filters are colored; if a filter hides a sibling, the remaining row isn't colored — nothing implies a hidden sibling exists.</p>
        <p>Click any row to expand it in-place. Five sub-tabs appear beneath the row:</p>

        <h4 style={subHeadStyle}>Sub-tabs</h4>
        <div class="glossary" style="margin-bottom:20px">
          <div class="glossary-item" style="flex-direction:column;gap:4px">
            <dt class="glossary-term">Overview</dt>
            <dd class="glossary-def" style="display:block">
              Stat tiles — total tokens, estimated cost, duration, turn count, error count, and cache hit rate. A burn rate card shows tokens per minute for the session. Below the tiles is the <strong>Insights panel</strong>, which surfaces efficiency signals and loop detection results for that session (see <a href="#help-insights">Insights</a> and <a href="#help-loops">Loop Detection</a> below).
            </dd>
          </div>
          <div class="glossary-item" style="flex-direction:column;gap:4px">
            <dt class="glossary-term">Trace</dt>
            <dd class="glossary-def" style="display:block">
              Full waterfall of every <a href="#gl-llm-call">LLM call</a> and <a href="#gl-tool-call">tool call</a> in the session, displayed as horizontal timing bars with nesting depth. Expand any span row to see arguments, results, token counts, and estimated cost per call. The badge on the tab label shows the total span count.
            </dd>
          </div>
          <div class="glossary-item" style="flex-direction:column;gap:4px">
            <dt class="glossary-term">Flow</dt>
            <dd class="glossary-def" style="display:block">
              A turn-to-tool semantic graph showing how the agent moved through the session — which LLM turns triggered which tools, and in what order. Useful for spotting repeated tool calls or unusual branching. The badge shows the total node count.
            </dd>
          </div>
          <div class="glossary-item" style="flex-direction:column;gap:4px">
            <dt class="glossary-term">Tools</dt>
            <dd class="glossary-def" style="display:block">
              A donut chart of tool call distribution for the session — how many times each tool was invoked, expressed as a percentage of all tool calls. The badge shows the total tool call count.
            </dd>
          </div>
          <div class="glossary-item" style="flex-direction:column;gap:4px">
            <dt class="glossary-term">Files</dt>
            <dd class="glossary-def" style="display:block">
              Every file created or modified during the session, grouped by path. Click any file to open a diff in the editor. The badge shows the number of unique files touched. A one-shot/retry-rate line summarizes edit passes per file (e.g. "80% one-shot (4/5 files, avg 1.2 edit passes/file)") — hidden entirely when no files were edited, and shown as "not enough data" below 2 edited files. A git outcome banner (VS Code extension only) compares each changed file's content against git history to classify it <strong>Committed</strong> (changed since the session and now in a commit), <strong>Reverted</strong> (back to its pre-session content), <strong>Uncommitted</strong> (changed but still sitting in the working tree), or <strong>Unknown</strong> (outcome can't be determined) — computed on demand when the row is expanded, with a matching badge per file.
            </dd>
          </div>
        </div>

        <h4 id="help-insights" style={subHeadStyle}>Insights</h4>
        <p style="font-size:12px;color:var(--muted);margin:0 0 12px">The Insights panel appears inside the <strong>Overview</strong> sub-tab of each expanded session row. It surfaces efficiency signals for <a href="#gl-tokens">token</a> waste, <a href="#gl-cache-hit-rate">cache</a> patterns, tool behavior, and prompt shape — the signals meant to help you spend fewer <a href="#gl-turn">turns</a> and fewer tokens on the same work.</p>
        <div class="glossary">
          <InsightBlock id="help-context-bloat" title="Context Bloat"
            why="Every LLM turn receives the full conversation so far. When tool results are large — full file reads, wide search outputs — the context balloons quickly. Instruction files that repeat the same guidance across turns are another common cause."
            steps={`<li>Run <code style="${codeStyle}">wc -c ~/.claude/CLAUDE.md</code> to measure instruction file size. Target under 4 KB.</li><li>Remove verbose examples from instruction files.</li><li>Replace broad <code style="${codeStyle}">read_file</code> calls with line-ranged reads.</li><li>Add to your prompt: "Only include relevant excerpts in your reasoning."</li>`}
            impact="Reducing context size by 30% typically halves cost per session and cuts TTFT by 15–25%."
          />
          <InsightBlock id="help-files-repeated" title="Files Read Multiple Times"
            why="Agents re-read files when processing tasks in chunks, when the file path appears ambiguously in context, or when a previous read was so broad the model lost the relevant section."
            steps={`<li>Explicitly name key files upfront in your prompt.</li><li>Specify which file contains what: <em>"The schema is in db/schema.sql lines 1-40"</em>.</li><li>Ask for a "read plan" before execution.</li><li>If a file is read 4+ times, paste the relevant lines directly into your prompt.</li>`}
            impact="Eliminating repeated reads of a 500-line file saves 2,000–5,000 input tokens per extra read."
          />
          <InsightBlock id="help-high-turns" title="High Turn Count"
            why={`High turn counts happen when the agent discovers information iteratively. The prompt describes the <em>goal</em> but not the <em>location</em>; the task has implicit sub-tasks; or success criteria were not specified.`}
            steps={`<li>Add explicit file paths and line numbers.</li><li>Define explicit stopping conditions.</li><li>Break multi-step tasks into separate prompts.</li><li>Review the Timeline tab: if &gt;50% of turns are reads, add more upfront context.</li>`}
            impact="Going from 12 turns to 5 reduces cost by 40–60% and cuts wall-clock time proportionally."
          />
          <InsightBlock id="help-large-context" title="Large Starting Context"
            why="If your instruction files (CLAUDE.md, .agent.md, copilot-instructions.md) are large, every session starts expensive. Common culprits: long examples, full API docs pasted inline, duplicate instructions."
            steps={`<li>Audit instruction files — look for sections longer than 20 lines.</li><li>Move reference material into separate docs the agent can read on demand.</li><li>Check for duplicate instruction sources across file levels.</li><li>Target a meaningful reduction in combined static instructions — even halving them cuts baseline cost per call.</li>`}
            impact={`Trimming 10,000 tokens from starting context saves those tokens on <em>every</em> LLM call. For a 10-turn session, that is 100,000 tokens recovered.`}
          />
          <InsightBlock id="help-duplicate-searches" title="Duplicate Searches"
            why="Agents repeat searches when results were too broad, when the model forgot a search was already run, or when handling multiple similar operations."
            steps={`<li>Add directory scope: <em>"Search only in src/components/"</em>.</li><li>Provide the file name if you know it.</li><li>Use exact function/class names for symbol searches.</li><li>Add: <em>"Do not repeat a search you have already run."</em></li>`}
            impact="Each eliminated search removes one tool call and ~5KB from context."
          />
          <InsightBlock id="help-tool-failures" title="Tool Failures"
            why="Tool failures come from: (1) guessed file paths that don't exist, (2) unavailable commands, or (3) hallucinated APIs. Each failure adds error text to context."
            steps={`<li>Provide exact file paths in your prompt.</li><li>Tell the agent which package manager and runtime are available.</li><li>Verify files exist before prompting.</li>`}
            impact="Each eliminated failure saves one full LLM recovery turn — roughly 30,000 wasted tokens per failure cascade."
          />
          <InsightBlock id="help-large-results" title="Large Tool Results"
            why="When the agent reads entire large files or runs broad searches, results are appended to context in full. A 50KB file adds ~12,500 tokens to every subsequent call."
            steps={`<li>Use line-range reads: <em>"Read src/app.ts lines 1-80"</em>.</li><li>Provide tighter search patterns.</li><li>Pipe command output to head or limit lines.</li><li>Split large reads into separate steps.</li>`}
            impact="Replacing a 300-line read with a 30-line read saves 2,700 tokens per turn."
          />
          <InsightBlock id="help-tool-overhead" title="Tool Definition Overhead"
            why="Every LLM call includes the full JSON schema for every available tool. With 70+ tools, this overhead reaches 8,000–15,000 tokens per call."
            steps={`<li>Create a task-specific <code style="${codeStyle}">.agent.md</code> with only needed tools.</li><li>Disable unused tools for specific task types.</li><li>Check your agent's documentation for tool restriction syntax.</li>`}
            impact="Reducing from 70 to 10 tools saves ~10,000 tokens per LLM call."
          />
          <InsightBlock id="help-cache-rate" title="Low Cache Hit Rate"
            why="Prompt caching stores the stable prefix on the model server. The cache breaks when the prefix changes between calls — timestamps, reordered instructions, or modified instruction files."
            steps={`<li>Keep static content at the <em>top</em> of prompts, identical across calls.</li><li>Avoid timestamps or counters in instruction files.</li><li>Cache rate will be low after editing instruction files until re-cached.</li><li>Ensure system prompt templates are not dynamically generated.</li>`}
            impact={`Going from 0% to 60% cache hit rate reduces effective cost by 80–90%. TTFT also drops significantly.`}
          />
        </div>

        <h4 id="help-loops" style={subHeadStyle}>Loop Detection</h4>
        <p style="font-size:12px;color:var(--muted);margin:0 0 12px"><a href="#gl-loop-signal">Loop signals</a> are behavioral patterns indicating the <a href="#gl-agent">agent</a> is stuck, oscillating, or spiraling into unproductive work. They appear in the Insights panel with warning or critical severity.</p>
        <div class="glossary">
          <LoopBlock id="help-tool-deadlock" title="Tool Call Deadlock"
            why="The same tool call — identical name and arguments — was executed 5+ times. The agent is not retaining the result, likely lost in a long context."
            example={`The agent ran <code style="font-size:10px;background:var(--panel-bg);padding:1px 3px;border-radius:2px">read_file src/types.ts</code> eight times in one session.`}
            steps={`<li>Add: <em>"After reading a file, do not read it again unless you have modified it."</em></li><li>Scope the task so fewer files are needed.</li><li>Pin non-deterministic commands to fixed output.</li><li>Stop the session and restart with what was already read.</li>`}
            impact="Stopping this pattern prevents runaway token accumulation. 200K tokens looping → 20K tokens with a direct prompt."
          />
          <LoopBlock id="help-state-spiral" title="State Corruption Spiral"
            why="A file was edited (A→B) then reverted (B→A). The agent oscillates because two constraints are mutually exclusive."
            example="The agent added a null check (fixing one test), removed it (breaking another), then added it back — cycling."
            steps={`<li>Clarify success criteria with explicit priority ordering.</li><li>Provide the exact final file state if possible.</li><li>Check if tests assert contradictory behavior.</li><li>Use the Files tab to spot A→B→A patterns.</li>`}
            impact="Resolving the conflict takes 2–3 focused turns vs. 20–40 oscillating turns."
          />
          <LoopBlock id="help-hallucination" title="Hallucination Amplification Loop"
            why="The same error appeared 3+ times. The agent's fix attempts fail because the root cause is something the model invented — a nonexistent package, wrong function name, or outdated API."
            example={`A <code style="font-size:10px;background:var(--panel-bg);padding:1px 3px;border-radius:2px">ModuleNotFoundError</code> appeared five times as the agent tried different import paths for a package not installed.`}
            steps={`<li>Stop and verify the root cause yourself.</li><li>Tell the agent explicitly what exists.</li><li>Paste actual API responses or function signatures.</li><li>After 2 failures, resolve the underlying issue before re-prompting.</li>`}
            impact="Intervening after 2 recurrences instead of 6 saves ~120,000 tokens in a 30K-token session."
          />
          <LoopBlock id="help-runaway-steps" title="Ambiguous Success / Escalating Scope"
            why="The session consumed far more LLM calls than expected. The prompt has no stopping condition, uses open-ended phrasing, or the agent expands scope on its own."
            example={`"Fix the login bug" accumulated 90+ steps — the agent then noticed unrelated issues and updated 3 extra files.`}
            steps={`<li>Add explicit stopping conditions.</li><li>Avoid open-ended phrasing — name specific functions and files.</li><li>Specify scope: <em>"Only change files in src/auth/"</em>.</li><li>Monitor the context growth chart for steep rises.</li>`}
            impact="A 5-step prompt vs. a 90-step session saves 85 tool calls — a 5–20x token reduction."
          />
          <LoopBlock id="help-context-accumulation" title="Infinite Loop — Context Accumulation"
            why={`<a href="#gl-input-tokens">Input tokens</a> grew by 30,000+ across 4+ calls while <a href="#gl-output-ratio">output-to-input ratio</a> collapsed by 70%+. The agent is consuming context while producing less output.`}
            example="First call: 8K in → 600 out (7.5%). Last call: 65K in → 80 out (0.12%). Five turns reading the same files without edits."
            steps={`<li>Stop immediately — cost compounds with no progress.</li><li>Start fresh with a focused prompt stating what was already read.</li><li>Include the specific target state, not just the problem.</li><li>Use the Traces tab to review what was accomplished.</li>`}
            impact="Catching at 4 calls instead of 10 saves ~390,000 input tokens at peak context size."
          />
          <LoopBlock id="help-chronic-tool-unreliability" title="Chronic Tool Unreliability"
            why="An unusually high share of this session's tool calls failed — 20%+ with at least 5 calls made, well above the ordinary rate of an occasional wrong path corrected along the way. Unlike the Hallucination Amplification Loop above, this doesn't require the same error to repeat — it catches a session with many different one-off failures."
            example="7 of 12 tool calls failed (58%): bash ×4 (command not found), read_file ×3 (path guessed incorrectly)."
            steps={`<li>Be explicit about file locations and the exact commands available.</li><li>State the package manager and runtime in use.</li><li>Verify paths and commands exist before prompting.</li>`}
            impact="Each eliminated failure saves a full LLM recovery turn — roughly 30,000 wasted tokens per cascade."
          />
          <LoopBlock id="help-context-flooding-risk" title="Context Flooding Risk"
            why="A tool call returned a result over 10,000 characters, which gets appended to context in full and crowds out everything else for the rest of the session."
            example="A read_file call on a 300-line file added 45KB (~11,000 tokens) to every subsequent call in the session."
            steps={`<li>Use line-range reads instead of whole files.</li><li>Tighten search patterns.</li><li>Pipe command output through something that limits it.</li>`}
            impact="Replacing a 300-line read with a 30-line read saves ~2,700 tokens per turn for the rest of the session."
          />
          <LoopBlock id="help-malformed-tool-call" title="Malformed Tool Call"
            why="The agent's own harness rejected a call before it ran — a wrong argument name, an unknown tool, or malformed arguments. This is different from a normal runtime failure (a grep that finds nothing, a build that fails on real code): it means the agent's call didn't match what the tool expected, not that the codebase has a problem. Fires on a single occurrence, unlike the other signals here."
            example={`<code style="font-size:10px;background:var(--panel-bg);padding:1px 3px;border-radius:2px">Invalid tool call: missing required parameter "path"</code>`}
            steps={`<li>If this recurs, the agent may be working from an outdated or incorrect idea of what tools are available.</li><li>Check whether a tool definition changed recently.</li>`}
            impact="Each rejected call is a full round-trip to the model that produced nothing but an error to recover from."
          />
        </div>
        <p style="margin-top:16px;font-size:12px;color:var(--muted)">Loop signals appear in the Insights panel inside the <strong>Overview</strong> sub-tab of each session, sorted by severity. Use the <strong>Loops</strong> filter pill to view only malfunction signals. Use <strong>Ignore</strong> to dismiss a signal if it was intentional behavior.</p>
      </div>
    </div>
  )
}

function AnalyticsSection() {
  return (
    <div class="help-section" id="help-analytics">
      <h3 class="help-heading">{HELP_SECTIONS.analytics.heading}</h3>
      <div class="help-overview-body">
        <p>The Analytics tab shows aggregate charts and metrics across all sessions in the active time range. Use the Source filter to limit to OTEL-traced sessions or log-ingested sessions, and the time range picker to zoom into a specific window. The Reset button restores all filters to defaults.</p>
        <div class="glossary">
          <div class="glossary-item" style="flex-direction:column;gap:4px">
            <dt class="glossary-term">Agent Breakdown</dt>
            <dd class="glossary-def" style="display:block">One card per agent showing total input tokens, output tokens, cache hit rate, estimated cost, One-shot rate, and top tools used — all scoped to the active time range and source filter. One-shot rate is the file-level percentage of edited files that got it right on the first pass, aggregated across all of the agent's sessions; hidden when fewer than 2 files were edited (not enough data for a meaningful rate).</dd>
          </div>
          <div class="glossary-item" style="flex-direction:column;gap:4px">
            <dt class="glossary-term">Estimated Cost</dt>
            <dd class="glossary-def" style="display:block">A bar chart of daily spend with a green total-per-day overlay line and inline date labels at day boundaries. Below the chart: a day-grouped cost table (date → agent → model) and a model breakdown table. The <strong>↓ CSV</strong> button exports the cost data.</dd>
          </div>
          <div class="glossary-item" style="flex-direction:column;gap:4px">
            <dt class="glossary-term">Token Usage Per Session</dt>
            <dd class="glossary-def" style="display:block">Slim horizontal bars, one per session, ordered oldest to newest. Each bar is colored by agent. Useful for spotting runaway sessions at a glance.</dd>
          </div>
          <div class="glossary-item" style="flex-direction:column;gap:4px">
            <dt class="glossary-term">Context Growth</dt>
            <dd class="glossary-def" style="display:block">Input token accumulation across LLM turns within each session, overlaid for all sessions in the active range. A steep upward slope indicates rapid context growth; a flat line means the agent is working efficiently. Click any line to highlight that session.</dd>
          </div>
        </div>
      </div>
    </div>
  )
}

function PatternsSection() {
  return (
    <div class="help-section" id="help-advisor">
      <h3 class="help-heading">{HELP_SECTIONS.patterns.heading}</h3>
      <div class="help-overview-body">
        <p>The Advisor tab analyzes your session history to surface actionable improvements for your agent instruction file. All panels respect the shared filter bar — select a specific project from the workspace filter for suggestions tailored to that project's files and behavior. With no project selected, only patterns universal across all workspaces surface.</p>

        <h4 style={subHeadStyle}>Instructions File</h4>
        <p style={mutedP}>TraceRoost scans session patterns and generates specific, ready-to-copy suggestions for improving your instruction file (CLAUDE.md, AGENTS.md, .github/copilot-instructions.md, or similar). Suggestions are grouped by type:</p>
        <div class="glossary">
          <div class="glossary-item" style="flex-direction:column;gap:4px">
            <dt class="glossary-term">Hot file context</dt>
            <dd class="glossary-def" style="display:block">Files the agent rediscovers from scratch in many sessions. Adding them to your instruction file eliminates 2–3 discovery turns per session.</dd>
          </div>
          <div class="glossary-item" style="flex-direction:column;gap:4px">
            <dt class="glossary-term">Front-loaded discovery</dt>
            <dd class="glossary-def" style="display:block">Read-only reference files (never modified) that appear in the majority of sessions. Listing them upfront means the agent reads them immediately rather than searching.</dd>
          </div>
          <div class="glossary-item" style="flex-direction:column;gap:4px">
            <dt class="glossary-term">Loop prevention</dt>
            <dd class="glossary-def" style="display:block">Behavioral loop signals (exact tool repeats, edit/revert cycles, runaway steps) detected across sessions. Each generates direct instruction text targeting the specific pattern.</dd>
          </div>
          <div class="glossary-item" style="flex-direction:column;gap:4px">
            <dt class="glossary-term">Scope guidance</dt>
            <dd class="glossary-def" style="display:block">Open-ended prompt language ("refactor", "fix the bug") that correlates with significantly higher cost or turn counts. Suggests prompting constraints to add to your instruction file.</dd>
          </div>
          <div class="glossary-item" style="flex-direction:column;gap:4px">
            <dt class="glossary-term">High turn count</dt>
            <dd class="glossary-def" style="display:block">Triggered when a significant share of sessions exceed 1.5× the average turn count, indicating missing upfront context. Works for all agent types including Copilot.</dd>
          </div>
        </div>
        <p style={mutedP}>Each suggestion card shows a <strong>Recommended addition</strong> — text ready to paste into your instruction file — and an <strong>Ask your agent</strong> prompt you can copy and send directly to your agent to get its own recommendation. Both have Copy buttons. <strong>TraceRoost never edits your instruction file itself</strong> — nothing here writes to disk; every suggestion is copy-and-paste only, applied by you (or by the agent, if you paste the "Ask your agent" prompt into it).</p>

        <h4 style={subHeadStyle}>Efficiency Map</h4>
        <p style={mutedP}>A scatter plot where each dot is one session. Right = more expensive. Up = more LLM calls. Color = cache hit rate (green ≥60%, orange 20–60%, red &lt;20%). Click a dot to navigate to that session. The table below shows the top 10 sessions sorted by the active column — click any column header to re-sort.</p>

        <h4 style={subHeadStyle}>Hot Files</h4>
        <p style={mutedP}>Files the agent accessed most frequently across sessions, ranked by session count. Switch between Read, Changed, Written, and Both modes. Frequently read files cost tokens every session and are strong candidates for your instruction file; frequently changed files benefit from explicit constraints.</p>
      </div>
    </div>
  )
}

function CostSection() {
  const tblStyle = 'width:100%;border-collapse:collapse;font-size:12px;margin-bottom:4px'
  const thStyle = 'text-align:left;padding:5px 10px 5px 0;border-bottom:2px solid var(--border);color:var(--muted);font-size:11px;text-transform:uppercase;font-weight:600'
  const tdStyle = 'padding:5px 10px 5px 0;border-bottom:1px solid var(--border);vertical-align:top'
  const tdBold  = tdStyle + ';font-weight:600;color:var(--fg);white-space:nowrap'
  return (
    <div class="help-section" id="help-costs">
      <h3 class="help-heading">{HELP_SECTIONS.costs.heading}</h3>
      <div class="help-overview-body">

        <h4 style={subHeadStyle}>Why TraceRoost costs look higher than your subscription</h4>
        <p>TraceRoost calculates every session's cost using the published <strong>API metered rates</strong> — the per-token prices a developer pays when calling the Anthropic, OpenAI, or GitHub Copilot APIs directly. These are real public rates, not estimates.</p>
        <p>If you use Claude Code on a <strong>Claude Pro or Max plan</strong>, or Copilot on a subscription plan, the cost TraceRoost shows is the <em>API-equivalent value</em> of the compute you consumed — not what appears on your credit card. Subscription plans bundle a large monthly compute allowance at a flat rate that works out to roughly <strong>15–30× cheaper per token</strong> than paying metered API rates with the same dollar amount.</p>
        <p style="font-size:12px;color:var(--muted);margin-bottom:0">Think of it like a cell plan: you pay $50/month for unlimited data, but if you counted each byte at the retail pay-as-you-go rate, the number would look enormous. TraceRoost shows you the pay-as-you-go equivalent — which tells you how much compute you're consuming and which sessions are expensive, even when you're not paying per token.</p>

        <h4 style={subHeadStyle}>What the cost number is still useful for on a subscription</h4>
        <ul style="font-size:12px;color:var(--muted);padding-left:18px;line-height:1.8;margin-bottom:0">
          <li><strong style="color:var(--fg)">Relative cost</strong> — session A used 10× more compute than session B, regardless of billing model</li>
          <li><strong style="color:var(--fg)">Budget draw-down</strong> — identify which sessions eat through your monthly allowance fastest</li>
          <li><strong style="color:var(--fg)">Model comparison</strong> — see whether a cheaper model would give equivalent results for your typical session shape</li>
          <li><strong style="color:var(--fg)">Overage warning</strong> — once you hit your included limit, additional usage is billed at metered rates; the TraceRoost number tells you what that would cost</li>
          <li><strong style="color:var(--fg)">Prompt efficiency</strong> — context bloat and repeated reads show up as real cost differences even when you aren't paying per token</li>
        </ul>

        <h4 style={subHeadStyle}>Claude Code — Pro and Max plans</h4>
        <table style={tblStyle}>
          <thead><tr>
            <th style={thStyle}>Plan</th>
            <th style={thStyle}>Price</th>
            <th style={thStyle}>What's included</th>
          </tr></thead>
          <tbody>
            <tr><td style={tdBold}>Claude Pro</td><td style={tdStyle}>$20/month</td><td style={tdStyle}>Large bundled compute allowance shared between claude.ai and Claude Code CLI; resets on a rolling cycle</td></tr>
            <tr><td style={tdBold}>Claude Max 5×</td><td style={tdStyle}>$100/month</td><td style={tdStyle}>~5× the Pro allowance</td></tr>
            <tr><td style={tdBold}>Claude Max 20×</td><td style={tdStyle}>$200/month</td><td style={tdStyle}>~20× the Pro allowance</td></tr>
            <tr><td style={tdBold}>API (no plan)</td><td style={tdStyle}>Pay-per-token</td><td style={tdStyle}>Billed exactly at published Anthropic rates — TraceRoost cost = your actual charge</td></tr>
          </tbody>
        </table>
        <p style={mutedP}>Claude Code CLI draws from the same compute pool as claude.ai. At published rates (e.g. claude-sonnet-4-6: $3.00 input / $15.00 output per million tokens), $20/month buys roughly 6–7M input tokens — but a Pro subscriber can typically use far more than that within the plan. When you exhaust your monthly allowance, additional usage is billed at standard API rates. Subscribers billed via the Anthropic API directly (not a claude.ai plan) see costs that match TraceRoost exactly.</p>

        <h4 style={subHeadStyle}>GitHub Copilot — AI Credits model (from June 2026)</h4>
        <table style={tblStyle}>
          <thead><tr>
            <th style={thStyle}>Plan</th>
            <th style={thStyle}>Price</th>
            <th style={thStyle}>Monthly AI Credits</th>
            <th style={thStyle}>Overage rate</th>
          </tr></thead>
          <tbody>
            <tr><td style={tdBold}>Copilot Pro</td><td style={tdStyle}>~$10/month</td><td style={tdStyle}>1,500 credits</td><td style={tdStyle}>$0.01/credit</td></tr>
            <tr><td style={tdBold}>Copilot Pro+</td><td style={tdStyle}>~$39/month</td><td style={tdStyle}>7,000 credits</td><td style={tdStyle}>$0.01/credit</td></tr>
            <tr><td style={tdBold}>Copilot Max</td><td style={tdStyle}>Enterprise</td><td style={tdStyle}>20,000 credits</td><td style={tdStyle}>$0.01/credit</td></tr>
          </tbody>
        </table>
        <p style={mutedP}>1 AI Credit = $0.01. Some models are <strong>included</strong> (zero credits — they show as $0.00 in TraceRoost). Premium models consume credits from your monthly allowance; usage above the allowance is charged at the overage rate. Code completions and Next Edit Suggestions are free and not tracked by TraceRoost. The TraceRoost cost for a Copilot session divided by $0.01 gives the credit count consumed. Copilot switched from a request-multiplier model to token-based AI Credits in June 2026; TraceRoost auto-detects which billing model applies based on the session date.</p>

        <h4 style={subHeadStyle}>Codex CLI — API billing only</h4>
        <p style={mutedP}>Codex CLI is billed entirely through the OpenAI API at metered token rates. <strong>ChatGPT Plus and ChatGPT Pro are separate products</strong> covering the web app only — they do not reduce or offset Codex CLI API costs. The TraceRoost cost shown for Codex sessions is exactly what OpenAI charges, making it the most directly actionable of the three: there is no subscription discount to account for.</p>
        <table style={tblStyle}>
          <thead><tr>
            <th style={thStyle}>Model</th>
            <th style={thStyle}>Input per MTok</th>
            <th style={thStyle}>Cached input</th>
            <th style={thStyle}>Output per MTok</th>
          </tr></thead>
          <tbody>
            <tr><td style={tdBold}>gpt-5.3-codex</td><td style={tdStyle}>$1.75</td><td style={tdStyle}>$0.175</td><td style={tdStyle}>$14.00</td></tr>
            <tr><td style={tdBold}>gpt-5.5</td><td style={tdStyle}>$5.00</td><td style={tdStyle}>$0.50</td><td style={tdStyle}>$30.00</td></tr>
          </tbody>
        </table>

      </div>
    </div>
  )
}

function SettingsSection() {
  return (
    <div class="help-section" id="help-settings">
      <h3 class="help-heading">{HELP_SECTIONS.settings.heading}</h3>
      <div class="help-overview-body">
        <p>Two icons in the top-right of the tab bar give you access to alert status and configuration without cluttering the main navigation.</p>

        <h4 style={subHeadStyle}>Bell icon — active alert status</h4>
        <p>The bell icon shows a numbered badge when one or more alert thresholds are currently triggered. Click it to open a status card listing every active alert — severity, name, and detail about which session tripped it. The card also has a <strong>Configure alerts →</strong> link that jumps straight to the settings panel. When no alerts are firing the bell has no badge.</p>

        <h4 style={subHeadStyle}>Gear icon — settings panel</h4>
        <p>The gear icon opens a slide-in settings panel containing two collapsible sections: <strong>Alerts</strong> and <strong>Automation</strong>. Close it with the × button or by pressing Escape.</p>

        <h4 id="help-alerts" style={subHeadStyle}>Alerts</h4>
        <p style="font-size:12px;color:var(--muted);margin:0 0 12px">Configure thresholds for seven signals. When a live session crosses a threshold the bell badge increments and the alert appears in the status card. Five alerts use per-agent profiles so you can tune Claude Code, Copilot, and Codex independently; the daily cost threshold is a single global dollar figure across all agents.</p>
        <div class="glossary">
          <div class="glossary-item" style="flex-direction:column;gap:2px">
            <dt class="glossary-term">Daily Cost Threshold <span style="font-size:10px;font-weight:400;color:var(--muted)">(warning)</span></dt>
            <dd class="glossary-def" style="display:block">Fires when today's total estimated cost across all agents (UTC day) crosses the configured dollar threshold. Disabled by default. Default threshold: $20/day.</dd>
          </div>
          <div class="glossary-item" style="flex-direction:column;gap:2px">
            <dt class="glossary-term">Context Window Filling Up <span style="font-size:10px;font-weight:400;color:var(--muted)">(warning)</span></dt>
            <dd class="glossary-def" style="display:block">Fires when peak input tokens for a session reaches the per-agent threshold. Defaults: Claude Code 170K, Copilot 108K, Codex 340K. Adjust per agent or raise the shared baseline.</dd>
          </div>
          <div class="glossary-item" style="flex-direction:column;gap:2px">
            <dt class="glossary-term">Too Many Turns Per Session <span style="font-size:10px;font-weight:400;color:var(--muted)">(warning)</span></dt>
            <dd class="glossary-def" style="display:block">Fires when the LLM turn count reaches the per-agent threshold. High turn counts often indicate scope creep or a task that should be split. Default: 200 turns (adjustable per agent).</dd>
          </div>
          <div class="glossary-item" style="flex-direction:column;gap:2px">
            <dt class="glossary-term">Error Spike <span style="font-size:10px;font-weight:400;color:var(--muted)">(error)</span></dt>
            <dd class="glossary-def" style="display:block">Fires when the error count in a session reaches the per-agent threshold. A spike usually means the agent is stuck in a failure loop. Default: 5 errors (adjustable per agent).</dd>
          </div>
          <div class="glossary-item" style="flex-direction:column;gap:2px">
            <dt class="glossary-term">Long Active Session <span style="font-size:10px;font-weight:400;color:var(--muted)">(info)</span></dt>
            <dd class="glossary-def" style="display:block">Fires when active LLM/tool compute time exceeds the per-agent threshold. Idle time (waiting for you to respond) does not count. Default: 60 minutes (adjustable per agent).</dd>
          </div>
          <div class="glossary-item" style="flex-direction:column;gap:2px">
            <dt class="glossary-term">Zero Cache Utilization <span style="font-size:10px;font-weight:400;color:var(--muted)">(info)</span></dt>
            <dd class="glossary-def" style="display:block">Fires when a session above the token gate has 0% cache hit rate. A large uncached session is paying full price for every token. The gate prevents noise from small sessions. Default gate: 30K tokens (shared, adjustable).</dd>
          </div>
          <div class="glossary-item" style="flex-direction:column;gap:2px">
            <dt class="glossary-term">Identical Tool Repeat <span style="font-size:10px;font-weight:400;color:var(--muted)">(warning)</span></dt>
            <dd class="glossary-def" style="display:block">Fires when the same tool with identical arguments repeats beyond the per-agent threshold without a file change between repeats — a strong deadlock signal. Default: 5 repeats (adjustable per agent).</dd>
          </div>
        </div>

        <h4 id="help-automation" style={subHeadStyle}>Automation</h4>
        <p style="font-size:12px;color:var(--muted);margin:0 0 12px">Automations watch live sessions and fire a correction prompt when a session crosses a threshold — but TraceRoost never sends that prompt to the agent process itself; nothing pushes it in without something on the agent's side asking for it. There are three ways it reaches you, per automation, controlled by its <strong>Write prompts file</strong> toggle in Settings, plus an always-on MCP path: by default, a notification appears (VS Code warning notification, or an in-page notification in standalone/npx mode) with a <strong>Copy Prompt</strong> button — you copy it and paste it into the agent yourself. With <strong>Write prompts file</strong> enabled instead, TraceRoost appends the prompt to <code style={codeStyle}>traceroost-prompts-&#123;agent&#125;.md</code> in the workspace root rather than showing a notification; nothing reads that file back to the agent automatically — it only helps if you (or an instruction you've added to CLAUDE.md/AGENTS.md) has the agent check it. Third, the MCP tool <code style={codeStyle}>check_automation_triggers</code> (see <a href="#help-mcp">MCP</a>) lets an agent poll for its own triggers directly — but it always evaluates against TraceRoost's default thresholds, not any per-agent customization made here in Settings, since that customization lives only in the dashboard's browser storage. Each automation shown below can still be enabled per-agent with independent thresholds for Claude Code, Copilot, and Codex for the notification/file delivery paths.</p>
        <div class="glossary">
          <div class="glossary-item" style="flex-direction:column;gap:4px">
            <dt class="glossary-term">Context Compaction</dt>
            <dd class="glossary-def" style="display:block">Fires when a session's peak input tokens reaches the configured threshold. Sends a prompt asking the agent to summarize its context and compact before continuing. Helps avoid context-window overflows and keeps token cost in check. Default: 140K tokens.</dd>
          </div>
          <div class="glossary-item" style="flex-direction:column;gap:4px">
            <dt class="glossary-term">Loop Breaker</dt>
            <dd class="glossary-def" style="display:block">Fires when the same tool with identical arguments repeats beyond the threshold without a file change between repeats. Sends a prompt instructing the agent to stop and choose a different approach. A hard-stop backstop fires at 8 repeats regardless of configuration. Default: 3 repeats.</dd>
          </div>
          <div class="glossary-item" style="flex-direction:column;gap:4px">
            <dt class="glossary-term">Error Cascade Stop</dt>
            <dd class="glossary-def" style="display:block">Fires when a session hits its agent-specific consecutive-error streak. Sends a prompt instructing the agent to stop, diagnose the root cause, and change strategy before trying again. A hard-stop backstop fires at 8 consecutive errors regardless of configuration. Default: 3 consecutive errors.</dd>
          </div>
          <div class="glossary-item" style="flex-direction:column;gap:4px">
            <dt class="glossary-term">Turn Limit Wrap-up</dt>
            <dd class="glossary-def" style="display:block">Fires when a session reaches the agent-specific turn threshold. Sends a prompt asking the agent to summarize progress, merge check-in details, and work toward a clean stopping point before hitting the model's hard turn limit. Default: 120 turns.</dd>
          </div>
        </div>

        <h4 id="help-clear-all" style={subHeadStyle}>Clear All Data</h4>
        <p style="font-size:12px;color:var(--muted);margin:0 0 12px">This button only deletes what TraceRoost itself has stored — its local database/cache of parsed sessions. It does <strong>not</strong> touch the source files it read those sessions from: OTEL-captured sessions are removed permanently, but log-sourced sessions (Claude Code, Codex, Copilot JSONL logs, OpenCode's SQLite database) are re-read from those local log files and will reappear on the next scan. TraceRoost currently has no feature to delete the underlying log files themselves — if you want those gone too, remove or rotate them yourself outside TraceRoost (e.g. in <code style={codeStyle}>~/.claude/</code>, <code style={codeStyle}>~/.codex/</code>, <code style={codeStyle}>~/.copilot/</code>).</p>
      </div>
    </div>
  )
}

function McpSection() {
  const standalone = window.__STANDALONE__ === true
  const mcpUrl = 'http://localhost:4316/mcp'
  const settingsJson = JSON.stringify({ mcpServers: { traceroost: { url: mcpUrl } } }, null, 2)
  const claudeMd = `# TraceRoost MCP
Before any task: call get_recent_sessions (recent work + cost) and get_workspace_patterns (hot files, recurring issues).
Only use find_relevant_context if your task closely matches past prompts by keyword — skip it for novel tasks.`

  return (
    <div class="help-section" id="help-mcp">
      <h3 class="help-heading">{HELP_SECTIONS.mcp.heading}</h3>
      <div class="help-overview-body">
        <p>TraceRoost runs an MCP server that gives Claude Code direct access to your session history. Instead of checking the dashboard yourself, Claude can query its own past work — loading the files it usually needs before making its first tool call, estimating what a task will cost, and flagging patterns that have caused problems before.</p>

        <h4 style={subHeadStyle}>Step 1 — Confirm the MCP server is running</h4>
        <p style={mutedP}>
          {standalone
            ? <>The standalone server starts a dedicated MCP server on port 4316 automatically — no extra setup needed. Endpoint: <a href={mcpUrl} target="_blank" rel="noreferrer" style={codeStyle}>{mcpUrl}</a>.</>
            : <>The VS Code extension starts an MCP server on port 4316 by default when TraceRoost activates. To disable it, set <code style={codeStyle}>traceRoost.enableMcpServer</code> to <code style={codeStyle}>false</code> in VS Code settings. To change the port, set <code style={codeStyle}>traceRoost.mcpPort</code>.</>
          }
        </p>
        <p style={mutedP}>Verify it's up by opening <a href={mcpUrl} target="_blank" rel="noreferrer" style={codeStyle}>{mcpUrl}</a> in a browser — you should see <code style={codeStyle}>{`{"status":"ok","server":"traceroost-mcp",...}`}</code>. If the page doesn't load, the server isn't running.</p>

        <h4 style={subHeadStyle}>Step 2 — Configure Claude Code</h4>
        <p style={mutedP}>Add the following to <code style={codeStyle}>~/.claude/settings.json</code> (create the file if it doesn't exist):</p>
        <pre style={preStyle}>{settingsJson}</pre>
        <p style={mutedP}>If you use the VS Code extension, the <code style={codeStyle}>contributes.mcpServers</code> entry in TraceRoost's manifest may configure this automatically — check your Claude Code MCP settings to confirm.</p>

        <h4 style={subHeadStyle}>Step 3 — Add to CLAUDE.md (optional but recommended)</h4>
        <p style={mutedP}>Add a block like this to your project's <code style={codeStyle}>CLAUDE.md</code> so Claude automatically uses TraceRoost at the start of each session. The block is intentionally brief — every line in CLAUDE.md is loaded into the context window on every call, so keeping it short avoids unnecessary token spend.</p>
        <pre style={preStyle}>{claudeMd}</pre>

        <h4 style={subHeadStyle}>Available tools</h4>
        <div class="glossary">
          <div class="glossary-item" style="flex-direction:column;gap:2px">
            <dt class="glossary-term"><code style={codeStyle}>get_recent_sessions</code></dt>
            <dd class="glossary-def" style="display:block">Returns recent session summaries sorted newest-first: cost, turn count, model, prompt excerpt, top tools used, and any loop signals triggered. Optional filters: <code style={codeStyle}>limit</code> (default 10), <code style={codeStyle}>agent</code> (copilot | claude_code | codex).</dd>
          </div>
          <div class="glossary-item" style="flex-direction:column;gap:2px">
            <dt class="glossary-term"><code style={codeStyle}>get_workspace_patterns</code></dt>
            <dd class="glossary-def" style="display:block">Aggregate patterns across all sessions: the files accessed most often (ranked by % of sessions), average cost and turn count, top tools, and recurring loop signal types. Optional filter: <code style={codeStyle}>days</code> to limit to recent sessions.</dd>
          </div>
          <div class="glossary-item" style="flex-direction:column;gap:2px">
            <dt class="glossary-term"><code style={codeStyle}>find_relevant_context</code></dt>
            <dd class="glossary-def" style="display:block">Given a <code style={codeStyle}>task</code> description, keyword-matches against past session prompts and returns: files accessed in similar sessions (with frequency %), estimated cost and turn count range, and known traps (loop signals that appeared in similar sessions). <strong>Important:</strong> matching is keyword-based, not semantic — results are reliable for well-established task types (e.g. "add auth", "fix sidebar tests") but often pull in unrelated sessions for novel or cross-cutting work. Treat file suggestions as a sanity check, not a reading list.</dd>
          </div>
          <div class="glossary-item" style="flex-direction:column;gap:2px">
            <dt class="glossary-term"><code style={codeStyle}>get_session_detail</code></dt>
            <dd class="glossary-def" style="display:block">Returns the full timeline for one session by <code style={codeStyle}>sessionId</code> — every LLM call and tool call with timing, errors, and file edits. Use <code style={codeStyle}>get_recent_sessions</code> first to get a session ID.</dd>
          </div>
          <div class="glossary-item" style="flex-direction:column;gap:2px">
            <dt class="glossary-term"><code style={codeStyle}>get_efficiency_report</code></dt>
            <dd class="glossary-def" style="display:block">Trend analysis over the last N days (default 30): cost trend (increasing/stable/decreasing), average cost and turns, error rate, agent/model ranking by cost efficiency, and most frequent loop signals with their occurrence rate.</dd>
          </div>
          <div class="glossary-item" style="flex-direction:column;gap:2px">
            <dt class="glossary-term"><code style={codeStyle}>get_instruction_suggestions</code></dt>
            <dd class="glossary-def" style="display:block">Returns pending Advisor suggestions for improving the agent instruction file (CLAUDE.md, AGENTS.md, etc.) for the specified workspace — the same ready-to-paste text shown in the Advisor tab's Instructions File section. Use at the start of a session to check for improvements before beginning work. Requires <code style={codeStyle}>workspace</code> (absolute path) — cross-workspace suggestions aren't meaningful.</dd>
          </div>
          <div class="glossary-item" style="flex-direction:column;gap:2px">
            <dt class="glossary-term"><code style={codeStyle}>check_automation_triggers</code></dt>
            <dd class="glossary-def" style="display:block">Checks the four built-in automations (Context Compaction, Loop Breaker, Error Cascade Stop, Turn Limit Wrap-up — see <a href="#help-automation">Automation</a> above) against the workspace's current in-progress, recently-active session(s), and returns any that are currently triggered with ready-to-use correction prompt text. Uses TraceRoost's default thresholds only, not per-agent customization made in Settings. Read-only and safe to call repeatedly — a given trigger is only returned once until its underlying condition changes, so an agent can poll this periodically during a long task as a self-check. Requires <code style={codeStyle}>workspace</code> (absolute path).</dd>
          </div>
        </div>

        <h4 style={subHeadStyle}>Example prompts</h4>
        <pre style={preStyle}>{`# Always useful — run these before any task:
Use traceroost get_recent_sessions to see what was worked on recently.
Use traceroost get_workspace_patterns to see recurring problems and known traps.

# Worth running when task keywords match established workflows:
Use traceroost find_relevant_context with task="add OAuth to the auth module"
to see what files similar sessions touched and what they typically cost.
(Skip this for new feature work — keyword matching won't find good matches.)

# To check efficiency trends over time:
Use traceroost get_efficiency_report to see if sessions are getting more or
less expensive, and which loop signals keep recurring.

# Before starting work — check for open Advisor suggestions:
Use traceroost get_instruction_suggestions with workspace="/absolute/path/to/project"
to see pending instruction-file suggestions before beginning work.

# Periodically during a long task — self-check for stuck-agent patterns:
Use traceroost check_automation_triggers with workspace="/absolute/path/to/project"
and follow any correction prompt it returns before continuing.`}</pre>

      </div>
    </div>
  )
}

function ExportSection() {
  return (
    <div class="help-section" id="help-export">
      <h3 class="help-heading">{HELP_SECTIONS.export.heading}</h3>
      <div class="help-overview-body">
        <p>The Export tab lets you download sessions as JSON, CSV, or Markdown. Exports respect all active filters — agent, source, time range, and text search — so what you export matches exactly what you see in the Sessions tab.</p>
        <div class="glossary">
          <div class="glossary-item" style="flex-direction:column;gap:4px">
            <dt class="glossary-term">Full export</dt>
            <dd class="glossary-def" style="display:block">Includes all session data — prompt text, tool arguments, tool results, and file diff content. Use this for personal analysis or sharing with yourself across machines.</dd>
          </div>
          <div class="glossary-item" style="flex-direction:column;gap:4px">
            <dt class="glossary-term">Redacted export</dt>
            <dd class="glossary-def" style="display:block">Prompt text is removed; all other fields (tokens, cost, timing, tool names, file paths, span structure) are retained. Use this when sharing data for debugging or support without exposing conversation content.</dd>
          </div>
          <div class="glossary-item" style="flex-direction:column;gap:4px">
            <dt class="glossary-term">Format: JSON</dt>
            <dd class="glossary-def" style="display:block">Full-fidelity structured export. The only format the Import tab reads back in — use this if you plan to bring the data into TraceRoost on another machine.</dd>
          </div>
          <div class="glossary-item" style="flex-direction:column;gap:4px">
            <dt class="glossary-term">Format: CSV</dt>
            <dd class="glossary-def" style="display:block">One row per session, for spreadsheets. Array/object fields (models, files, tool counts, loop signals) are flattened into semicolon-joined cells.</dd>
          </div>
          <div class="glossary-item" style="flex-direction:column;gap:4px">
            <dt class="glossary-term">Format: Markdown</dt>
            <dd class="glossary-def" style="display:block">One readable section per session — for sharing a report rather than raw data.</dd>
          </div>
        </div>
        <p style="font-size:12px;color:var(--muted);margin-top:12px">Raw OTEL span export for session replay is planned but not yet available.</p>
      </div>
    </div>
  )
}

function ImportSection() {
  return (
    <div class="help-section" id="help-import">
      <h3 class="help-heading">{HELP_SECTIONS.import.heading}</h3>
      <div class="help-overview-body">
        <p>The Import tab loads sessions from a previous TraceRoost <strong>JSON</strong> export back into the current installation — useful for migrating to a new machine, sharing session history with a teammate, or restoring a backup. Works the same way in both the VS Code extension and standalone server.</p>
        <div class="glossary">
          <div class="glossary-item" style="flex-direction:column;gap:4px">
            <dt class="glossary-term">Loading a file</dt>
            <dd class="glossary-def" style="display:block">Drag and drop an <code style={codeStyle}>export_sessions_*.json</code> file onto the drop zone, or click to browse. Only JSON is accepted — CSV and Markdown exports are one-way and can't be read back in.</dd>
          </div>
          <div class="glossary-item" style="flex-direction:column;gap:4px">
            <dt class="glossary-term">Validation</dt>
            <dd class="glossary-def" style="display:block">The file must parse as a non-empty JSON array where every item has a string <code style={codeStyle}>sessionId</code> and a recognized <code style={codeStyle}>source</code> (Copilot, Claude Code, Codex, or OpenCode) — anything else is rejected before you see a preview, with a specific error message. Other fields are read permissively: a technically-valid file with missing or malformed data elsewhere still imports, just with those fields defaulted rather than erroring.</dd>
          </div>
          <div class="glossary-item" style="flex-direction:column;gap:4px">
            <dt class="glossary-term">Preview</dt>
            <dd class="glossary-def" style="display:block">Before anything is written, shows the file name and size, total session count, a breakdown by agent source, and the date range covered — so you can confirm it's the right file before committing.</dd>
          </div>
          <div class="glossary-item" style="flex-direction:column;gap:4px">
            <dt class="glossary-term">Deduplication</dt>
            <dd class="glossary-def" style="display:block">Sessions already present (matched by session ID) are skipped automatically, not overwritten or duplicated — safe to re-import the same file, or a superset of a previous import.</dd>
          </div>
          <div class="glossary-item" style="flex-direction:column;gap:4px">
            <dt class="glossary-term">Batch progress</dt>
            <dd class="glossary-def" style="display:block">Large imports (200+ sessions) process in batches of 50 with a live progress bar rather than blocking on one write. The done screen reports how many were imported vs. skipped as duplicates.</dd>
          </div>
        </div>
      </div>
    </div>
  )
}

function BadgesSection() {
  const badgeStyle = 'font-size:9px;font-weight:600;padding:1px 5px;border-radius:2px;border:1px solid;letter-spacing:0.03em;vertical-align:middle;display:inline-block;margin-right:6px'
  return (
    <div class="help-section" id="help-badges">
      <h3 class="help-heading">{HELP_SECTIONS.badges.heading}</h3>
      <p style="font-size:12px;color:var(--muted);margin:0 0 12px">Each session row shows up to two small badges indicating where the data came from and who initiated the session.</p>

      <h4 style="font-size:11px;font-weight:600;color:var(--fg);margin:0 0 8px">Data source</h4>
      <div class="glossary" style="margin-bottom:16px">
        <div class="glossary-item">
          <dt class="glossary-term" style="min-width:0">
            <span style={`${badgeStyle}color:#ffffff;border-color:#ffffff`}>OTEL</span>
          </dt>
          <dd class="glossary-def">Full OpenTelemetry telemetry — timing, TTFT, span waterfall, loop signals. Requires the agent to be configured to export traces to TraceRoost.</dd>
        </div>
        <div class="glossary-item">
          <dt class="glossary-term" style="min-width:0">
            <span style={`${badgeStyle}color:#90a4ae;border-color:#90a4ae`}>Log</span>
          </dt>
          <dd class="glossary-def">Parsed from local session files and databases — <code>~/.claude/projects</code>, <code>~/.codex/sessions</code>, <code>~/.copilot/session-state</code>, and OpenCode's SQLite database at <code>~/.local/share/opencode/</code>. Tokens, tool calls, file paths, and user prompts are available. Timing and TTFT are not available from log sources. No agent configuration needed.</dd>
        </div>
      </div>

      <h4 style="font-size:11px;font-weight:600;color:var(--fg);margin:0 0 8px">Initiator</h4>
      <div class="glossary" style="margin-bottom:8px">
        <div class="glossary-item">
          <dt class="glossary-term" style="min-width:0">
            <span style={`${badgeStyle}color:#4a90d9;border-color:#4a90d9`}>User</span>
          </dt>
          <dd class="glossary-def">A human typed this prompt directly in the chat. The baseline case — most of your interactive sessions will carry this badge.</dd>
        </div>
        <div class="glossary-item">
          <dt class="glossary-term" style="min-width:0">
            <span style={`${badgeStyle}color:#b0bec5;border-color:#b0bec5`}>Agent</span>
          </dt>
          <dd class="glossary-def">Spawned by the Agent tool (<code>isSidechain: true</code> in the log). Claude delegated a sub-task to another Claude instance — common when using the Agent SDK or the FleetView multi-agent runner. The prompt was written by the model, not a human.</dd>
        </div>
        <div class="glossary-item">
          <dt class="glossary-term" style="min-width:0">
            <span style={`${badgeStyle}color:#90a4ae;border-color:#90a4ae`}>API</span>
          </dt>
          <dd class="glossary-def">Started non-interactively via <code>claude -p</code> (pipeline mode). Comes from a script, CI job, or shell automation — human-authored but not a live conversation. Identified by the <code>&lt;local-command-caveat&gt;</code> prefix Claude Code prepends to the prompt.</dd>
        </div>
      </div>
      <p style="font-size:11px;color:var(--muted);margin:0">Use the <strong>From</strong> filter pills in the Sessions tab to show only user, agent, or api sessions.</p>
    </div>
  )
}

function GlossarySection() {
  return (
    <div class="help-section" id="help-glossary">
      <h3 class="help-heading">{HELP_SECTIONS.glossary.heading}</h3>
      <div class="glossary">
        {TERMS.map(([term, def]) => (
          <div class="glossary-item" id={'gl-' + term.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')} style="scroll-margin-top:44px">
            <dt class="glossary-term">{term}</dt>
            <dd class="glossary-def">{def}</dd>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Main export ───────────────────────────────────────────────────────────────

export function Help() {
  return (
    <div id="help-content" style="display:flex;align-items:flex-start;gap:20px">
      <Toc />
      <div style="flex:1;min-width:0">
        <OverviewSection />
        <ConfigSection />
        <AgentOtelSection />
        <SessionsSection />
        <AnalyticsSection />
        <PatternsSection />
        <CostSection />
        <SettingsSection />
        <McpSection />
        <ExportSection />
        <ImportSection />
        <BadgesSection />
        <GlossarySection />
        <p style="font-size:11px;color:var(--muted);margin-top:24px;padding-top:12px;border-top:1px solid var(--border);line-height:1.6">
          <strong>Disclaimer:</strong> TraceRoost is an independent open-source project and is not affiliated with, endorsed by, or associated with GitHub, Inc. or Microsoft Corporation (GitHub Copilot); Anthropic, PBC (Claude / Claude Code); or OpenAI, LLC (Codex / Codex CLI). All product names, trademarks, and registered trademarks are the property of their respective owners. TraceRoost interacts with these products solely through their publicly documented OpenTelemetry telemetry interfaces.
        </p>
      </div>
    </div>
  )
}
