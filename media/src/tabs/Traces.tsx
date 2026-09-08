import { useState, useEffect } from 'preact/hooks'
import {
  filteredSessions, sessionSummary, sessionTimelines, focusedSessionId, vscode,
} from '../state'
import {
  formatMs, formatCompact, syntaxHighlightJson,
  getAgentDotHtml, formatLlmLabel, formatToolLabel, formatToolResult,
  sessionDateKey, formatDayLabel, formatSessionTime,
} from '../utils'
import { calcEntryCost, fmtUsd } from '../sessionMetrics'
import type { SessionSummaryCard, TimelineEntry, BackgroundSpanSummary } from '../types'

export interface Step {
  entry: TimelineEntry
  offsetMs: number
  durationMs: number
}



function BgSummaryBlock({ bgSpans }: { bgSpans: BackgroundSpanSummary[] }) {
  const [open, setOpen] = useState(false)
  if (!bgSpans?.length) return null

  const groups: Record<string, { count: number; tokens: number; model: string }> = {}
  let totalTokens = 0
  bgSpans.forEach(bg => {
    const key = bg.purpose || bg.name || 'Unknown'
    if (!groups[key]) groups[key] = { count: 0, tokens: 0, model: bg.model || '' }
    groups[key].count++
    const tok = (bg.inputTokens ?? 0) + (bg.outputTokens ?? 0)
    groups[key].tokens += tok
    totalTokens += tok
  })

  const descriptions: Record<string, string> = {
    'Generate chat title': 'Creates the title shown in the chat history sidebar.',
    'Generate progress messages': 'Produces the status messages shown while the agent works.',
    'Extension language model call': 'LLM call made by a VS Code extension — often used for completions or inline suggestions.',
  }

  const purposes = Object.keys(groups).sort((a, b) => groups[b].tokens - groups[a].tokens)

  return (
    <div class="sw-bg-group">
      <div class="sw-bg-header" onClick={() => setOpen(v => !v)}>
        <span class="sw-bg-chevron">{open ? '▼' : '▶'}</span>{' '}
        <span>Background Overhead</span>
        <span class="sw-bg-summary">{bgSpans.length} calls · {totalTokens.toLocaleString()} tokens</span>
      </div>
      {open && (
        <div class="sw-bg-body">
          <div class="sw-bg-note">Automatic LLM calls that ran alongside this prompt. These are not part of your agent session but still consume tokens.</div>
          {purposes.map(purpose => (
            <div key={purpose} class="sw-bg-item">
              <div class="sw-bg-item-header">
                <span class="sw-bg-item-name">{purpose}</span>
                <span class="sw-bg-item-stats">{groups[purpose].count}× · {groups[purpose].tokens.toLocaleString()} tok · {groups[purpose].model}</span>
              </div>
              {descriptions[purpose] && <div class="sw-bg-item-desc">{descriptions[purpose]}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function StepDetail({ step, idx, sessIdx, sessionModel }: { step: Step; idx: number; sessIdx: number; sessionModel: string }) {
  const [showOutput, setShowOutput] = useState(false)
  const entry = step.entry

  if (entry.type === 'llm') {
    const PREVIEW_LEN = 400
    const isLongResponse = (entry.responseText?.length ?? 0) > PREVIEW_LEN
    const entryCost = calcEntryCost(entry, sessionModel)
    return (
      <>
        <div class="sw-detail-section"><div class="sw-detail-heading">Model</div><div class="sw-detail-value">{entry.model || 'unknown'}</div></div>
        {((entry.inputTokens ?? 0) > 0 || (entry.outputTokens ?? 0) > 0) && (
          <div class="sw-detail-section">
            <div class="sw-detail-heading">Token Usage</div>
            <div class="sw-detail-value">
              {(entry.cacheReadTokens ?? 0) > 0 || (entry.cacheCreateTokens ?? 0) > 0 ? (
                <>
                  <span class="sw-token-in">
                    {Math.max(0, (entry.inputTokens ?? 0) - (entry.cacheReadTokens ?? 0) - (entry.cacheCreateTokens ?? 0)).toLocaleString()} new
                    {(entry.cacheReadTokens ?? 0) > 0 && <span style="color:var(--muted)"> + {(entry.cacheReadTokens ?? 0).toLocaleString()} cached</span>}
                    {(entry.cacheCreateTokens ?? 0) > 0 && <span style="color:var(--muted)"> + {(entry.cacheCreateTokens ?? 0).toLocaleString()} cache write</span>}
                  </span>
                  <span class="sw-token-arrow"> → </span>
                  <span class="sw-token-out">{(entry.outputTokens ?? 0).toLocaleString()} output</span>
                </>
              ) : (
                <>
                  <span class="sw-token-in">{(entry.inputTokens ?? 0).toLocaleString()} input</span>
                  <span class="sw-token-arrow"> → </span>
                  <span class="sw-token-out">{(entry.outputTokens ?? 0).toLocaleString()} output</span>
                </>
              )}
            </div>
          </div>
        )}
        {entryCost > 0 && (
          <div class="sw-detail-section">
            <div class="sw-detail-heading">Cost</div>
            <div class="sw-detail-value">{fmtUsd(entryCost)}</div>
          </div>
        )}
        {entry.responseText && (
          <div class="sw-detail-section">
            <div class="sw-detail-heading">
              Response
              {isLongResponse && (
                <button class="sw-show-full-btn" style="margin-left:8px" onClick={() => setShowOutput(v => !v)}>
                  {showOutput ? 'Collapse' : 'Show full response'}
                </button>
              )}
            </div>
            <div class="sw-detail-value" style="white-space:pre-wrap;word-break:break-word;font-size:11px;line-height:1.5">
              {showOutput ? entry.responseText : entry.responseText.slice(0, PREVIEW_LEN)}
              {isLongResponse && !showOutput && <span style="color:var(--muted)">…</span>}
            </div>
          </div>
        )}
        {entry.thinking && <LongTextSection heading="Reasoning" text={entry.thinking} id={'sw-thinking-' + sessIdx + '-' + idx} />}
        {(entry.ttft ?? 0) > 0 && (
          <div class="sw-detail-section"><div class="sw-detail-heading">Time to First Token</div><div class="sw-detail-value">{formatMs(entry.ttft!)}</div></div>
        )}
        <div class="sw-detail-section"><div class="sw-detail-heading">Duration</div><div class="sw-detail-value">{formatMs(step.durationMs)}</div></div>
        {entry.action && <div class="sw-detail-section"><div class="sw-detail-heading">Stop reason</div><div class="sw-detail-value">{entry.action}</div></div>}
        {entry.timestamp && <div class="sw-detail-section"><div class="sw-detail-heading">Timestamp</div><div class="sw-detail-value sw-detail-muted">{entry.timestamp}</div></div>}
      </>
    )
  }

  if (entry.type === 'tool') {
    const toolParts = (entry.label ?? '').match(/^(\S+)\s*([\s\S]*)$/)
    const tName = toolParts ? toolParts[1] : entry.label
    const tArgs = toolParts ? toolParts[2] : ''
    // toolInput is a raw command, a file path, or a JSON args object.
    const isRaw = entry.toolInput && !entry.toolInput.trimStart().startsWith('{')
    const isFilePath = isRaw && (entry.toolInput!.startsWith('/') || entry.toolInput!.startsWith('~') || /^[A-Za-z]:[/\\]/.test(entry.toolInput!))
    const inputHeading = !isRaw ? 'Arguments' : isFilePath ? 'File' : 'Command'
    const inputText = isRaw ? entry.toolInput : (tArgs || entry.toolInput || '')
    const resultText = entry.fullResult || entry.resultSummary || ''
    return (
      <>
        <div class="sw-detail-section"><div class="sw-detail-heading">Tool</div><div class="sw-detail-value"><code>{tName}</code></div></div>
        {inputText && (
          <div class="sw-detail-section">
            <div class="sw-detail-heading">{inputHeading}</div>
            <div class="sw-detail-value"><code style="white-space:pre-wrap;word-break:break-all">{inputText}</code></div>
          </div>
        )}
        <div class="sw-detail-section"><div class="sw-detail-heading">Duration</div><div class="sw-detail-value">{formatMs(step.durationMs)}</div></div>
        {entry.decision && (
          <div class="sw-detail-section">
            <div class="sw-detail-heading">Decision</div>
            <div class="sw-detail-value" style={entry.decision === 'rejected' ? 'color:var(--error)' : 'color:#8ec96b'}>{entry.decision}</div>
          </div>
        )}
        {resultText && <LongTextSection heading="Result" text={resultText} id={'sw-result-' + sessIdx + '-' + idx} isJson />}
        {entry.isError && <div class="sw-detail-section"><div class="sw-detail-heading err">Error</div><div class="sw-detail-value err">This step failed</div></div>}
        {entry.timestamp && <div class="sw-detail-section"><div class="sw-detail-heading">Timestamp</div><div class="sw-detail-value sw-detail-muted">{entry.timestamp}</div></div>}
      </>
    )
  }

  return (
    <>
      <div class="sw-detail-section"><div class="sw-detail-heading">Background Task</div><div class="sw-detail-value">{entry.label || ''}</div></div>
      <div class="sw-detail-section"><div class="sw-detail-heading">Duration</div><div class="sw-detail-value">{formatMs(step.durationMs)}</div></div>
    </>
  )
}

function LongTextSection({ heading, text, id: _id, isJson }: { heading: string; text: string; id: string; isJson?: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const maxPreviewChars = 600
  const isLong = text.length > maxPreviewChars

  let formatted = text.length > 6000 ? text.slice(0, 6000) + '\n... [truncated ' + (text.length - 6000).toLocaleString() + ' chars]' : text
  if (formatted.length <= 2000) {
    try { formatted = JSON.stringify(JSON.parse(formatted), null, 2) } catch { /* keep as-is */ }
  }

  return (
    <>
      <div class="sw-detail-section">
        <div class="sw-detail-heading">
          {heading}
          {isLong && (
            <button class="sw-show-full-btn" style="margin-left:8px" onClick={() => setExpanded(v => !v)}>
              {expanded ? 'Collapse' : 'Show full'}
            </button>
          )}
        </div>
      </div>
      {!isLong || !expanded ? (
        <pre class="sw-full-result-pre" style="margin:0 0 8px">
          {isJson && formatted.length <= 2000
            ? <span dangerouslySetInnerHTML={{ __html: syntaxHighlightJson(isLong ? text.slice(0, maxPreviewChars) : formatted) }} />
            : (isLong ? text.slice(0, maxPreviewChars) + '…' : formatted)
          }
        </pre>
      ) : (
        <pre class="sw-full-result-pre" style="margin:0 0 8px">
          {isJson && formatted.length <= 2000
            ? <span dangerouslySetInnerHTML={{ __html: syntaxHighlightJson(formatted) }} />
            : formatted
          }
        </pre>
      )}
    </>
  )
}

export function StepRow({ step, idx, sessIdx, sessionDur, sessionModel }: { step: Step; idx: number; sessIdx: number; sessionDur: number; sessionModel: string }) {
  const [open, setOpen] = useState(false)
  const entry = step.entry
  const entryCost = entry.type === 'llm' ? calcEntryCost(entry, sessionModel) : 0

  let badgeLabel: string, barColor: string
  if (entry.type === 'llm') { badgeLabel = 'LLM'; barColor = 'var(--accent)' }
  else if (entry.type === 'tool') { badgeLabel = 'TOOL'; barColor = '#B8E986' }
  else if (entry.type === 'user_input') { badgeLabel = 'USER'; barColor = '#F5A623' }
  else { badgeLabel = 'BG'; barColor = 'var(--muted)' }
  if (entry.isError) barColor = 'var(--error)'

  const rowLabel = entry.type === 'llm' ? formatLlmLabel(entry)
    : entry.type === 'tool' ? formatToolLabel(entry) + (formatToolResult(entry) ? ' → ' + formatToolResult(entry) : '')
    : entry.type === 'user_input' ? (entry.decision && entry.decision !== 'unknown' ? `${entry.label} (${entry.decision})` : entry.label)
    : entry.label || ''

  // Show a subtitle with the full bash command (when the label had to truncate it).
  const toolSubtitle = (() => {
    if (entry.type !== 'tool' || !entry.toolInput) return null
    const raw = entry.toolInput.trimStart()
    if (raw.startsWith('{')) {
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>
        if (parsed.command) {
          // Show full command as subtitle when it was truncated in the label
          const cmd = String(parsed.command)
          return cmd.length > 60 ? cmd : null
        }
      } catch { /* ignore */ }
      return null
    }
    // Raw string (Bash full_command or file path)
    const isFilePath = raw.startsWith('/') || raw.startsWith('~') || /^[A-Za-z]:[/\\]/.test(raw)
    if (isFilePath) return null  // file path already shown in label
    return raw.length > 60 ? raw : null  // only show subtitle if it was truncated
  })()

  const subtitle = toolSubtitle

  const left = sessionDur > 0 ? (step.offsetMs / sessionDur * 100) : 0
  const width = sessionDur > 0 ? Math.max(step.durationMs / sessionDur * 100, 0.5) : 100

  return (
    <>
      <div class="wf-row" onClick={() => setOpen(v => !v)}>
        <div class="wf-label" title={subtitle ? rowLabel + ' — ' + subtitle : rowLabel}>
          <span class="wf-indent" />
          <span class="sw-chevron">{open ? '▼' : '▶'}</span>
          <span class="wf-type-badge" style={'background:' + barColor + ';color:#000'}>{badgeLabel}</span>
          <span style="display:inline-flex;flex-direction:column;min-width:0">
            <span class="wf-name">{rowLabel}</span>
            {subtitle && <span style="font-size:9px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:280px">{subtitle}</span>}
          </span>
        </div>
        <div class="wf-bar-area">
          <div class="wf-bar" style={`left:${left.toFixed(2)}%;width:${width.toFixed(2)}%`}>
            <div class="wf-bar-inner" style={'background:' + barColor + ';opacity:' + (entry.isError ? '1' : '0.7')} />
          </div>
        </div>
        <div class="wf-info">
          {formatMs(step.durationMs)}
          {entry.type === 'llm' && ((entry.inputTokens ?? 0) > 0 || (entry.outputTokens ?? 0) > 0) && (
            <div style="font-size:9px;color:var(--muted);margin-top:2px">
              <div style="white-space:nowrap">↑{formatCompact(entry.inputTokens ?? 0)} ↓{formatCompact(entry.outputTokens ?? 0)}</div>
              {(entry.cacheReadTokens ?? 0) > 0 && (
                <div style="white-space:nowrap">{formatCompact(entry.cacheReadTokens ?? 0)} cached</div>
              )}
            </div>
          )}
          {entryCost > 0 && (
            <div style="font-size:9px;color:var(--muted);white-space:nowrap">~{fmtUsd(entryCost)}</div>
          )}
        </div>
      </div>
      {open && (
        <div class="sw-detail open">
          <StepDetail step={step} idx={idx} sessIdx={sessIdx} sessionModel={sessionModel} />
        </div>
      )}
    </>
  )
}

function SessionBlock({ sess, sessIdx, sessNum, totalCount, isFirst }: {
  sess: SessionSummaryCard; sessIdx: number; sessNum: number; totalCount: number; isFirst: boolean
}) {
  const [collapsed, setCollapsed] = useState(!isFirst)
  const [promptExpanded, setPromptExpanded] = useState(false)
  const isFocused = focusedSessionId.value === sess.sessionId
  const isLongPrompt = (sess.userRequest?.length ?? 0) > 100

  const sessionTime = formatSessionTime(sess)
  const sessionStartMs = sess.startTime ? new Date(sess.startTime).getTime() : 0
  let sessionDur = sess.durationMs || 1

  const timelines = sessionTimelines.value
  const loadedTimeline = timelines[sess.sessionId]
  const isLoading = !collapsed && loadedTimeline === undefined

  useEffect(() => {
    if (!collapsed && loadedTimeline === undefined) {
      if (vscode) vscode.postMessage({ type: 'loadSessionDetail', sessionId: sess.sessionId })
    }
  }, [sess.sessionId, collapsed])

  const toggle = () => {
    const opening = collapsed
    setCollapsed(v => !v)
    if (opening && loadedTimeline === undefined) {
      if (vscode) vscode.postMessage({ type: 'loadSessionDetail', sessionId: sess.sessionId })
    }
  }

  const timeline = loadedTimeline ?? sess.timeline ?? []
  const steps: Step[] = timeline.map(entry => {
    const entryStart = entry.timestamp ? new Date(entry.timestamp).getTime() : 0
    const offset = sessionStartMs > 0 && entryStart > 0 ? entryStart - sessionStartMs : 0
    return { entry, offsetMs: Math.max(offset, 0), durationMs: entry.durationMs || 0 }
  })

  if (steps.length > 0) {
    const maxEnd = Math.max(...steps.map(s => s.offsetMs + s.durationMs))
    if (maxEnd > sessionDur) sessionDur = maxEnd
  }
  if (sessionDur <= 0) sessionDur = 1

  const errorCount = sess.errors || 0
  const outcomeLabel = sess.outcome === 'text_response' ? 'Responded' : sess.outcome === 'tool_calls' ? 'Tool calls' : null

  return (
    <div id={`trace-session-${sess.sessionId}`} class="wf-trace-group" style={isFocused ? 'outline:2px solid var(--vscode-focusBorder,#007fd4);border-radius:4px;outline-offset:1px' : ''}>
      <div class="wf-trace-header" onClick={toggle}>
        <span>
          <span class="wf-header-chevron">{collapsed ? '▶' : '▼'}</span>
          <span dangerouslySetInnerHTML={{ __html: getAgentDotHtml(sess.source) }} />{' '}
          <span style="font-size:10px;color:var(--muted);margin-right:4px">#{sessNum}</span>
          <span style="font-size:10px;color:var(--muted)">{sessionTime}</span>{' '}
          {sess.userRequest && sess.userRequest !== '[prompt unavailable]' && sess.userRequest !== '[trace in progress]'
            ? <>"{sess.userRequest.slice(0, 100)}{isLongPrompt ? '…' : ''}"</>
            : <span style="color:var(--muted);font-style:italic">{sess.userRequest || '[no prompt]'}</span>
          }
          {isLongPrompt && (
            <button class="sw-show-full-btn" style="margin-left:8px" onClick={e => { e.stopPropagation(); setPromptExpanded(v => !v) }}>
              {promptExpanded ? 'Collapse' : 'Show full prompt'}
            </button>
          )}
        </span>
        <span class="wf-trace-stats">
          {steps.length} steps · {formatMs(sessionDur)} · {sess.model}
          {errorCount > 0 && <span class="err"> · {errorCount} errors</span>}
          {outcomeLabel && <>{' · '}{outcomeLabel}</>}
        </span>
      </div>

      {sess.source === 'codex' && !collapsed && (
        <div style="padding:6px 10px;background:var(--hover);border-left:1px solid var(--border);border-right:1px solid var(--border);font-size:11px;color:var(--muted);line-height:1.5">
          <strong style="color:var(--fg)">Codex trace note:</strong>{' '}
          Codex telemetry contains many point-in-time log events and very short spans. These may appear as narrow marks in the waterfall even when the overall session lasted much longer. Use Flow for the normalized turn/tool sequence, or expand a row to inspect its exact duration and timestamp.
        </div>
      )}

      {promptExpanded && (
        <div style="padding:6px 10px 6px 28px;background:var(--hover);border-left:1px solid var(--border);border-right:1px solid var(--border);font-size:11px;color:var(--fg);white-space:pre-wrap;word-break:break-word">
          {sess.userRequest}
        </div>
      )}
      {!collapsed && (
        <div class="wf-trace-body">
          {isLoading ? (
            <div style="padding:12px 16px;font-size:11px;color:var(--muted)">Loading timeline…</div>
          ) : (
            <>
              <div class="wf-time-ruler">
                {Array.from({ length: 6 }, (_, t) => <span key={t}>{formatMs(sessionDur * t / 5)}</span>)}
              </div>
              {steps.map((step, si) => <StepRow key={step.entry.spanId + si} step={step} idx={si} sessIdx={sessIdx} sessionDur={sessionDur} sessionModel={sess.model ?? ''} />)}
            </>
          )}
        </div>
      )}
    </div>
  )
}

function DayGroup({ label, sessions, startNum, focusedId }: {
  label: string
  sessions: SessionSummaryCard[]
  startNum: number
  focusedId: string | null
}) {
  const [collapsed, setCollapsed] = useState(false)
  return (
    <div style="margin-bottom:4px">
      <div
        style="display:flex;align-items:center;gap:8px;padding:5px 8px;cursor:pointer;user-select:none;border-bottom:1px solid var(--vscode-panel-border)"
        onClick={() => setCollapsed(c => !c)}
      >
        <span style="font-size:10px;color:var(--muted)">{collapsed ? '▶' : '▼'}</span>
        <span style="font-size:12px;font-weight:600;color:var(--foreground)">{label}</span>
        <span style="font-size:10px;color:var(--muted)">{sessions.length} session{sessions.length !== 1 ? 's' : ''}</span>
      </div>
      {!collapsed && sessions.map((sess, idx) => (
        <SessionBlock
          key={sess.traceId + idx}
          sess={sess}
          sessIdx={idx}
          sessNum={startNum + idx}
          totalCount={sessions.length}
          isFirst={idx === 0 && focusedId === null}
        />
      ))}
    </div>
  )
}

export function Traces() {
  const base = filteredSessions.value
  const summary = sessionSummary.value
  const hasAny = (summary?.sessions?.length ?? 0) > 0
  const focusedId = focusedSessionId.value

  // Scroll to focused session when it changes
  useEffect(() => {
    if (!focusedId) return
    const el = document.getElementById(`trace-session-${focusedId}`)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [focusedId])

  if (!summary?.sessions?.length) {
    return <div id="summary-traces-content"><div class="empty-state">{hasAny ? 'No sessions match the active filters.' : 'No sessions recorded yet.'}</div></div>
  }

  const sessionsToShow = [...base].reverse()
  const totalLlmCalls = sessionsToShow.reduce((s, sess) => s + sess.totalLlmCalls, 0)
  const totalToolCalls = sessionsToShow.reduce((s, sess) => s + sess.totalToolCalls, 0)
  const totalTokens = sessionsToShow.reduce((s, sess) => s + sess.inputTokens + sess.outputTokens, 0)

  // Group sessions by calendar day (newest day first)
  const dayGroups: Array<{ key: string; label: string; sessions: typeof sessionsToShow }> = []
  sessionsToShow.forEach(sess => {
    const dk = sessionDateKey(sess) || 'unknown'
    const last = dayGroups[dayGroups.length - 1]
    if (last && last.key === dk) {
      last.sessions.push(sess)
    } else {
      dayGroups.push({ key: dk, label: dk === 'unknown' ? 'Unknown date' : formatDayLabel(dk), sessions: [sess] })
    }
  })

  return (
    <div id="summary-traces-content">
      <div class="tab-stats">
        <div><strong class="tab-stat-val">{sessionsToShow.length}</strong> sessions</div>
        <div><strong class="tab-stat-val">{totalLlmCalls}</strong> LLM calls</div>
        <div><strong class="tab-stat-val">{totalToolCalls}</strong> tool calls</div>
        <div><strong class="tab-stat-val">{formatCompact(totalTokens)}</strong> tokens</div>
      </div>
      <div class="waterfall">
        {sessionsToShow.length === 0 && (
          <div class="empty-state">No sessions in this time range</div>
        )}
        {(() => {
          let offset = 1
          return dayGroups.map(group => {
            const el = <DayGroup key={group.key} label={group.label} sessions={group.sessions} startNum={offset} focusedId={focusedId} />
            offset += group.sessions.length
            return el
          })
        })()}
      </div>
      {summary.backgroundSpans?.length > 0 && (
        <BgSummaryBlock bgSpans={summary.backgroundSpans} />
      )}
    </div>
  )
}
