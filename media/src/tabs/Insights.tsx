import { useState } from 'preact/hooks'
import clsx from 'clsx'
import { filteredSessions, sessionSummary, insightFilter, ignoredInsightKeys } from '../state'
import { buildDisplaySummary, getAgentColor, getAgentSourceLabel, getSessionGlobalNumber, formatSessionTime } from '../utils'
import type { Insight, InsightFilter, SessionSummaryCard } from '../types'

type EffSummary = ReturnType<typeof buildDisplaySummary>['efficiency']

type InsightTakeaways = {
  loopCount: number
  hasContextBloat: boolean
  hasCacheIssue: boolean
  hasToolIssue: boolean
  hasRepeatedOperations: boolean
}

function insightScopeLabel(filter: InsightFilter): string {
  if (filter === 'loop') return 'loop insights'
  if (filter === 'efficiency') return 'efficiency insights'
  return 'insights'
}

function noActiveTakeawayText(filter: InsightFilter): string {
  if (filter === 'loop') return 'No active loop or malfunction signals in this view.'
  if (filter === 'efficiency') return 'No active efficiency issues in this view.'
  return 'No significant inefficiencies detected. Token usage looks healthy.'
}

// Promoted to the backend taxonomy (src/loopDetector.ts) — matched by _loopType here rather than
// title text, since their titles are now "patternName — evidence" instead of the old ad-hoc
// "N tool failure(s)" / "Large tool results" wording that the title-matching below used to catch.
const TOOL_ISSUE_LOOP_TYPES = new Set(['chronic_tool_failures', 'context_flooding_risk', 'malformed_tool_call'])

function summarizeTakeaways(insights: Insight[]): InsightTakeaways {
  const summary: InsightTakeaways = {
    loopCount: 0,
    hasContextBloat: false,
    hasCacheIssue: false,
    hasToolIssue: false,
    hasRepeatedOperations: false,
  }

  for (const insight of insights) {
    const title = insight.title.toLowerCase()
    if (insight.category === 'loop') summary.loopCount++
    if (title.includes('context grew') || title.includes('starts with')) summary.hasContextBloat = true
    if (title.includes('cache hit')) summary.hasCacheIssue = true
    if (title.includes('tool definitions') || (insight._loopType && TOOL_ISSUE_LOOP_TYPES.has(insight._loopType))) summary.hasToolIssue = true
    if (title.includes('files read multiple') || title.includes('duplicate searches') || title.includes('files appear')) summary.hasRepeatedOperations = true
  }

  return summary
}

// ── Why-this-matters tooltips (shown on ⓘ next to Recommendation label) ──────

const HELP_WHY: Record<string, string> = {
  'help-context-bloat':        'Every LLM turn receives the full conversation so far. Each extra token in context multiplies cost across every remaining turn — a 10K growth in one trace can mean 50K+ extra tokens billed.',
  'help-large-context':        'Instruction files are sent on every LLM call in every trace. 10,000 extra tokens in CLAUDE.md = 10,000 extra tokens per call, forever, regardless of task size.',
  'help-files-repeated':       'Each re-read appends the full file to context again. Re-reading a 500-line file 4 times wastes ~2,000 tokens on every subsequent call in that trace.',
  'help-high-turns':           'Each additional LLM call costs tokens and time. Iterative discovery is ~10× more expensive than providing the same context upfront in the initial prompt.',
  'help-duplicate-searches':   'Repeated searches append identical results to context without progress. The growing context also makes the model more likely to repeat the search again.',
  'help-tool-failures':        'Each failure adds error text to context and forces a recovery turn. A cascade of 3 failures can waste 30,000+ tokens before a single useful edit is made.',
  'help-large-results':        'Tool results are appended to context in full. A 50 KB file read adds ~12,500 tokens to every subsequent call in that trace — not just the call that read it.',
  'help-tool-overhead':        'Every LLM call includes all tool JSON schemas. 70+ tools = 8,000–15,000 overhead tokens per call that cannot be reduced by shortening your prompt.',
  'help-cache-rate':           'Cached tokens cost roughly 10× less than fresh tokens. Going from 0% to 60% cache hit rate cuts trace cost by 80–90% with no change to model behavior.',
  'help-tool-deadlock':        'The agent is burning tokens repeating identical calls with zero progress. This loop runs until the context limit is hit — entire trace cost with nothing accomplished.',
  'help-state-spiral':         'Conflicting constraints cause the agent to undo its own work. Each oscillation adds both the edit and the revert to context, accelerating cost with each cycle.',
  'help-hallucination':        'Each failed fix attempt adds the error to context, which anchors the model further from the real solution — the longer it runs, the harder it self-corrects.',
  'help-runaway-steps':        'Scope creep compounds: each extra step the agent takes grows context for all future steps. 90-step traces can cost 10–20× a well-scoped 5-step equivalent.',
  'help-context-accumulation': 'Input tokens are growing while output shrinks — cost per call is compounding with diminishing returns. Continuing will likely hit the context limit with nothing saved.',
  'help-chronic-tool-unreliability': 'Each failure adds error text to context and forces a recovery turn. A cascade of 3 failures can waste 30,000+ tokens before a single useful edit is made.',
  'help-context-flooding-risk': 'Tool results are appended to context in full. A 50 KB file read adds ~12,500 tokens to every subsequent call in that trace — not just the call that read it.',
  'help-malformed-tool-call':  'A rejected call means the round-trip to the model happened for nothing — no result, just an error to recover from. Unlike a runtime failure, this is unambiguously the agent\'s call not matching what the tool expected.',
}

