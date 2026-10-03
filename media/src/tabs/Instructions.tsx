import { useState, useEffect, useRef } from 'preact/hooks'
import { signal, computed } from '@preact/signals'
import {
  currentWorkspace, filteredSessions, activeTab, evidenceSessionIds, evidenceSessionLabel, evidenceSessionPrompt, vscode,
  repoInfo, repoDisplayName, repoTooltipName,
} from '../state'
import { calcSessionCost } from '../sessionMetrics'
import type { SessionSummaryCard } from '../types'
import {
  generateSuggestions as generateSuggestionsWithCost, SCOPE_PATTERNS, BASH_TOOLS, READ_TOOLS,
  type SuggestionCard, type SuggestionCategory,
} from '../suggestionRules'

// Suggestion rules (IDs, thresholds, text) are shared with the extension host — see
// ../suggestionRules.ts. This file keeps only the UI and its diagnostics.

interface InstructionFile {
  agent: string
  label: string
  relativePath: string
  exists: boolean
  content: string
}

interface AppliedRecord {
  id: string
  workspace: string
  category: string
  title: string
  suggestedText: string
  appliedTo: string
  appliedText: string
  appliedAt: string
  appliedAtMs: number
  baselineCostAvg: number
  baselineTurnsAvg: number
  baselineInsufficient: boolean
}

// ── Signals for instruction state ─────────────────────────────────────────────
// All keyed by workspace: the standalone dashboard shows every repo's suggestions at once, and the
// same suggestion id (behavior:high_turns, …) can be applied in one repo and pending in another.

interface WorkspaceFiles { files: InstructionFile[]; missing: boolean }
export const instructionFilesByWorkspace = signal<Record<string, WorkspaceFiles>>({})
/** The open folder's instruction files (extension) — what the Advisor's cost-saving list reads. */
export const instructionFiles = computed<InstructionFile[]>(() =>
  currentWorkspace.value === null ? [] : instructionFilesByWorkspace.value[currentWorkspace.value]?.files ?? [])
/** Applied records for every workspace the host has answered for, each tagged with its workspace. */
export const appliedSuggestions = signal<AppliedRecord[]>([])
export const dismissedByWorkspace = signal<Record<string, Set<string>>>({})

/** Stores an instructionFiles / appliedSuggestions / dismissedSuggestions reply under the workspace
 *  it names (both hosts include it; an older reply without one is taken as the open folder's). */
export function receiveInstructionMessage(msg: Record<string, unknown>): void {
  const ws = typeof msg.workspace === 'string' ? msg.workspace : currentWorkspace.peek()
  if (msg.type === 'instructionFiles' && Array.isArray(msg.files)) {
    if (ws === null) return
    instructionFilesByWorkspace.value = {
      ...instructionFilesByWorkspace.value,
      [ws]: { files: msg.files as InstructionFile[], missing: msg.missing === true },
    }
  } else if (msg.type === 'appliedSuggestions' && Array.isArray(msg.records)) {
    const records = msg.records as AppliedRecord[]
    appliedSuggestions.value = ws === null ? records
      : [...appliedSuggestions.value.filter(a => a.workspace !== ws), ...records]
  } else if (msg.type === 'dismissedSuggestions' && Array.isArray(msg.ids)) {
    if (ws === null) return
    dismissedByWorkspace.value = { ...dismissedByWorkspace.value, [ws]: new Set(msg.ids as string[]) }
  }
}

/** True in the standalone dashboard: no open folder, so the Instructions tab groups suggestions by
 *  repo and each group applies into its own repo (the server checks it's one the sessions ran in).
 *  The extension keeps to its window's open folder. */
