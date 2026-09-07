import { useState, useEffect, useRef } from 'preact/hooks'
import {
  filteredSessions, sessionSummary, sessionTimelines, gitOutcomes, burnRateData,
  focusedSessionId, vscode, ignoredInsightKeys,
  sessionSortKey, sessionSortDir, type SortKey,
  workspaceFilter, shortWorkspaceName, goToHelp,
  sessionsPage, getSessionsPagination,
  evidenceSessionIds, evidenceSessionLabel, evidenceSessionPrompt,
} from '../state'
import {
  getAgentColor, getAgentSourceLabel, formatMs, formatCompact, formatSessionTime,
  getDataSourceBadgeHtml, getInitiatorBadgeHtml, getConversationColor,
} from '../utils'
import { calcSessionCost, oneShotRate, avgEditsPerFile } from '../sessionMetrics'
import { fmtUsd } from './Cost'
import { generateInsights, InsightCard } from './Insights'
import { buildDisplaySummary } from '../utils'
import { Step, StepRow } from './Traces'
import { FlowCanvas } from './Flow'
import { ToolsChart } from './Tools'
import { LogIngestionNote } from './IngestionNote'
import type { SessionSummaryCard, FileOutcome } from '../types'

// ── Session detail panel (shown in expanded row) ──────────────────────────────

type Section = 'overview' | 'trace' | 'files' | 'flow' | 'tools'

const OUTCOME_META: Record<FileOutcome, { icon: string; color: string; label: string }> = {
  productive: { icon: '✓', color: 'var(--vscode-charts-green,#81c784)', label: 'Committed' },
  reverted:   { icon: '↺', color: 'var(--error)',                       label: 'Reverted' },
  abandoned:  { icon: '◑', color: '#f6a623',                            label: 'Uncommitted' },
  ambiguous:  { icon: '?', color: 'var(--muted)',                       label: 'Unknown' },
}