// ── Insight generation ────────────────────────────────────────────────────────

export function generateInsights(
  summary: { sessions: SessionSummaryCard[]; efficiency: EffSummary },
  allSessions?: SessionSummaryCard[],
): Insight[] {
  const insights: Insight[] = []
  const { sessions, efficiency: eff } = summary

  if (!sessions.length) return insights

  // ── Per-session insights ────────────────────────────────────────────────────

  sessions.forEach((sess, idx) => {
    const llmEntries = (sess.timeline ?? []).filter(e => e.type === 'llm' && (e.inputTokens ?? 0) > 0)
    const globalNum = getSessionGlobalNumber(sess) || (idx + 1)
    const reqSnippet = (sess.userRequest ?? '').slice(0, 60)

    // Context growth
    if (llmEntries.length >= 3) {
      const first = llmEntries[0].inputTokens ?? 0
      const last = llmEntries[llmEntries.length - 1].inputTokens ?? 0
      const growth = last - first
      const growthPct = first > 0 ? (growth / first) * 100 : 0
      if (growthPct > 20 && growth > 2000) {
        insights.push({
          severity: 'warning', category: 'efficiency', sessionIdx: idx,
          helpId: 'help-context-bloat',
          title: '[Trace ' + globalNum + '] Context grew ' + growthPct.toFixed(0) + '%',
          detail: 'Input tokens grew from ' + first.toLocaleString() + ' to ' + last.toLocaleString()
            + ' (+' + growth.toLocaleString() + ' tokens) across ' + llmEntries.length + ' LLM calls'
            + (reqSnippet ? ' for "' + reqSnippet + '"' : '') + '.',
          action: 'The first call used ' + first.toLocaleString() + ' tokens — audit your instruction files '
            + '(CLAUDE.md, .agent.md, system prompt). Remove verbose examples and anything the agent '
            + 'can discover via tools. Target <5,000 tokens for combined static instructions.',
        })
      }
    }

    // Files read multiple times
    const fileReads: Record<string, number> = {}
    ;(sess.timeline ?? []).forEach(e => {
      if (e.type !== 'tool') return
      const m = (e.label ?? '').match(/^read_file\s+(\S+)/)
      if (m) fileReads[m[1]] = (fileReads[m[1]] ?? 0) + 1
    })
    const repeats = Object.keys(fileReads).filter(f => fileReads[f] > 1)
    if (repeats.length > 0) {
      const topFile = repeats.sort((a, b) => fileReads[b] - fileReads[a])[0]
      insights.push({
        severity: 'info', category: 'efficiency', sessionIdx: idx,
        helpId: 'help-files-repeated',
        title: '[Trace ' + globalNum + '] Files read multiple times',
        detail: repeats.map(f => f + ' (' + fileReads[f] + '×)').join(', ') + '.',
        action: repeats.length === 1
          ? 'The agent read ' + topFile + ' ' + fileReads[topFile] + ' times. '
            + 'Mention its path explicitly at the start of your prompt so the agent finds it without re-reading.'
          : 'The agent re-read ' + repeats.length + ' files, most often ' + topFile + ' (' + fileReads[topFile] + '×). '
            + 'Try opening with the key paths listed: e.g. "The main files are: ' + repeats.slice(0, 2).join(', ') + '".',
      })
    }

    // High LLM call count
    if (sess.totalLlmCalls > 8 && (sess.userRequest ?? '').length < 80) {
      const topTools = Object.entries(sess.toolCounts ?? {})
        .sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([t, n]) => t + ' ×' + n).join(', ')
      insights.push({
        severity: 'info', category: 'efficiency', sessionIdx: idx,
        helpId: 'help-high-turns',
        title: '[Trace ' + globalNum + '] ' + sess.totalLlmCalls + ' LLM calls',
        detail: '"' + reqSnippet + '" required ' + sess.totalLlmCalls + ' LLM calls and '
          + sess.totalToolCalls + ' tool calls' + (topTools ? ' (' + topTools + ')' : '') + '.',
        action: 'For ' + sess.totalLlmCalls + '-turn trace, break the task into smaller pieces with '
          + 'explicit stopping conditions. Provide specific file paths and line numbers so the agent '
          + 'spends turns doing instead of exploring.',
      })
    }

    // Oversized starting context
    const firstLlm = (sess.timeline ?? []).find(e => e.type === 'llm' && (e.inputTokens ?? 0) > 0)
    if (firstLlm && (firstLlm.inputTokens ?? 0) > 15000) {
      insights.push({
        severity: 'warning', category: 'efficiency', sessionIdx: idx,
        helpId: 'help-large-context',
        title: '[Trace ' + globalNum + '] Starts with ' + (firstLlm.inputTokens ?? 0).toLocaleString() + ' input tokens',
        detail: 'The very first LLM call already has ' + (firstLlm.inputTokens ?? 0).toLocaleString()
          + ' tokens before any tool results are added.',
        action: 'Audit your instruction files — ' + (firstLlm.inputTokens ?? 0).toLocaleString()
          + ' tokens before the first tool call is the baseline overhead. Remove verbose examples '
          + 'and information the agent can discover via tools. Target <5,000 tokens for combined instructions.',
      })
    }

    // Duplicate searches
    const searches: Record<string, number> = {}
    ;(sess.timeline ?? []).forEach(e => {
      if (e.type !== 'tool') return
      const m = (e.label ?? '').match(/^(grep_search|file_search)\s+(.+)$/)
      if (m) { const key = m[1] + ':' + m[2].replace(/\s+/g, ' ').trim(); searches[key] = (searches[key] ?? 0) + 1 }
    })
    const dupes = Object.keys(searches).filter(k => searches[k] > 1)
    if (dupes.length > 0) {
      const examples = dupes.slice(0, 2).map(d => {
        const [, pattern] = d.split(':')
        return '"' + pattern?.trim().slice(0, 40) + '"'
      })
      insights.push({
        severity: 'info', category: 'efficiency', sessionIdx: idx,
        helpId: 'help-duplicate-searches',
        title: '[Trace ' + globalNum + '] Duplicate searches',
        detail: dupes.length + ' search pattern(s) repeated: ' + examples.join(', ') + '.',
        action: 'These repeated searches suggest the agent was uncertain where to look. '
          + 'Include directory names or specific file paths in your prompt — e.g. '
          + '"search in src/api/" instead of a broad pattern.',
      })
    }

    // Loop signals — includes chronic_tool_failures and context_flooding_risk, which used to be
    // computed here as separate ad-hoc "Tool failures" / "Large tool results" checks. Promoted
    // into the shared backend taxonomy (src/loopDetector.ts) so MCP tools and the Instruction
    // Advisor's cross-session aggregation can see them too, not just this tab — removed the
    // duplicate local computation rather than compute the same thing twice.
    const loopHelpIds: Record<string, string> = {
      exact_tool_repeat:  'help-tool-deadlock',
      edit_revert_cycle:  'help-state-spiral',
      error_recurrence:   'help-hallucination',
      runaway_steps:      'help-runaway-steps',
      token_runaway:      'help-context-accumulation',
      chronic_tool_failures: 'help-chronic-tool-unreliability',
      context_flooding_risk: 'help-context-flooding-risk',
      malformed_tool_call:   'help-malformed-tool-call',
    }
    ;(sess.loopSignals ?? []).forEach(sig => {
      const examplesText = sig.examples?.length > 0 ? '\n\nExamples: ' + sig.examples.join(' · ') : ''
      insights.push({
        severity: ('loop-' + sig.severity) as Insight['severity'],
        category: 'loop', sessionIdx: idx,
        helpId: loopHelpIds[sig.type],
        title: '[Trace ' + globalNum + '] ' + sig.patternName + ' — ' + sig.evidence,
        detail: examplesText.trim(),
        action: sig.action ?? sig.evidence,
        _loopType: sig.type,
      })
    })
  })

  // ── Cross-session insights ──────────────────────────────────────────────────

  const crossSessions = allSessions ?? sessions
  if (crossSessions.length >= 3) {
    // Files correlated with agent difficulties
    const fileStats: Record<string, { total: number; problems: number }> = {}
    for (const sess of crossSessions) {
      const hasProblems = (sess.errors ?? 0) > 0 || (sess.loopSignals?.length ?? 0) > 0
      const files = [...new Set([...sess.filesRead, ...sess.filesChanged, ...sess.filesSearched])]
      for (const f of files) {
        if (!fileStats[f]) fileStats[f] = { total: 0, problems: 0 }
        fileStats[f].total++
        if (hasProblems) fileStats[f].problems++
      }
    }
    const troubleFiles = Object.entries(fileStats)
      .filter(([, v]) => v.total >= 3 && v.problems / v.total >= 0.6)
      .sort((a, b) => b[1].problems - a[1].problems)
      .slice(0, 4)
    if (troubleFiles.length > 0) {
      const names = troubleFiles.map(([f]) => f.split('/').pop() || f)
      insights.push({
        severity: 'warning', category: 'efficiency',
        helpId: 'help-files-repeated',
        title: troubleFiles.length + ' file(s) appear in most traces with errors or loops',
        detail: troubleFiles.map(([f, v]) =>
          (f.split('/').pop() || f) + ': ' + v.problems + '/' + v.total + ' traces had issues'
        ).join('\n'),
        action: 'These files appear frequently alongside agent difficulties: ' + names.join(', ') + '. '
          + 'They may have conflicting constraints, be poorly documented for the agent, or be referenced '
          + 'with inconsistent paths. Consider adding a brief description of their role to your '
          + 'instruction files so the agent has reliable context before touching them.',
      })
    }

    // Cache hit rate trend
    const recentN = Math.min(crossSessions.length, 8)
    const recent = crossSessions.slice(-recentN)
    const older = crossSessions.slice(0, -recentN)
    if (older.length >= 3) {
      const avgRecent = recent.reduce((s, sess) => s + sess.cacheHitRate, 0) / recent.length
      const avgOlder = older.reduce((s, sess) => s + sess.cacheHitRate, 0) / older.length
      const drop = avgOlder - avgRecent
      if (drop > 0.15 && avgOlder > 0.3) {
        insights.push({
          severity: 'warning', category: 'efficiency',
          helpId: 'help-cache-rate',
          title: 'Cache hit rate declining — ' + (avgOlder * 100).toFixed(0) + '% → ' + (avgRecent * 100).toFixed(0) + '%',
          detail: 'Average cache hit rate dropped ' + (drop * 100).toFixed(0)
            + '% over your last ' + recentN + ' traces.',
          action: 'Cache hit rate drops when the stable prefix of your prompts changes. '
            + 'Recent changes to your instruction files (CLAUDE.md, .agent.md, system prompt) '
            + 'may be invalidating cached context. Keep static content at the top of prompts '
            + 'and avoid putting dynamic data (timestamps, file counts) in instructions.',
        })
      }
    }
  }

  // ── Global efficiency insights ──────────────────────────────────────────────

  if (eff.toolDefWaste > 0.25) {
    insights.push({
      severity: 'warning', category: 'efficiency',
      helpId: 'help-tool-overhead',
      title: 'Tool definitions consuming ~' + (eff.toolDefWaste * 100).toFixed(0) + '% of context',
      detail: 'A significant portion of each prompt is spent describing available tool schemas to the model.',
      action: 'Use tool restrictions in your .agent.md files with "tools:" to limit which tools are available.',
    })
  }

  if (eff.totalLlmCalls > 3 && eff.cacheHitRate < 0.5) {
    insights.push({
      severity: 'warning', category: 'efficiency',
      helpId: 'help-cache-rate',
      title: 'Low prompt cache hit rate (' + (eff.cacheHitRate * 100).toFixed(0) + '%)',
      detail: 'Less than half of input tokens are being served from cache.',
      action: 'Cache works best when the beginning of the prompt stays stable across turns. Keep static content at the top of your prompts.',
    })
  }

  const severityOrder: Record<string, number> = { 'loop-critical': 0, 'loop-warning': 1, 'warning': 2, 'info': 3 }
  insights.sort((a, b) => {
    const aIdx = a.sessionIdx ?? -1, bIdx = b.sessionIdx ?? -1
    if (aIdx !== bIdx) return bIdx - aIdx
    return (severityOrder[a.severity] ?? 4) - (severityOrder[b.severity] ?? 4)
  })

  return insights
}