export function instructionsAcrossWorkspaces(): boolean {
  return currentWorkspace.value === null && window.__STANDALONE__ === true
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const CAT_COLOR: Record<SuggestionCategory, string> = {
  context:   '#4fc3f7',
  behavior:  '#ffb74d',
  prompting: '#ba68c8',
}

const AGENT_LABEL: Record<string, string> = {
  claude_code: 'Claude',
  copilot:     'Copilot',
  codex:       'Codex',
  opencode:    'OpenCode',
  cursor:      'Cursor',
}

function sessionCostUsd(s: SessionSummaryCard): number {
  return calcSessionCost(s).totalUsd
}

function generateSuggestions(sessions: SessionSummaryCard[], existingText: string): SuggestionCard[] {
  return generateSuggestionsWithCost(sessions, existingText, sessionCostUsd)
}

function pct(n: number, total: number): number { return Math.round((n / total) * 100) }

// Sessions per workspace, biggest group first — suggestions are generated per group, never across
// repos (src/instructionAdvisor.ts: "all inputs are workspace-pre-filtered").
function groupByWorkspace(sessions: SessionSummaryCard[]): Map<string, SessionSummaryCard[]> {
  const byRepo = new Map<string, SessionSummaryCard[]>()
  for (const s of sessions) {
    const key = s.workspace ?? ''
    const group = byRepo.get(key)
    if (group) group.push(s)
    else byRepo.set(key, [s])
  }
  return new Map([...byRepo].sort((a, b) => b[1].length - a[1].length))
}

// ── Suggestion generation (pure frontend) ────────────────────────────────────

interface Diagnostics {
  sessionCount: number
  withFiles: number
  withCost: number
  withToolCounts: number
  topFile: { name: string; count: number } | null
  loopSignalTypes: number
  bashHeavy: number
  scopeMatches: number
  scopeRatio: number | null
  scopeRatioUnit: 'cost' | 'turns' | null
  avgTurns: number
  highTurnCount: number
  sources: Record<string, number>
}

function getDiagnostics(sessions: SessionSummaryCard[]): Diagnostics {
  const fileFreq = new Map<string, number>()
  let withFiles = 0; let withCost = 0; let withToolCounts = 0
  const sources: Record<string, number> = {}
  for (const s of sessions) {
    const files = [...(s.filesRead ?? []), ...(s.filesChanged ?? [])]
    if (files.length > 0) withFiles++
    if (sessionCostUsd(s) > 0) withCost++
    if (Object.keys(s.toolCounts ?? {}).length > 0) withToolCounts++
    sources[s.source ?? 'unknown'] = (sources[s.source ?? 'unknown'] ?? 0) + 1
    const seen = new Set<string>()
    for (const f of files) {
      if (!seen.has(f)) { seen.add(f); fileFreq.set(f, (fileFreq.get(f) ?? 0) + 1) }
    }
  }
  const topEntry = [...fileFreq.entries()].sort((a, b) => b[1] - a[1])[0]
  const loopTypes = new Set<string>()
  for (const s of sessions) { for (const sig of s.loopSignals ?? []) loopTypes.add(sig.type) }
  const bashHeavy = sessions.filter(s => {
    const tc = Object.entries(s.toolCounts ?? {})
    const bash = tc.filter(([k]) => BASH_TOOLS.has(k)).reduce((a, [, v]) => a + v, 0)
    const read = tc.filter(([k]) => READ_TOOLS.has(k)).reduce((a, [, v]) => a + v, 0)
    return bash > 0 && read > 0 && bash > read * 3
  }).length
  const withTurns = sessions.filter(s => s.totalLlmCalls > 0)
  const avgTurns = withTurns.length ? withTurns.reduce((a, s) => a + s.totalLlmCalls, 0) / withTurns.length : 0
  const highTurnCount = withTurns.filter(s => s.totalLlmCalls > avgTurns * 1.5).length
  const scopeMatching = sessions.filter(s => SCOPE_PATTERNS.some(re => re.test(s.userRequest ?? '')))
  const scopeMatches = scopeMatching.length
  const avgCost = sessions.length ? sessions.reduce((a, s) => a + sessionCostUsd(s), 0) / sessions.length : 0
  const useCost = avgCost > 0
  const baseline = useCost ? avgCost : avgTurns
  const matchAvg = scopeMatches ? scopeMatching.reduce((a, s) => a + (useCost ? sessionCostUsd(s) : s.totalLlmCalls), 0) / scopeMatches : 0
  return {
    sessionCount: sessions.length, withFiles, withCost, withToolCounts,
    topFile: topEntry ? { name: topEntry[0].replace(/\\/g, '/').split('/').pop() ?? topEntry[0], count: topEntry[1] } : null,
    loopSignalTypes: loopTypes.size, bashHeavy, scopeMatches,
    scopeRatio: baseline > 0 && scopeMatches > 0 ? matchAvg / baseline : null,
    scopeRatioUnit: useCost ? 'cost' : avgTurns > 0 ? 'turns' : null,
    avgTurns, highTurnCount, sources,
  }
}

// ── Formatting helpers ────────────────────────────────────────────────────────

function changePctLabel(pct: number | null): string | null {
  if (pct === null) return null
  const sign = pct < 0 ? '↓' : pct > 0 ? '↑' : '→'
  return `${sign} ${Math.abs(Math.round(pct))}%`
}

function changePctColor(pct: number | null): string {
  if (pct === null) return 'var(--muted)'
  if (pct < -10) return '#81c784'
  if (pct >  10) return '#e57373'
  return 'var(--muted)'
}

// ── Components ────────────────────────────────────────────────────────────────


function InsufficientDataState({ workspace, count }: { workspace: string | null; count: number }) {
  return (
    <div style="padding:32px 24px;max-width:480px;margin:0 auto;text-align:center">
      <div style="font-size:12px;color:var(--muted);line-height:1.5">
        Not enough history yet — TraceRoost needs at least 3 sessions
        {workspace !== null ? <><span> in </span><strong style="color:var(--fg)">{workspace}</strong></> : ' in one repo'}
        {' '}to detect patterns.<br />
        Current: {count} trace{count !== 1 ? "s" : ""}.
      </div>
    </div>
  )
}

function FileStatusBar({ files }: { files: InstructionFile[] }) {
  if (files.length === 0) return null
  return (
    <div style="display:flex;gap:8px;flex-wrap:wrap;padding:10px 16px;border-bottom:1px solid var(--border)">
      {files.map(f => (
        <span
          key={f.agent}
          style={`font-size:10px;padding:3px 8px;border-radius:10px;border:1px solid ${f.exists ? '#81c784' : 'var(--border)'};color:${f.exists ? '#81c784' : 'var(--muted)'}`}
          title={f.exists ? f.relativePath : `Not found: ${f.relativePath}`}
        >
          {f.exists ? '✓' : '✗'} {f.label}
        </span>
      ))}
    </div>
  )
}

function TextBlock({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }
  return (
    <div>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
        <span style="font-size:11px;color:var(--muted)">{label}</span>
        <button
          onClick={copy}
          style="padding:2px 8px;font-size:10px;border-radius:3px;cursor:pointer;border:1px solid var(--border);background:transparent;color:var(--muted);white-space:nowrap"
        >{copied ? '✓ Copied' : 'Copy'}</button>
      </div>
      <pre style="margin:0;padding:8px;font-size:11px;font-family:monospace;background:var(--vscode-input-background,#3c3c3c);color:var(--vscode-input-foreground,#ccc);border:1px solid var(--vscode-input-border,#555);border-radius:3px;white-space:pre-wrap;word-break:break-word;line-height:1.5">{text}</pre>
    </div>
  )
}

function SuggestionCardView({
  card, files, repoWorkspace, onApply, onDismiss,
}: {
  card: SuggestionCard
  /** Empty when this card can't be applied (no folder to write into): the picker is hidden. */
  files: InstructionFile[]
  /** Shown as a pill when the card isn't already under its repo's group header. */
  repoWorkspace: string | null
  onApply: (card: SuggestionCard, targetFile: string) => void
  onDismiss: (id: string) => void
}) {
  // Target picker: the detected instruction files (getInstructionFiles), an existing one first.
  // The host resolves the choice against this card's workspace; a missing file is created on apply.
  const defaultFile = files.find(f => f.exists)?.relativePath ?? files[0]?.relativePath ?? ''
  const [targetFile, setTargetFile] = useState('')
  const [applying, setApplying] = useState(false)
  const chosen = files.some(f => f.relativePath === targetFile) ? targetFile : defaultFile

  // In flight until the host's appliedSuggestions reply hides this card; a refusal or failure
  // (shown by the host as an error) leaves it here, so re-enable after a while.
  useEffect(() => {
    if (!applying) return
    const t = setTimeout(() => setApplying(false), 5000)
    return () => clearTimeout(t)
  }, [applying])

  const catColor = CAT_COLOR[card.category]
  const info = repoInfo.value
  const repoLabel = repoWorkspace ? repoDisplayName(repoWorkspace, info) : null
  const repoTitle = repoWorkspace ? repoTooltipName(repoWorkspace, info) : undefined

  return (
    <div data-suggestion-id={card.id} style="border:1px solid var(--border);border-radius:6px;margin-bottom:10px;overflow:hidden">
      <div style="padding:10px 12px;display:flex;align-items:flex-start;gap:8px">
        <span style={`font-size:9px;padding:2px 6px;border-radius:8px;background:${catColor}22;color:${catColor};text-transform:uppercase;letter-spacing:.3px;flex-shrink:0;margin-top:1px`}>
          {card.category}
        </span>
        <div style="flex:1;min-width:0">
          <div style="font-size:12px;font-weight:600;color:var(--fg)">{card.title}</div>
          <div style="font-size:11px;color:var(--muted);margin-top:2px;line-height:1.4">{card.evidence}</div>
          <div style="display:flex;gap:4px;margin-top:4px">
            {card.targetAgents.map(a => (
              <span key={a} style="font-size:9px;padding:1px 5px;border-radius:4px;background:var(--card-bg);color:var(--muted);border:1px solid var(--border)">
                {AGENT_LABEL[a] ?? a}
              </span>
            ))}
          </div>
        </div>
        {repoLabel && (
          <span
            title={repoTitle}
            style="font-size:9px;padding:2px 7px;border-radius:8px;background:var(--card-bg);color:var(--muted);border:1px solid var(--border);flex-shrink:0;white-space:nowrap;margin-top:1px"
          >{repoLabel}</span>
        )}
        <button
          onClick={() => onDismiss(card.id)}
          style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:14px;padding:0 2px;line-height:1;flex-shrink:0"
          title="Dismiss"
        >×</button>
      </div>

      <div style="padding:10px 12px;border-top:1px solid var(--border);background:var(--card-bg);display:flex;flex-direction:column;gap:10px">
        <TextBlock label="Recommended addition:" text={card.suggestedText} />
        <TextBlock label="Ask your agent:" text={card.inquiryText} />
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          <button
            onClick={() => {
              evidenceSessionIds.value = new Set(card.evidenceSessions)
              evidenceSessionLabel.value = 'from instruction suggestion'
              evidenceSessionPrompt.value = null
              activeTab.value = 'sessions'
            }}
            style="padding:2px 8px;font-size:10px;border-radius:3px;cursor:pointer;border:1px solid var(--border);background:transparent;color:var(--muted);white-space:nowrap"
            title="View the traces that triggered this suggestion"
          >View traces ↗</button>
          {files.length > 0 && (
            <div style="display:flex;align-items:center;gap:4px;margin-left:auto;min-width:0">
              <select
                aria-label="Instruction file to apply to"
                value={chosen}
                disabled={applying}
                onChange={e => setTargetFile((e.target as HTMLSelectElement).value)}
                style="padding:2px 4px;font-size:10px;border-radius:3px;border:1px solid var(--border);background:var(--vscode-input-background,transparent);color:var(--muted);cursor:pointer;min-width:0;max-width:180px"
              >
                {files.map(f => (
                  <option key={f.relativePath} value={f.relativePath}>
                    {f.relativePath}{f.exists ? '' : ' (create)'}
                  </option>
                ))}
              </select>
              <button
                onClick={() => { setApplying(true); onApply(card, chosen) }}
                disabled={applying || !chosen}
                aria-busy={applying}
                style={`padding:2px 8px;font-size:10px;border-radius:3px;cursor:${applying ? 'default' : 'pointer'};border:1px solid var(--border);background:transparent;color:var(--fg);white-space:nowrap;opacity:${applying ? 0.6 : 1}`}
                title={`Append the recommended addition to ${chosen}`}
              >{applying ? 'Applying…' : 'Apply'}</button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function ConfidenceBar({ postCount }: { postCount: number }) {
  const filled = postCount < 3 ? 0 : postCount < 8 ? 1 : postCount < 15 ? 2 : 3
  const label = postCount < 3 ? 'Collecting data…'
    : postCount < 8  ? 'Low confidence'
    : postCount < 15 ? 'Medium confidence'
    : 'High confidence'
  const segs = [0, 1, 2]
  return (
    <div style="display:flex;align-items:center;gap:6px;margin-top:4px">
      <div style="display:flex;gap:2px">
        {segs.map(i => (
          <div key={i} style={`width:14px;height:4px;border-radius:2px;background:${i < filled ? '#4fc3f7' : 'var(--border)'}`} />
        ))}
      </div>
      <span style="font-size:10px;color:var(--muted)">{label} ({postCount} post sessions)</span>
    </div>
  )
}

function AppliedCard({
  record,
  sessions,
  onRemove,
  onViewBefore,
  onViewAfter,
}: {
  record: AppliedRecord
  sessions: SessionSummaryCard[]
  onRemove: (id: string) => void
  onViewBefore: (ids: Set<string>) => void
  onViewAfter: (ids: Set<string>) => void
}) {
  const catColor = CAT_COLOR[(record.category as SuggestionCategory)] ?? '#888'
  const appliedAtMs = record.appliedAtMs

  const afterSessions  = sessions.filter(s => s.startTime && Date.parse(s.startTime) >= appliedAtMs)
  const beforeSessions = sessions.filter(s => s.startTime && Date.parse(s.startTime) < appliedAtMs).slice(0, 20)

  const avgOf = (arr: SessionSummaryCard[], fn: (s: SessionSummaryCard) => number) =>
    arr.length === 0 ? null : arr.reduce((a, s) => a + fn(s), 0) / arr.length

  const hasBefore = !record.baselineInsufficient && beforeSessions.length > 0
  const hasAfter  = afterSessions.length >= 3

  const beforeCost   = hasBefore ? avgOf(beforeSessions, sessionCostUsd) : null
  const afterCost    = hasAfter  ? avgOf(afterSessions,  sessionCostUsd) : null
  const beforeTurns  = hasBefore ? avgOf(beforeSessions, s => s.totalLlmCalls) : null
  const afterTurns   = hasAfter  ? avgOf(afterSessions,  s => s.totalLlmCalls) : null
  const beforeErrors = hasBefore ? avgOf(beforeSessions, s => s.errors) : null
  const afterErrors  = hasAfter  ? avgOf(afterSessions,  s => s.errors) : null
  const beforeLoops  = hasBefore ? avgOf(beforeSessions, s => (s.loopSignals?.length ?? 0) > 0 ? 1 : 0) : null
  const afterLoops   = hasAfter  ? avgOf(afterSessions,  s => (s.loopSignals?.length ?? 0) > 0 ? 1 : 0) : null

  const diffPct = (b: number | null, a: number | null) =>
    b && a ? ((a - b) / b) * 100 : null

  const MetricRow = ({ label, before, after, pct, fmt = (v: number) => v.toFixed(2) }: {
    label: string; before: number | null; after: number | null; pct: number | null
    fmt?: (v: number) => string
  }) => before === null || after === null ? null : (
    <div style="font-size:11px;display:flex;gap:4px;align-items:center">
      <span style="color:var(--muted);min-width:52px">{label}</span>
      <span>{fmt(before)}</span>
      <span style="color:var(--muted)">→</span>
      <span>{fmt(after)}</span>
      {pct !== null && <span style={`color:${changePctColor(pct)};font-weight:600`}>{changePctLabel(pct)}</span>}
    </div>
  )

  return (
    <div style="border:1px solid var(--border);border-radius:6px;margin-bottom:8px;overflow:hidden">
      <div style="padding:10px 12px;display:flex;align-items:flex-start;gap:8px">
        <span style={`font-size:9px;padding:2px 6px;border-radius:8px;background:${catColor}22;color:${catColor};text-transform:uppercase;letter-spacing:.3px;flex-shrink:0;margin-top:1px`}>
          {record.category}
        </span>
        <div style="flex:1;min-width:0">
          <div style="font-size:12px;font-weight:600;color:var(--fg)">{record.title}</div>
          <div style="font-size:11px;color:var(--muted)">Applied to {record.appliedTo} — {record.appliedAt.slice(0, 10)}</div>
          <div style="font-size:10px;font-family:monospace;color:var(--muted);margin-top:4px;white-space:pre-wrap;line-height:1.4;max-height:48px;overflow:hidden">
            {record.appliedText}
          </div>

          {!hasAfter && (
            <div style="font-size:11px;color:var(--muted);margin-top:6px">Collecting data… (need 3 post-application traces)</div>
          )}

          {hasAfter && (
            <div style="margin-top:8px;display:flex;flex-direction:column;gap:3px">
              <MetricRow label="Estimated cost" before={beforeCost} after={afterCost} pct={diffPct(beforeCost, afterCost)} fmt={v => `$${v.toFixed(2)}`} />
              <MetricRow label="Turns" before={beforeTurns} after={afterTurns} pct={diffPct(beforeTurns, afterTurns)} fmt={v => v.toFixed(1)} />
              <MetricRow label="Errors" before={beforeErrors} after={afterErrors} pct={diffPct(beforeErrors, afterErrors)} fmt={v => v.toFixed(2)} />
              <MetricRow label="Loop %" before={beforeLoops} after={afterLoops} pct={diffPct(beforeLoops, afterLoops)} fmt={v => `${(v * 100).toFixed(0)}%`} />
              <ConfidenceBar postCount={afterSessions.length} />
            </div>
          )}

          <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">
            {beforeSessions.length > 0 && (
              <button
                onClick={() => onViewBefore(new Set(beforeSessions.map(s => s.sessionId)))}
                style="padding:2px 8px;font-size:10px;border-radius:4px;cursor:pointer;border:1px solid var(--border);background:transparent;color:var(--muted)"
              >View before ↗</button>
            )}
            {afterSessions.length > 0 && (
              <button
                onClick={() => onViewAfter(new Set(afterSessions.map(s => s.sessionId)))}
                style="padding:2px 8px;font-size:10px;border-radius:4px;cursor:pointer;border:1px solid var(--border);background:transparent;color:var(--muted)"
              >View after ↗</button>
            )}
          </div>
        </div>
        <button
          onClick={() => onRemove(record.id)}
          style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:11px;padding:0;white-space:nowrap"
          title="Remove from instruction file and move back to pending"
        >Remove</button>
      </div>
    </div>
  )
}

// ── One workspace's suggestions ──────────────────────────────────────────────

interface WorkspaceView {
  /** '' for traces with no recorded folder. */
  workspace: string
  sessions: SessionSummaryCard[]
  files: InstructionFile[]
  /** The host reports this folder no longer exists on disk. */
  missing: boolean
  pending: SuggestionCard[]
  applied: AppliedRecord[]
}

function workspaceView(workspace: string, sessions: SessionSummaryCard[]): WorkspaceView {
  const entry = instructionFilesByWorkspace.value[workspace]
  const files = entry?.files ?? []
  const applied = appliedSuggestions.value.filter(a => a.workspace === workspace)
  const appliedIds = new Set(applied.map(a => a.id))
  const dismissed = dismissedByWorkspace.value[workspace]
  // Existing instruction text suppresses suggestions it already covers.
  const existingText = files.map(f => f.content).join('\n')
  const pending = generateSuggestions(sessions, existingText)
    .filter(s => !appliedIds.has(s.id) && !dismissed?.has(s.id))
  return { workspace, sessions, files, missing: entry?.missing === true, pending, applied }
}

const viewTraces = (ids: Set<string>) => {
  evidenceSessionIds.value = ids
  evidenceSessionLabel.value = 'from instruction suggestion'
  evidenceSessionPrompt.value = null
  activeTab.value = 'sessions'
}

function sectionLabel(text: string, count: number) {
  return (
    <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.3px;margin-bottom:8px;display:flex;align-items:center;gap:6px">
      {text}
      <span style="font-size:10px;background:var(--card-bg);border-radius:8px;padding:1px 6px;border:1px solid var(--border)">{count}</span>
    </div>
  )
}

function ImpactSummary({ applied, sessions }: { applied: AppliedRecord[]; sessions: SessionSummaryCard[] }) {
  const measured = applied.filter(rec => {
    const after = sessions.filter(s => s.startTime && Date.parse(s.startTime) >= rec.appliedAtMs)
    return after.length >= 3 && !rec.baselineInsufficient
  })
  if (measured.length < 2) return null
  const avgChange = (fn: (rec: AppliedRecord) => { before: number | null; after: number | null }) => {
    const pairs = measured.map(fn).filter(p => p.before !== null && p.after !== null) as {before:number;after:number}[]
    if (pairs.length === 0) return null
    return pairs.reduce((a, p) => a + (p.after - p.before) / p.before, 0) / pairs.length * 100
  }
  const avgOf = (arr: SessionSummaryCard[], fn: (s: SessionSummaryCard) => number) =>
    arr.length === 0 ? null : arr.reduce((a, s) => a + fn(s), 0) / arr.length
  const split = (rec: AppliedRecord) => ({
    before: sessions.filter(s => s.startTime && Date.parse(s.startTime) < rec.appliedAtMs).slice(0, 20),
    after: sessions.filter(s => s.startTime && Date.parse(s.startTime) >= rec.appliedAtMs),
  })
  const costChange = avgChange(rec => {
    const { before, after } = split(rec)
    return { before: avgOf(before, sessionCostUsd), after: avgOf(after, sessionCostUsd) }
  })
  const turnsChange = avgChange(rec => {
    const { before, after } = split(rec)
    return { before: avgOf(before, s => s.totalLlmCalls), after: avgOf(after, s => s.totalLlmCalls) }
  })
  const improved = measured.filter(rec => {
    const { before, after } = split(rec)
    const b = avgOf(before, sessionCostUsd); const a = avgOf(after, sessionCostUsd)
    if (!b || !a) return false
    return (a - b) / b < -0.1
  }).length
  return (
    <div style="border:1px solid var(--border);border-radius:6px;padding:10px 12px;margin-bottom:12px;background:var(--card-bg)">
      <div style="font-size:11px;font-weight:600;color:var(--fg);margin-bottom:6px">
        Impact summary — {applied.length} applied · {measured.length} with data
      </div>
      <div style="display:flex;gap:16px;flex-wrap:wrap;font-size:11px">
        {costChange !== null && (
          <span>Avg cost <span style={`font-weight:600;color:${changePctColor(costChange)}`}>{changePctLabel(costChange)}</span></span>
        )}
        {turnsChange !== null && (
          <span>Avg turns <span style={`font-weight:600;color:${changePctColor(turnsChange)}`}>{changePctLabel(turnsChange)}</span></span>
        )}
        <span style="color:var(--muted)">{improved} improving · {measured.length - improved} flat/worse</span>
      </div>
    </div>
  )
}

/** Pending and applied suggestions for one workspace. `canApply` false hides the target picker and
 *  Apply (nowhere to write); `repoPill` labels each card with its repo when no group header does. */
function WorkspaceSuggestions({ view, canApply, repoPill }: { view: WorkspaceView; canApply: boolean; repoPill: boolean }) {
  const { workspace, pending, applied, sessions } = view

  function handleApply(card: SuggestionCard, targetFile: string) {
    if (vscode) {
      vscode.postMessage({
        type: 'applyInstructionSuggestion',
        id: card.id, workspace, targetFile, appliedText: card.suggestedText,
        category: card.category, title: card.title, suggestedText: card.suggestedText,
      })
    } else {
      // No host at all (a bare preview): optimistically add to the applied list.
      appliedSuggestions.value = [
        ...appliedSuggestions.value,
        {
          id: card.id, workspace, category: card.category, title: card.title,
          suggestedText: card.suggestedText, appliedTo: targetFile,
          appliedText: card.suggestedText, appliedAt: new Date().toISOString(), appliedAtMs: Date.now(),
          baselineCostAvg: 0, baselineTurnsAvg: 0, baselineInsufficient: true,
        },
      ]
    }
  }

  function handleDismiss(id: string) {
    const prev = dismissedByWorkspace.value
    dismissedByWorkspace.value = { ...prev, [workspace]: new Set([...(prev[workspace] ?? []), id]) }
    if (vscode && workspace) vscode.postMessage({ type: 'dismissInstructionSuggestion', id, workspace })
  }

  function handleRemove(id: string) {
    appliedSuggestions.value = appliedSuggestions.value.filter(a => !(a.id === id && a.workspace === workspace))
    if (vscode) vscode.postMessage({ type: 'removeInstructionSuggestion', id, workspace })
  }

  return (
    <>
      {pending.length > 0 && (
        <>
          {sectionLabel('Pending', pending.length)}
          {pending.map(card => (
            <SuggestionCardView
              key={card.id}
              card={card}
              files={canApply ? view.files : []}
              repoWorkspace={repoPill && workspace ? workspace : null}
              onApply={handleApply}
              onDismiss={handleDismiss}
            />
          ))}
        </>
      )}

      {applied.length > 0 && (
        <div style="margin-top:16px">
          {sectionLabel('Applied', applied.length)}
          <ImpactSummary applied={applied} sessions={sessions} />
          {applied.map(rec => (
            <AppliedCard
              key={rec.id}
              record={rec}
              sessions={sessions}
              onRemove={handleRemove}
              onViewBefore={viewTraces}
              onViewAfter={viewTraces}
            />
          ))}
        </div>
      )}
    </>
  )
}

function DiagnosticsPanel({ sessions }: { sessions: SessionSummaryCard[] }) {
  const diag = getDiagnostics(sessions)
  return (
    <div style="padding:16px 0">
      <div style="font-size:12px;color:var(--muted);text-align:center;margin-bottom:12px">
        No patterns detected yet in <strong style="color:var(--fg)">{sessions.length} traces</strong>.
      </div>
      <div style="border:1px solid var(--border);border-radius:6px;padding:10px 14px;font-size:11px;color:var(--muted)">
        <div style="font-weight:600;color:var(--fg);margin-bottom:6px">Data available</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 16px">
          <span>Sources</span>
          <span style="color:var(--fg)">{Object.entries(diag.sources).map(([k,v]) => `${k}: ${v}`).join(', ') || 'none'}</span>
          <span>Traces with file data</span>
          <span style={`color:${diag.withFiles > 0 ? 'var(--fg)' : '#e57373'}`}>{diag.withFiles} / {diag.sessionCount}</span>
          <span>Traces with cost data</span>
          <span style={`color:${diag.withCost > 0 ? 'var(--fg)' : '#e57373'}`}>{diag.withCost} / {diag.sessionCount}</span>
          <span>Traces with tool counts</span>
          <span style={`color:${diag.withToolCounts > 0 ? 'var(--fg)' : '#e57373'}`}>{diag.withToolCounts} / {diag.sessionCount}</span>
          <span>Most-touched file</span>
          <span style="color:var(--fg)">{diag.topFile ? `${diag.topFile.name} (${diag.topFile.count} traces, ${pct(diag.topFile.count, diag.sessionCount)}%)` : 'none'}</span>
          <span>Loop signal types</span>
          <span style="color:var(--fg)">{diag.loopSignalTypes}</span>
          <span>Bash-heavy traces</span>
          <span style="color:var(--fg)">{diag.bashHeavy}</span>
          <span>Avg turns per trace</span>
          <span style="color:var(--fg)">{diag.avgTurns > 0 ? diag.avgTurns.toFixed(1) : 'no data'}</span>
          <span>High-turn traces</span>
          <span style="color:var(--fg)">{diag.highTurnCount} / {diag.sessionCount}{diag.avgTurns > 0 ? ` (need ≥15% and avg ≥8)` : ''}</span>
          <span>Open-ended prompts</span>
          <span style="color:var(--fg)">{diag.scopeMatches}{diag.scopeRatio !== null ? ` (${diag.scopeRatio.toFixed(2)}× avg ${diag.scopeRatioUnit}, need ≥1.4×)` : diag.scopeMatches > 0 ? ' (no cost or turn data)' : ''}</span>
        </div>
        <div style="margin-top:8px;font-size:10px;color:var(--muted)">
          Thresholds: hot file ≥20% · loop signal ≥20% · terminal-heavy ≥3 sessions · high turns ≥15% at avg≥8 · open-ended prompts ≥2 at 1.4× avg turns
        </div>
      </div>
    </div>
  )
}

const noteStyle = 'margin-bottom:12px;padding:8px 12px;font-size:11px;color:var(--muted);line-height:1.5;background:var(--card-bg);border:1px solid var(--border);border-radius:4px'

function WorkspaceGroup({ view, canApply }: { view: WorkspaceView; canApply: boolean }) {
  const { workspace, missing } = view
  const info = repoInfo.value
  const note = !workspace
    ? 'These traces recorded no repo folder, so their suggestions are for reference only.'
    : missing ? 'This folder no longer exists on this machine, so suggestions can\'t be applied here.'
    : null
  return (
    <section data-instructions-workspace={workspace} style="margin-bottom:20px">
      <div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin-bottom:6px;min-width:0">
        <span style="font-size:13px;font-weight:600;color:var(--fg)" title={workspace ? repoTooltipName(workspace, info) : undefined}>
          {workspace ? repoDisplayName(workspace, info) : 'No repo recorded'}
        </span>
        {workspace && (
          <span style="font-size:10px;font-family:monospace;color:var(--muted);overflow-wrap:anywhere;min-width:0">{workspace}</span>
        )}
      </div>
      {canApply && !missing && <FileStatusBar files={view.files} />}
      {note && <div style={noteStyle}>{note}</div>}
      <WorkspaceSuggestions view={view} canApply={canApply && !!workspace && !missing} repoPill={false} />
    </section>
  )
}

// ── Main tab component ────────────────────────────────────────────────────────

export function Instructions() {
  // The real folder this VS Code window has open (dashboardPanel.ts's 'update' message) — not
  // workspaceFilter, which is the header's freeform repo *search* box and can match any historical
  // repo's sessions, not just the one Apply actually writes to (the extension host resolves
  // targetFile against vscode.workspace.workspaceFolders[0] regardless of what string the webview
  // sends it). A suggestion built from a different repo's sessions isn't just mislabeled, it's not
  // actionable there: Apply would write it into the wrong repo's instruction file.
  //
  // With no open folder the tab groups suggestions by repo instead. In the standalone dashboard
  // (instructionsAcrossWorkspaces) every group can be applied into its own repo; in an extension
  // window with nothing open they're for reference only. Either way the header's Repo filter
  // narrows which groups show.
  const workspace = currentWorkspace.value
  const sessions = filteredSessions.value
  const across = instructionsAcrossWorkspaces()

  const groups = workspace === null
    ? [...groupByWorkspace(sessions)].filter(([, g]) => g.length >= 3).map(([ws]) => ws)
    : []
  const groupKey = groups.join('\0')

  // Request instruction files and applied/dismissed state — for the open folder, or (standalone)
  // for each repo with enough traces to have suggestions, once per repo while the tab is open.
  const requested = useRef(new Set<string>())
  useEffect(() => {
    if (!vscode) return
    const wanted = workspace !== null ? [workspace] : across ? groups.filter(ws => ws !== '') : []
    for (const ws of wanted) {
      if (requested.current.has(ws)) continue
      requested.current.add(ws)
      vscode.postMessage({ type: 'getInstructionFiles', workspace: ws })
      vscode.postMessage({ type: 'getAppliedSuggestions', workspace: ws })
      vscode.postMessage({ type: 'getDismissedSuggestions', workspace: ws })
    }
  }, [workspace, across, groupKey])

  if (workspace !== null) {
    const wsSessions = sessions.filter(s => (s.workspace ?? '') === workspace)
    if (wsSessions.length < 3) {
      return <InsufficientDataState workspace={workspace} count={wsSessions.length} />
    }
    const view = workspaceView(workspace, wsSessions)
    return (
      <div>
        <FileStatusBar files={view.files} />
        <div style="padding:12px 16px">
          <WorkspaceSuggestions view={view} canApply={true} repoPill={true} />
          {view.pending.length === 0 && view.applied.length === 0 && <DiagnosticsPanel sessions={wsSessions} />}
        </div>
      </div>
    )
  }

  if (groups.length === 0) {
    return <InsufficientDataState workspace={null} count={sessions.length} />
  }

  const byWs = groupByWorkspace(sessions)
  const views = groups.map(ws => workspaceView(ws, byWs.get(ws) ?? []))
  const shown = views.filter(v => v.pending.length > 0 || v.applied.length > 0)

  return (
    <div style="padding:12px 16px">
      {!across && (
        <div style={noteStyle}>
          No repo folder is open in this window, so TraceRoost has nowhere to write instruction
          file changes — suggestions below (grouped by the repo they came from) are shown for
          reference only and can't be applied. Open a repo folder to get tailored, applicable
          suggestions for it.
        </div>
      )}
      {shown.map(v => <WorkspaceGroup key={v.workspace} view={v} canApply={across} />)}
      {shown.length === 0 && <DiagnosticsPanel sessions={sessions} />}
    </div>
  )
}