function PromptBlock({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  const PREVIEW_CHARS = 300
  const truncated = !expanded && text.length > PREVIEW_CHARS
  const display = truncated ? text.slice(0, PREVIEW_CHARS).trimEnd() + '…' : text
  return (
    <div style="margin-bottom:10px">
      <div style="font-size:9px;text-transform:uppercase;letter-spacing:.4px;color:var(--muted);margin-bottom:4px">Prompt</div>
      <div style="background:var(--card-bg);border:1px solid var(--border);border-radius:4px;padding:7px 10px;font-size:11px;white-space:pre-wrap;word-break:break-word;line-height:1.5;color:var(--foreground);max-height:200px;overflow-y:auto">
        {display}
      </div>
      {text.length > PREVIEW_CHARS && (
        <button
          onClick={() => setExpanded(e => !e)}
          style="margin-top:4px;font-size:10px;color:var(--vscode-textLink-foreground,#4fc3f7);background:none;border:none;cursor:pointer;padding:0"
        >
          {expanded ? 'Show less' : 'Show full prompt'}
        </button>
      )}
    </div>
  )
}

function SessionDetail({ sess }: { sess: SessionSummaryCard }) {
  const [section, setSection] = useState<Section>('overview')
  const timelines = sessionTimelines.value
  const timeline = timelines[sess.sessionId] ?? sess.timeline ?? []
  const cost = calcSessionCost(sess, 'token')
  const cacheRate = sess.inputTokens > 0 ? Math.round(sess.cacheReadTokens / sess.inputTokens * 100) : 0
  const burnRate = burnRateData.value
  const gitOutcome = gitOutcomes.value[sess.sessionId]

  useEffect(() => {
    if (!timelines[sess.sessionId] && vscode) {
      vscode.postMessage({ type: 'loadSessionDetail', sessionId: sess.sessionId })
    }
  }, [sess.sessionId])

  useEffect(() => {
    // undefined = not yet requested; null = requested but not applicable (no repo, no files, etc)
    if (gitOutcomes.value[sess.sessionId] === undefined && sess.filesChanged.length > 0 && vscode) {
      const endTime = sess.startTime && sess.durationMs
        ? new Date(new Date(sess.startTime).getTime() + sess.durationMs).toISOString()
        : sess.startTime
      vscode.postMessage({
        type: 'getGitOutcome',
        sessionId: sess.sessionId,
        workspace: sess.workspace,
        filesChanged: sess.filesChanged,
        startTime: sess.startTime,
        endTime,
      })
    }
  }, [sess.sessionId])

  const ignored = ignoredInsightKeys.value
  const summary = buildDisplaySummary([sess])
  const sessInsights = generateInsights(summary, [sess]).filter(i => !ignored.has(i.title))

  const visibleEntries = timeline.filter(e => e.type !== 'background')
  const sessionStartMs = sess.startTime ? new Date(sess.startTime).getTime() : 0
  let sessionDur = sess.durationMs || 1

  const steps: Step[] = visibleEntries.map(entry => {
    const entryStart = entry.timestamp ? new Date(entry.timestamp).getTime() : 0
    const offset = sessionStartMs > 0 && entryStart > 0 ? entryStart - sessionStartMs : 0
    return { entry, offsetMs: Math.max(offset, 0), durationMs: entry.durationMs || 0 }
  })
  if (steps.length > 0) {
    const maxEnd = Math.max(...steps.map(s => s.offsetMs + s.durationMs))
    if (maxEnd > sessionDur) sessionDur = maxEnd
  }
  if (sessionDur <= 0) sessionDur = 1

  const navBtn = (s: Section, label: string) => (
    <button
      onClick={e => { e.stopPropagation(); setSection(s) }}
      style={[
        'padding:3px 10px;font-size:11px;cursor:pointer;border:none;border-bottom:2px solid transparent;background:transparent;',
        section === s ? 'color:var(--fg);border-bottom-color:var(--accent);font-weight:600' : 'color:var(--muted)',
      ].join('')}
    >{label}</button>
  )

  return (
    <div style="border-top:1px solid var(--border)" onClick={e => e.stopPropagation()}>
      <div style="display:flex;gap:0;padding:0 8px;border-bottom:1px solid var(--border);background:var(--vscode-editorWidget-background,var(--bg));overflow-x:auto">
        {navBtn('overview', 'Overview')}
        {navBtn('trace', `Trace${visibleEntries.length > 0 ? ' (' + visibleEntries.length + ')' : ''}`)}
        {navBtn('flow', `Flow${sess.totalLlmCalls > 0 ? ' (' + sess.totalLlmCalls + ')' : ''}`)}
        {navBtn('tools', `Tools${sess.totalToolCalls > 0 ? ' (' + sess.totalToolCalls + ')' : ''}`)}
        {navBtn('files', `Files${sess.filesChanged.length > 0 ? ' (' + sess.filesChanged.length + ')' : ''}`)}
      </div>

      <div style="padding:12px 14px">

        {section === 'overview' && (
          <div>
            {sess.dataSource === 'log' && (() => {
              const isCopilot = sess.source === 'copilot'
              const isOpenCode = sess.source === 'opencode'
              // Pre-~Feb 2026 Copilot Chat sessions (.json snapshot format): VS Code did not
              // record token counts at all — outputTokens=0 with turns>0 is the fingerprint.
              if (isCopilot && sess.outputTokens === 0 && sess.turns > 0) {
                return (
                  <div style="margin-bottom:10px;padding:7px 10px;border-radius:4px;border-left:3px solid var(--vscode-editorWarning-foreground,#cca700);background:var(--hover);font-size:11px;color:var(--muted);line-height:1.5">
                    <span style="color:var(--vscode-editorWarning-foreground,#cca700);font-weight:600">Log-only session — no token data</span>
                    {' — '}
                    VS Code Copilot Chat did not record token counts in this era. Token counts and cost estimates are unavailable and cannot be recovered.
                  </div>
                )
              }
              if (isOpenCode) {
                return (
                  <div style="margin-bottom:10px;padding:7px 10px;border-radius:4px;border-left:3px solid var(--vscode-editorInfo-foreground,#4fc3f7);background:var(--hover);font-size:11px;color:var(--muted);line-height:1.5">
                    <span style="color:var(--vscode-editorInfo-foreground,#4fc3f7);font-weight:600">OpenCode SQLite session</span>
                    {' — '}
                    Token counts, tools, and files sourced from OpenCode&apos;s local database. OTEL traces and TTFT are not available for OpenCode.
                  </div>
                )
              }
              const missingTokens = isCopilot && sess.inputTokens === 0
              const parts: string[] = ['traces & TTFT']
              if (missingTokens) parts.push('input tokens & cache stats')
              if (isCopilot) parts.push('tool details')
              return (
                <div style="margin-bottom:10px;padding:7px 10px;border-radius:4px;border-left:3px solid var(--vscode-editorWarning-foreground,#cca700);background:var(--hover);font-size:11px;color:var(--muted);line-height:1.5">
                  <span style="color:var(--vscode-editorWarning-foreground,#cca700);font-weight:600">Log-only session</span>
                  {' — '}
                  {parts.join(', ')} not available from local logs.{' '}
                  <a onClick={() => goToHelp('help-config')} style="color:var(--vscode-textLink-foreground,#4fc3f7);cursor:pointer;text-decoration:underline">
                    Enable OTEL ingestion
                  </a>{' '}for full telemetry.
                </div>
              )
            })()}

            {sess.userRequest
              ? <PromptBlock text={sess.userRequest} />
              : sess.turns === 0
                ? <div style="margin-bottom:10px;font-size:11px;color:var(--muted);font-style:italic">Waiting for first turn…</div>
                : <div style="margin-bottom:10px;font-size:11px;color:var(--muted)">Prompt not captured for this session</div>
            }
            <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:6px;margin-bottom:10px">
              {[
                { k: 'LLM calls',  v: String(sess.totalLlmCalls) },
                ...((sess.models?.length ?? 0) > 1 ? [{ k: 'Models', v: sess.models!.join(', ') }] : []),
                { k: 'Tool calls', v: String(sess.totalToolCalls) },
                { k: 'Input tokens', v: formatCompact(sess.inputTokens) },
                { k: 'Output tokens', v: formatCompact(sess.outputTokens) },
                { k: 'Cache hit',  v: cacheRate + '%' },
                ...(sess.peakContextPerTurn ? [{ k: 'Peak ctx/turn', v: formatCompact(sess.peakContextPerTurn) }] : []),
                { k: 'Duration',   v: formatMs(sess.durationMs) },
                ...(sess.errors > 0 ? [{ k: 'Errors', v: String(sess.errors) }] : []),
                ...(!cost.modelUnknown && cost.totalUsd > 0 ? [{ k: 'Est. cost', v: fmtUsd(cost.totalUsd) }] : []),
              ].map(({ k, v }) => (
                <div key={k} style="background:var(--card-bg);border:1px solid var(--border);border-radius:4px;padding:5px 8px">
                  <div style="font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.3px">{k}</div>
                  <div style="font-size:14px;font-weight:600;color:var(--vscode-textLink-foreground,#4fc3f7)">{v}</div>
                </div>
              ))}
            </div>

            {burnRate && burnRate.sessionId === sess.sessionId && (
              <div style="margin-bottom:10px;padding:6px 10px;border-radius:4px;border-left:3px solid #56D364;background:var(--hover);font-size:11px">
                <span style="color:#56D364;font-weight:600">{formatCompact(Math.round(burnRate.burnRate.tokensPerMinute))} tok/min</span>
                {burnRate.burnRate.costPerHour > 0.001 && <span style="color:var(--muted);margin-left:8px">~{fmtUsd(burnRate.burnRate.costPerHour)}/hr</span>}
                {burnRate.projection && <span style="color:var(--muted);margin-left:8px">{burnRate.projection.contextFillPct.toFixed(0)}% context used</span>}
              </div>
            )}

            {sessInsights.length > 0 && (
              <div>
                <div style="font-size:10px;text-transform:uppercase;letter-spacing:.4px;color:var(--muted);margin-bottom:6px">Insights</div>
                {sessInsights.slice(0, 4).map(ins => (
                  <InsightCard key={ins.title} ins={ins} isIgnored={false} sessions={[sess]} />
                ))}
              </div>
            )}

          </div>
        )}

        {section === 'trace' && (
          <div>
            {steps.length === 0
              ? (timelines[sess.sessionId] !== undefined
                  ? (
                    <div class="empty-state" style="padding:12px 0">
                      No trace data for this session
                      {sess.dataSource === 'log' && <LogIngestionNote feature="trace" />}
                    </div>
                  )
                  : <div class="empty-state" style="padding:12px 0">Loading…</div>)
              : (
                <div class="waterfall">
                  <div class="wf-time-ruler">
                    {Array.from({ length: 6 }, (_, t) => <span key={t}>{formatMs(sessionDur * t / 5)}</span>)}
                  </div>
                  {steps.map((step, si) => (
                    <StepRow
                      key={step.entry.spanId + si}
                      step={step}
                      idx={si}
                      sessIdx={0}
                      sessionDur={sessionDur}
                      sessionModel={sess.model ?? ''}
                    />
                  ))}
                </div>
              )
            }
          </div>
        )}

        {section === 'flow' && (
          <FlowCanvas sess={sess} height={420} />
        )}

        {section === 'tools' && (
          <ToolsChart sessions={[sess]} />
        )}

        {section === 'files' && (
          <div>
            {sess.filesChanged.length === 0
              ? (
                <div class="empty-state" style="padding:12px 0">
                  No files modified
                  {sess.dataSource === 'log' && <LogIngestionNote feature="file change" />}
                </div>
              )
              : (
                <div style="display:flex;flex-direction:column;gap:3px">
                  {sess.oneShotStats && sess.oneShotStats.filesConsidered > 0 && (() => {
                    const rate = oneShotRate(sess.oneShotStats)
                    const avg = avgEditsPerFile(sess.oneShotStats)
                    return (
                      <div
                        data-tip="Counts edit passes per file — a file edited once is 'one-shot', edited again is a retry. This is a proxy for correction effort, not a signal that the code actually worked."
                        style="display:flex;align-items:center;gap:6px;padding:5px 8px;margin-bottom:2px;font-size:11px;color:var(--muted);cursor:help"
                      >
                        <span>
                          {rate === null
                            ? `Not enough edited files for a one-shot rate (${sess.oneShotStats.filesConsidered} considered)`
                            : `${Math.round(rate * 100)}% one-shot (${sess.oneShotStats.oneShotFiles}/${sess.oneShotStats.filesConsidered} files, avg ${avg?.toFixed(1)} edit passes/file)`}
                        </span>
                      </div>
                    )
                  })()}
                  {gitOutcome && (
                    <div
                      data-tip="Estimated from local git history: compares each file's content right before this session against its content now. Not available without a local git repo, and doesn't cover files git can't see (e.g. gitignored)."
                      style={`display:flex;align-items:center;gap:6px;padding:5px 8px;margin-bottom:2px;font-size:11px;color:${OUTCOME_META[gitOutcome.overall].color};cursor:help`}
                    >
                      <span>{OUTCOME_META[gitOutcome.overall].icon}</span>
                      <span>{gitOutcome.reason}</span>
                    </div>
                  )}
                  {sess.filesChanged.map(f => {
                    const fileOutcome = gitOutcome?.files[f]
                    const meta = fileOutcome ? OUTCOME_META[fileOutcome] : null
                    return (
                      <div
                        key={f}
                        style={`display:flex;align-items:center;gap:8px;padding:4px 8px;background:var(--hover);border-radius:4px;font-size:11px${vscode ? ';cursor:pointer' : ''}`}
                        onClick={() => vscode?.postMessage({ type: 'openFile', filePath: f })}
                        title={vscode ? 'Click to open in editor' : f}
                      >
                        <span style="color:var(--vscode-charts-green,#81c784);font-size:10px;flex-shrink:0">M</span>
                        <span style={`font-family:monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1${vscode ? ';color:var(--vscode-textLink-foreground,#4fc3f7)' : ''}`}>{f}</span>
                        {meta && (
                          <span style={`color:${meta.color};font-size:10px;flex-shrink:0`} title={meta.label}>{meta.icon} {meta.label}</span>
                        )}
                      </div>
                    )
                  })}
                  {sess.filesChangedNote && (
                    <div style="font-size:10px;color:var(--muted);margin-top:3px">{sess.filesChangedNote}</div>
                  )}
                </div>
              )
            }
          </div>
        )}

      </div>
    </div>
  )
}

// A log file can now split into several session cards when a large idle gap separates two real
// conversations within it (see splitLinesOnPromptGaps in logReader.ts) — those cards share a
// conversationId. Builds a per-sessionId lookup (color + "part X of Y") for every session that
// still has 2+ siblings visible in the given list, so the Sessions table can color-code and label
// rows that are really one conversation split across multiple cards. Computed over the full
// filtered list (not just the current page) so a group's color/labels stay consistent regardless
// of which page a sibling happens to land on; a sibling hidden by an active filter just means that
// group won't be colored at all here (nothing misleading — no "phantom" sibling implied).
function buildConversationInfo(sessions: SessionSummaryCard[]): Map<string, { color: string; index: number; total: number; memberIds: string[]; firstPrompt: string }> {
  const byConversation = new Map<string, SessionSummaryCard[]>()
  for (const s of sessions) {
    if (!s.conversationId) continue
    const group = byConversation.get(s.conversationId)
    if (group) group.push(s)
    else byConversation.set(s.conversationId, [s])
  }
  const info = new Map<string, { color: string; index: number; total: number; memberIds: string[]; firstPrompt: string }>()
  for (const [conversationId, members] of byConversation) {
    if (members.length < 2) continue
    const color = getConversationColor(conversationId)
    const ordered = [...members].sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime())
    const memberIds = ordered.map(m => m.sessionId)
    const firstPrompt = ordered[0].userRequest ?? ''
    ordered.forEach((m, i) => info.set(m.sessionId, { color, index: i + 1, total: ordered.length, memberIds, firstPrompt }))
  }
  return info
}