// ── InsightCard ───────────────────────────────────────────────────────────────

export function InsightCard({ ins, isIgnored, sessions }: { ins: Insight; isIgnored: boolean; sessions: SessionSummaryCard[] }) {
  const icon = ins.severity.startsWith('loop') ? '↺' : ins.severity === 'warning' ? '⚠' : 'ℹ'
  const session = ins.sessionIdx !== undefined ? sessions[ins.sessionIdx] : undefined
  const titleTraceMatch = ins.title.match(/^\[Trace\s+\d+\]\s*(.*)$/)
  const insightTitle = titleTraceMatch ? titleTraceMatch[1] : ins.title
  const sessionAgentColor = session ? getAgentColor(session.source) : ''
  const sessionTimestamp = session ? formatSessionTime(session) : ''
  const sessionPrompt = session?.userRequest || ''
  const [copied, setCopied] = useState(false)

  function buildAiPrompt(): string {
    const lines: string[] = [ins.title, '']
    if (session?.userRequest && session.userRequest !== '[trace in progress]') {
      lines.push('Task: "' + session.userRequest + '"', '')
    }
    if (ins.detail) lines.push(ins.detail, '')
    if (session) {
      const topTools = Object.entries(session.toolCounts ?? {})
        .sort((a, b) => b[1] - a[1]).slice(0, 5)
        .map(([t, n]) => '  ' + t + ' ×' + n).join('\n')
      if (topTools) lines.push('Top tools used:\n' + topTools, '')
      if (session.filesChanged.length > 0)
        lines.push('Files changed: ' + session.filesChanged.slice(0, 5).join(', '), '')
      const errors = session.timeline.filter(e => e.isError && e.errorMessage).slice(0, 3)
      if (errors.length > 0)
        lines.push('Error messages:\n' + errors.map(e => '  - ' + (e.errorMessage ?? '').slice(0, 120)).join('\n'), '')
      lines.push('Trace stats: ' + session.totalLlmCalls + ' LLM calls, '
        + session.totalToolCalls + ' tool calls, '
        + (session.cacheHitRate * 100).toFixed(0) + '% cache hit rate', '')
    }
    lines.push('Action: ' + ins.action)
    return lines.join('\n')
  }

  function buildClipboardPrompt(): string {
    const lines: string[] = [
      "I'm using an AI coding agent and the following issue was detected in my trace.",
      'Please explain what\'s happening and suggest specific improvements to my workflow or prompt.',
      '',
      '--- Trace context ---',
    ]
    if (session) {
      lines.push('Session ID: ' + session.sessionId)
      lines.push(sessionTimestamp + ' · ' + getAgentSourceLabel(session.source))
      if (session.userRequest && session.userRequest !== '[trace in progress]')
        lines.push('Task: "' + session.userRequest + '"')
    } else {
      lines.push('Across traces')
    }
    lines.push('', '--- Insight ---', insightTitle)
    if (ins.detail) lines.push('', ins.detail)
    if (session) {
      lines.push('', '--- Trace data ---')
      const topTools = Object.entries(session.toolCounts ?? {})
        .sort((a, b) => b[1] - a[1]).slice(0, 5)
        .map(([t, n]) => t + ' ×' + n).join(', ')
      if (topTools) lines.push('Top tools: ' + topTools)
      if (session.filesChanged.length > 0)
        lines.push('Files changed: ' + session.filesChanged.slice(0, 5).join(', '))
      const errors = session.timeline.filter(e => e.isError && e.errorMessage).slice(0, 3)
      if (errors.length > 0)
        lines.push('Errors:\n' + errors.map(e => '  - ' + (e.errorMessage ?? '').slice(0, 120)).join('\n'))
      lines.push('Stats: ' + session.totalLlmCalls + ' LLM calls · ' + session.totalToolCalls + ' tool calls · '
        + (session.cacheHitRate * 100).toFixed(0) + '% cache hit')
    }
    lines.push('', '--- Recommended action ---', ins.action)
    return lines.join('\n')
  }

  function handleCopy() {
    navigator.clipboard.writeText(buildClipboardPrompt()).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div class={clsx('insight-card', 'insight-' + ins.severity)} style={isIgnored ? 'opacity:0.55' : ''}>
      {/* Header: icon + title + ignore button */}
      <div class="insight-header" style="align-items:flex-start;margin-bottom:4px">
        <span class="insight-icon" style="margin-top:1px">{icon}</span>
        <span class="insight-title" style="flex:1">{insightTitle}</span>
        <button
          class="insight-ignore-btn"
          title="Copy prompt to clipboard"
          onClick={handleCopy}
          style={copied ? 'color:var(--accent)' : ''}
        >{copied ? '✓ Copied' : 'Copy'}</button>
        {isIgnored ? (
          <button class="insight-restore-btn" title="Restore" onClick={() => ignoredInsightKeys.delete(ins.title)}>Restore</button>
        ) : (
          <button class="insight-ignore-btn" title="Ignore" onClick={() => ignoredInsightKeys.add(ins.title)}>Ignore</button>
        )}
      </div>
      {/* Action */}
      <div class="insight-action" style="margin-bottom:8px">
        <span class="insight-action-label">
          Action
          {ins.helpId && HELP_WHY[ins.helpId] && (
            <span data-tip={HELP_WHY[ins.helpId]} style="margin-left:4px;cursor:help;opacity:0.55;font-size:11px">ⓘ</span>
          )}:
        </span>{' '}
        <span style="white-space:pre-wrap">{ins.action}</span>
      </div>
      {ins.detail && <div class="insight-detail" style="white-space:pre-wrap">{ins.detail}</div>}
    </div>
  )
}

function IgnoredSection({ insights, sessions }: { insights: Insight[]; sessions: SessionSummaryCard[] }) {
  const [open, setOpen] = useState(false)
  return (
    <div style="margin-top:12px">
      <h3
        style="margin:28px 0 12px;font-size:13px;color:var(--muted);display:flex;align-items:center;gap:8px;cursor:pointer"
        onClick={() => setOpen(v => !v)}
      >
        <span>{open ? '▼' : '▶'}</span>
        IGNORED ({insights.length})
      </h3>
      {open && insights.map(ins => <InsightCard key={ins.title} ins={ins} isIgnored={true} sessions={sessions} />)}
    </div>
  )
}

// ── Insights panel ───────────────────────────────────────────────────────────

export function Insights() {
  const filter = insightFilter.value
  const ignored = ignoredInsightKeys.value
  const allSessions = filteredSessions.value
  const hasAny = (sessionSummary.value?.sessions?.length ?? 0) > 0

  if (!allSessions.length) {
    return <div id="insights-content"><div class="empty-state">{hasAny ? 'No traces match the active filters.' : 'No traces recorded yet.'}</div></div>
  }

  const displaySummary = buildDisplaySummary(allSessions)
  const allInsights = generateInsights(displaySummary, allSessions)

  let loopCount = 0
  let effCount = 0
  const active: Insight[] = []
  const ignoredList: Insight[] = []

  for (const insight of allInsights) {
    const isIgnored = ignored.has(insight.title)
    if (!isIgnored) {
      if (insight.category === 'loop') loopCount++
      if (insight.category === 'efficiency') effCount++
    }
    if (filter === 'all' || insight.category === filter) {
      if (isIgnored) ignoredList.push(insight)
      else active.push(insight)
    }
  }

  const sessions = displaySummary.sessions
  const takeaways = summarizeTakeaways(active)
  const scopeLabel = insightScopeLabel(filter)

  return (
    <div id="insights-content">
      <div style="font-size:11px;color:var(--muted);padding:6px 10px;margin-bottom:12px;border-left:2px solid var(--border)">
        <strong>Insights are based on general heuristics and may include false positives. Review suggestions carefully and consider your specific context before making changes.</strong>
      </div>
      <div style="padding:12px 16px;margin:0 0 16px;border-radius:6px;border:1px solid var(--border);background:var(--vscode-editorWidget-background,var(--bg));font-size:12px">
        <div class="section-label">Key Takeaways</div>
        {active.length > 0 ? (
          <ul style="margin:0;padding:0 0 0 16px;list-style:disc">
            {takeaways.loopCount > 0 && (
              <li style="margin-bottom:2px">
                {takeaways.loopCount} agent loop or malfunction signal{takeaways.loopCount > 1 ? 's' : ''} detected
              </li>
            )}
            {takeaways.hasContextBloat && (
              <li style="margin-bottom:2px">Context bloat detected — input tokens growing significantly across turns</li>
            )}
            {takeaways.hasCacheIssue && (
              <li style="margin-bottom:2px">Low prompt cache hit rate — tokens are being re-processed instead of cached</li>
            )}
            {takeaways.hasToolIssue && (
              <li style="margin-bottom:2px">Tool inefficiency detected</li>
            )}
            {takeaways.hasRepeatedOperations && (
              <li style="margin-bottom:2px">Repeated file or search operations detected</li>
            )}
          </ul>
        ) : (
          <div style="color:var(--vscode-testing-iconPassed,#4caf50)">✓ {noActiveTakeawayText(filter)}</div>
        )}
      </div>
      <div class="insight-filter-bar">
        {([
          { key: 'all', label: 'All', badge: loopCount + effCount },
          { key: 'loop', label: 'Loops', badge: loopCount },
          { key: 'efficiency', label: 'Inefficiencies', badge: effCount },
        ] as Array<{ key: InsightFilter; label: string; badge: number }>).map(p => (
          <button
            key={p.key}
            class={clsx('insight-filter-pill', { active: filter === p.key })}
            onClick={() => { insightFilter.value = p.key }}
          >
            {p.label}
            {p.badge > 0 && <span class="insight-filter-badge">{p.badge}</span>}
          </button>
        ))}
      </div>

      {active.length > 0 ? (
        <>
          <div style="font-size:11px;color:var(--muted);margin-bottom:12px">
            {active.length} insight{active.length !== 1 ? 's' : ''}, newest traces first
          </div>
          {active.map(ins => <InsightCard key={ins.title} ins={ins} isIgnored={false} sessions={sessions} />)}
        </>
      ) : ignoredList.length > 0 ? (
        <div class="insight-card insight-success">
          <div class="insight-header"><span class="insight-icon">✓</span><span class="insight-title">All {scopeLabel} addressed or ignored</span></div>
          <div class="insight-detail">New ones will appear as your trace data changes.</div>
        </div>
      ) : (
        <div class="insight-card insight-success">
          <div class="insight-header"><span class="insight-icon">✓</span><span class="insight-title">No {scopeLabel} detected</span></div>
          <div class="insight-detail">Token usage, cache rates, and trace patterns look reasonable.</div>
        </div>
      )}

      {ignoredList.length > 0 && <IgnoredSection insights={ignoredList} sessions={sessions} />}
    </div>
  )
}