// Whether evidenceSessionIds is currently isolated to exactly this conversation's members — used
// to render the active marker as "you are here" and to make clicking it again a toggle-off,
// rather than the only way out being the filter banner's separate "×" elsewhere on the page.
function isSameIdSet(current: Set<string> | null, ids: string[]): boolean {
  return current !== null && current.size === ids.length && ids.every(id => current.has(id))
}

// ── Table row ─────────────────────────────────────────────────────────────────

function SessionRow({ sess, showWorkspace, conversation }: {
  sess: SessionSummaryCard; showWorkspace: boolean
  conversation?: { color: string; index: number; total: number; memberIds: string[]; firstPrompt: string }
}) {
  const [expanded, setExpanded] = useState(false)
  const isFocused = focusedSessionId.value === sess.sessionId
  const rowRef = useRef<HTMLTableRowElement>(null)
  const cost = calcSessionCost(sess, 'token')
  const color = getAgentColor(sess.source)
  const prompt = sess.userRequest ?? ''
  const isIsolatedToThisGroup = conversation ? isSameIdSet(evidenceSessionIds.value, conversation.memberIds) : false

  useEffect(() => {
    if (focusedSessionId.value === sess.sessionId) {
      setExpanded(true)
      rowRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [focusedSessionId.value])

  function toggle() {
    const next = !expanded
    setExpanded(next)
    focusedSessionId.value = next ? sess.sessionId : null
  }

  const rowBg = isFocused ? 'var(--hover)' : 'transparent'

  return (
    <>
      <tr
        ref={rowRef}
        onClick={toggle}
        style={`cursor:pointer;background:${rowBg};border-bottom:1px solid var(--vscode-panel-border)`}
      >
        {/* Conversation-group marker — colored bar for sessions that are really one conversation
            split into multiple cards by a long gap (see buildConversationInfo above). An empty
            <td> collapses to zero width under table-layout:auto regardless of the width style, so
            the bar is a real child element instead of a background painted on the cell itself.
            Clicking it toggles isolating the conversation's sessions (stopPropagation so it
            doesn't also trigger the row's own expand-on-click) via the same evidenceSessionIds
            filter the Advisor tab's "View sessions" button already uses — click again (same
            gesture, same spot) to clear it, same as the banner's "×" but without needing to look
            away to find it. A currently-active bar renders wider as a visible "you are here." */}
        <td
          style={`padding:0;width:${isIsolatedToThisGroup ? 8 : 5}px${conversation ? ';cursor:pointer' : ''}`}
          title={conversation
            ? isIsolatedToThisGroup
              ? `Part ${conversation.index} of ${conversation.total} — showing just this conversation. Click again to clear.`
              : `Part ${conversation.index} of ${conversation.total} of the same conversation — split into separate sessions by a long gap. Click to show just this conversation.`
            : undefined}
          onClick={conversation ? (e: MouseEvent) => {
            e.stopPropagation()
            if (isIsolatedToThisGroup) {
              evidenceSessionIds.value = null
              evidenceSessionPrompt.value = null
            } else {
              evidenceSessionIds.value = new Set(conversation.memberIds)
              evidenceSessionLabel.value = 'from this conversation'
              evidenceSessionPrompt.value = conversation.firstPrompt || null
            }
          } : undefined}
        >
          <div style={`width:${isIsolatedToThisGroup ? 8 : 5}px;height:100%;min-height:20px;background:${conversation ? conversation.color : 'transparent'}`} />
        </td>

        {/* Chevron */}
        <td style="padding:4px 4px 4px 8px;width:16px;color:var(--muted);font-size:9px;white-space:nowrap">
          {expanded ? '▼' : '▶'}
        </td>

        {/* Agent dot + data source badge */}
        <td style="padding:4px 4px;width:auto;white-space:nowrap">
          <span style={`display:inline-block;width:6px;height:6px;border-radius:50%;background:${color};flex-shrink:0;vertical-align:middle`} />
          <span style="margin-left:4px" dangerouslySetInnerHTML={{ __html: getDataSourceBadgeHtml(sess.dataSource ?? 'otel') }} />
          <span dangerouslySetInnerHTML={{ __html: getInitiatorBadgeHtml(sess.initiator) }} />
        </td>

        {/* Timestamp + optional workspace label */}
        <td style="padding:4px 6px;white-space:nowrap;font-size:10px;color:var(--muted);font-variant-numeric:tabular-nums">
          {formatSessionTime(sess)}
          {showWorkspace && sess.workspace && (
            <span
              title={sess.workspace}
              style="margin-left:5px;color:var(--muted);opacity:0.55;font-size:9px;overflow:hidden;text-overflow:ellipsis;max-width:110px;display:inline-block;vertical-align:middle"
            >
              {shortWorkspaceName(sess.workspace)}
            </span>
          )}
        </td>

        {/* Prompt */}
        <td style="padding:4px 6px;max-width:0;width:100%">
          {prompt
            ? <span style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;font-style:italic;color:var(--foreground)" title={prompt}>{prompt}</span>
            : sess.turns === 0
              ? <span style="color:var(--muted);font-size:11px">…</span>
              : <span style="color:var(--muted);font-size:11px">—</span>
          }
        </td>

        {/* Model */}
        <td style="padding:4px 6px;white-space:nowrap;font-size:10px;color:var(--muted);max-width:130px;overflow:hidden;text-overflow:ellipsis">
          {sess.model || '—'}
          {(sess.models?.length ?? 0) > 1 && (
            <span
              title={`Multiple models used in this session: ${sess.models!.join(', ')}`}
              style="margin-left:4px;padding:0 4px;border-radius:3px;background:var(--hover);color:var(--muted);font-size:9px;vertical-align:middle"
            >+{sess.models!.length - 1}</span>
          )}
        </td>

        {/* Tokens */}
        <td style="padding:4px 6px;text-align:right;white-space:nowrap;font-size:10px;color:var(--muted)" title={sess.turns > 1 ? 'Input is accumulated across all turns (cache reads counted each turn). See Peak ctx/turn in session detail for actual context window size.' : undefined}>
          {formatCompact(sess.inputTokens + sess.outputTokens)}
        </td>

        {/* Duration */}
        <td style="padding:4px 6px;text-align:right;white-space:nowrap;font-size:10px;color:var(--muted)">
          {formatMs(sess.durationMs)}
        </td>

        {/* Cost */}
        <td style="padding:4px 8px 4px 6px;text-align:right;white-space:nowrap;font-size:10px">
          {!cost.modelUnknown && cost.totalUsd > 0
            ? <span style="color:var(--vscode-charts-green,#81c784)">{fmtUsd(cost.totalUsd)}</span>
            : sess.errors > 0
              ? <span style="color:var(--error)">{sess.errors} err</span>
              : <span style="color:var(--muted)">—</span>
          }
        </td>
      </tr>

      {expanded && (
        <tr style="border-bottom:1px solid var(--vscode-panel-border)">
          <td colspan={9} style="padding:0">
            <SessionDetail sess={sess} />
          </td>
        </tr>
      )}
    </>
  )
}

// ── Main Sessions component ───────────────────────────────────────────────────

export function Sessions() {
  const sessions = filteredSessions.value
  const hasAny = (sessionSummary.value?.sessions?.length ?? 0) > 0
  const wsFilter = workspaceFilter.value
  const uniqueWorkspaces = new Set(sessions.map(s => s.workspace ?? ''))
  const showWorkspace = wsFilter === 'all' && uniqueWorkspaces.size > 1

  if (sessions.length === 0) {
    return (
      <div id="sessions-content">
        <div class="empty-state">{hasAny ? 'No sessions match the active filters.' : 'No sessions recorded yet.'}</div>
      </div>
    )
  }

  const sortKey = sessionSortKey.value
  const sortDir = sessionSortDir.value

  function sortArrow(key: SortKey) {
    if (sortKey !== key) return <span style="opacity:0.3;margin-left:3px">↕</span>
    return <span style="margin-left:3px;color:var(--accent)">{sortDir === 'desc' ? '▼' : '▲'}</span>
  }

  function onSortClick(key: SortKey) {
    if (sessionSortKey.value === key) {
      sessionSortDir.value = sessionSortDir.value === 'desc' ? 'asc' : 'desc'
    } else {
      sessionSortKey.value = key
      sessionSortDir.value = 'desc'
    }
  }

  const thBase = 'padding:3px 6px;font-size:10px;font-weight:600;white-space:nowrap;user-select:none'
  const thSort = thBase + ';cursor:pointer;color:var(--fg)'
  const thMuted = thBase + ';color:var(--muted);font-weight:500'

  // Rendering every matching session as its own live component with no cap was the mechanism
  // behind .staged-issues/session-list-scaling.md — see getSessionsPagination's own doc comment
  // for why the clamping happens there rather than here.
  const { page, totalPages, pageSize } = getSessionsPagination(sessions.length)
  const pageSessions = sessions.slice(page * pageSize, (page + 1) * pageSize)
  const rangeStart = sessions.length === 0 ? 0 : page * pageSize + 1
  const rangeEnd = Math.min((page + 1) * pageSize, sessions.length)
  const conversationInfo = buildConversationInfo(sessions)

  return (
    <div id="sessions-content" style="padding-top:8px">
      <div class="h-scroll-hint">
      <table style="width:100%;border-collapse:collapse;font-size:11px">
        <thead>
          <tr style="border-bottom:2px solid var(--vscode-panel-border)">
            <th style="width:5px;padding:0" title="A colored bar marks sessions that are really one conversation split into multiple cards by a long gap between them." />
            <th style="width:16px;padding:3px 4px 3px 8px" />
            <th style={'width:10px;padding:3px 4px;' + thSort} onClick={() => onSortClick('source')} title="Sort by agent">{sortArrow('source')}</th>
            <th style={'text-align:left;' + thSort} onClick={() => onSortClick('start_time')}>Time{sortArrow('start_time')}</th>
            <th style={'text-align:left;' + thSort} onClick={() => onSortClick('prompt')}>Prompt{sortArrow('prompt')}</th>
            <th style={'text-align:left;' + thSort} onClick={() => onSortClick('model')}>Model{sortArrow('model')}</th>
            <th style={'text-align:right;' + thSort} onClick={() => onSortClick('total_tokens')} title="Total tokens across all turns (fresh input + cache reads + output). For multi-turn sessions this accumulates across every turn and can far exceed a single context window.">Tokens{sortArrow('total_tokens')}</th>
            <th style={'text-align:right;' + thSort} onClick={() => onSortClick('duration_ms')}>Duration{sortArrow('duration_ms')}</th>
            <th style={'text-align:right;padding:3px 8px 3px 6px;' + thSort} onClick={() => onSortClick('cost')}>Cost{sortArrow('cost')}</th>
          </tr>
        </thead>
        <tbody>
          {pageSessions.map(sess => (
            <SessionRow key={sess.sessionId} sess={sess} showWorkspace={showWorkspace} conversation={conversationInfo.get(sess.sessionId)} />
          ))}
        </tbody>
      </table>
      </div>
      <div style="padding:6px 8px;font-size:11px;color:var(--muted);border-top:1px solid var(--vscode-panel-border);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
        {window.__VERSION__ && <span>AgentLens v{window.__VERSION__}</span>}
        {totalPages > 1 && (
          <span style="display:flex;align-items:center;gap:8px">
            <span>Showing {rangeStart}–{rangeEnd} of {sessions.length}</span>
            <button
              onClick={() => sessionsPage.value = Math.max(0, page - 1)}
              disabled={page === 0}
              style={`padding:2px 8px;font-size:11px;border:1px solid var(--border);border-radius:3px;background:transparent;color:var(--fg);cursor:${page === 0 ? 'default' : 'pointer'};opacity:${page === 0 ? 0.4 : 1}`}
            >‹ Prev</button>
            <span>Page {page + 1} of {totalPages}</span>
            <button
              onClick={() => sessionsPage.value = Math.min(totalPages - 1, page + 1)}
              disabled={page >= totalPages - 1}
              style={`padding:2px 8px;font-size:11px;border:1px solid var(--border);border-radius:3px;background:transparent;color:var(--fg);cursor:${page >= totalPages - 1 ? 'default' : 'pointer'};opacity:${page >= totalPages - 1 ? 0.4 : 1}`}
            >Next ›</button>
          </span>
        )}
      </div>
    </div>
  )
}
