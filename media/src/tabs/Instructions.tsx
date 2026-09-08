import { useState, useEffect } from 'preact/hooks'
import { signal } from '@preact/signals'
import {
  workspaceFilter, filteredSessions, activeTab, evidenceSessionIds, evidenceSessionLabel, evidenceSessionPrompt, vscode,
} from '../state'
import { calcSessionCost } from '../sessionMetrics'
import type { SessionSummaryCard } from '../types'

// ── Frontend re-implementation of core analysis (mirrors src/ logic) ──────────

type SuggestionCategory = 'context' | 'behavior' | 'prompting'
type TargetAgent = 'claude_code' | 'copilot' | 'codex'

interface SuggestionCard {
  id: string
  category: SuggestionCategory
  title: string
  evidence: string
  suggestedText: string
  inquiryText: string
  targetAgents: TargetAgent[]
  priority: 'high' | 'medium' | 'low'
  evidenceSessions: string[]
}

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

export const instructionFiles = signal<InstructionFile[]>([])
export const appliedSuggestions = signal<AppliedRecord[]>([])
export const dismissedIds = signal<Set<string>>(new Set())

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
}

function sessionCostUsd(s: SessionSummaryCard): number {
  return calcSessionCost(s, 'token').totalUsd
}

function makeId(prefix: string, key: string): string {
  return `${prefix}:${key.replace(/[^a-z0-9]/gi, '_').toLowerCase()}`
}

function pct(n: number, total: number): number { return Math.round((n / total) * 100) }

// ── Suggestion generation (pure frontend) ────────────────────────────────────

const INQUIRY_PREAMBLE = 'This is a question about my agent instruction file — please do not make any code changes, just advise on what text to add.\n\n'

function alreadyPresent(existingText: string, ...keyPhrases: string[]): boolean {
  const lower = existingText.toLowerCase()
  return keyPhrases.some(p => lower.includes(p.toLowerCase()))
}

function getHotFileSuggestions(sessions: SessionSummaryCard[], existingText: string): SuggestionCard[] {
  if (sessions.length < 3) return []
  const fileFreq = new Map<string, string[]>()
  for (const s of sessions) {
    const seen = new Set<string>()
    for (const f of [...(s.filesRead ?? []), ...(s.filesChanged ?? [])]) {
      if (!seen.has(f)) {
        seen.add(f)
        if (!fileFreq.has(f)) fileFreq.set(f, [])
        fileFreq.get(f)!.push(s.sessionId)
      }
    }
  }
  const results: SuggestionCard[] = []
  for (const [file, ids] of fileFreq) {
    if (ids.length / sessions.length < 0.2) continue
    const basename = file.replace(/\\/g, '/').split('/').pop() ?? file
    if (alreadyPresent(existingText, basename)) continue
    if (basename.length < 4) continue
    const parts = file.replace(/\\/g, '/').split('/')
    const subsystem = parts.length >= 2 ? parts[parts.length - 2] : 'this area'
    results.push({
      id: makeId('hot_file', file),
      category: 'context',
      title: `Add ${basename} to instruction file`,
      evidence: `Touched in ${ids.length} of ${sessions.length} traces (${pct(ids.length, sessions.length)}%). Each agent discovery adds ~2–3 turns.`,
      suggestedText: `Always read \`${file}\` before editing ${subsystem} — it is frequently needed context.`,
      inquiryText: INQUIRY_PREAMBLE + `I've noticed that \`${basename}\` appears in ${pct(ids.length, sessions.length)}% of my agent traces, but the agent discovers it from scratch each time rather than reading it proactively. What would you recommend I add to my instruction file to ensure it's loaded at the start of relevant tasks?`,
      targetAgents: ['claude_code', 'codex'],
      priority: ids.length / sessions.length >= 0.4 ? 'high' : 'medium',
      evidenceSessions: ids,
    })
  }
  return results.sort((a, b) => b.evidenceSessions.length - a.evidenceSessions.length).slice(0, 6)
}

function getFrontLoadedDiscoverySuggestions(sessions: SessionSummaryCard[], existingText: string): SuggestionCard[] {
  if (sessions.length < 8) return []
  // Files that appear in filesRead but NEVER in filesChanged — pure read-only orientation files
  const changedEver = new Set<string>()
  for (const s of sessions) { for (const f of s.filesChanged ?? []) changedEver.add(f) }

  const readFreq = new Map<string, string[]>()
  for (const s of sessions) {
    const seen = new Set<string>()
    for (const f of s.filesRead ?? []) {
      if (seen.has(f) || changedEver.has(f)) continue
      seen.add(f)
      if (!readFreq.has(f)) readFreq.set(f, [])
      readFreq.get(f)!.push(s.sessionId)
    }
  }

  const results: SuggestionCard[] = []
  for (const [file, ids] of readFreq) {
    if (ids.length / sessions.length < 0.5) continue
    const basename = file.replace(/\\/g, '/').split('/').pop() ?? file
    if (alreadyPresent(existingText, basename)) continue
    if (basename.length < 4) continue
    results.push({
      id: makeId('discovery', file),
      category: 'context',
      title: `Load ${basename} before starting`,
      evidence: `Read without modification in ${ids.length} of ${sessions.length} traces (${pct(ids.length, sessions.length)}%). Mentioning it upfront eliminates agent discovery turns.`,
      suggestedText: `Before starting any task, read \`${file}\` — it is consistently needed as reference and is never modified directly.`,
      inquiryText: INQUIRY_PREAMBLE + `I've noticed that \`${basename}\` is read in ${pct(ids.length, sessions.length)}% of traces as reference material and is never directly modified — the agent rediscovers it from scratch each time. What would you recommend I add to my instruction file to ensure it's loaded before starting any task?`,
      targetAgents: ['claude_code', 'codex'],
      priority: 'high',
      evidenceSessions: ids,
    })
  }
  return results.sort((a, b) => b.evidenceSessions.length - a.evidenceSessions.length).slice(0, 3)
}

const LOOP_TEXT: Record<string, string> = {
  exact_tool_repeat:
    'After reading a file, do not re-read it unless you have modified it. If a tool call produces no new information, stop and ask the user rather than retrying.',
  edit_revert_cycle:
    'Before editing any file, state the exact final state you intend to produce. Do not oscillate between two states — if a second edit would revert a prior one, stop and ask for clarification.',
  error_recurrence:
    'If the same error appears twice, do not attempt a third fix without pausing to verify that the package, function, or file path actually exists.',
  runaway_steps:
    'Each task must have an explicit stopping condition. If a task has no clear end state, ask before starting. Break multi-step work into one task at a time.',
  token_runaway:
    'If input context exceeds 80K tokens without producing a final result, stop and summarize what you have tried so the user can redirect you.',
}

const LOOP_INQUIRY: Record<string, (count: number, total: number) => string> = {
  exact_tool_repeat: (count, total) =>
    `I've noticed that in ${count} of ${total} traces you re-read files you had already read without modifying them, triggering repeat tool calls. What instruction would you recommend I add to your instruction file to prevent unnecessary re-reads?`,
  edit_revert_cycle: (count, total) =>
    `I've noticed that in ${count} of ${total} traces you made an edit and then reverted it — oscillating between states. What instruction would you recommend I add to your instruction file to prevent this kind of back-and-forth?`,
  error_recurrence: (count, total) =>
    `I've noticed that in ${count} of ${total} traces you retried the same failing operation multiple times without verifying the root cause first. What instruction would you recommend I add to your instruction file to make you pause and verify before a third attempt?`,
  runaway_steps: (count, total) =>
    `I've noticed that in ${count} of ${total} traces tasks ran for many steps without a clear stopping condition. What instruction would you recommend I add to your instruction file to keep tasks bounded and prevent runaway execution?`,
  token_runaway: (count, total) =>
    `I've noticed that in ${count} of ${total} traces context grew very large without producing a final result. What instruction would you recommend I add to your instruction file to prompt you to stop and summarize when context becomes unwieldy?`,
}

function getLoopSuggestions(sessions: SessionSummaryCard[], existingText: string): SuggestionCard[] {
  if (sessions.length < 5) return []
  const signalMap = new Map<string, string[]>()
  for (const s of sessions) {
    for (const sig of s.loopSignals ?? []) {
      if (!signalMap.has(sig.type)) signalMap.set(sig.type, [])
      signalMap.get(sig.type)!.push(s.sessionId)
    }
  }
  const results: SuggestionCard[] = []
  for (const [type, ids] of signalMap) {
    if (ids.length / sessions.length < 0.2) continue
    const text = LOOP_TEXT[type]
    if (!text) continue
    // Suppress if a key phrase from the suggestion is already in the instruction file
    const keyPhrase = text.split('.')[0].slice(0, 40)
    if (alreadyPresent(existingText, keyPhrase)) continue
    results.push({
      id: makeId('loop', type),
      category: 'behavior',
      title: `Prevent ${type.replace(/_/g, ' ')} loops`,
      evidence: `Signal "${type}" detected in ${ids.length} of ${sessions.length} traces (${pct(ids.length, sessions.length)}%).`,
      suggestedText: text,
      inquiryText: INQUIRY_PREAMBLE + (LOOP_INQUIRY[type]?.(ids.length, sessions.length) ?? `I've noticed "${type.replace(/_/g, ' ')}" signals in ${ids.length} of ${sessions.length} traces. What instruction would you recommend I add to my instruction file to prevent this pattern?`),
      targetAgents: ['claude_code', 'codex'],
      priority: ids.length / sessions.length >= 0.4 ? 'high' : 'medium',
      evidenceSessions: ids,
    })
  }
  return results
}

const SCOPE_PATTERNS = [
  /\brefactor\b|\bclean[- ]up\b|\bimprove\b|\boptimize\b/i,
  /\bfix the bug\b|\bmake it work\b|\bit'?s broken\b/i,
  /\bfind all\b|\blook through\b|\bcheck everywhere\b/i,
  /;\s*also\b|\band then\b|\bfinally\b/i,
]

function getScopeSuggestions(sessions: SessionSummaryCard[], existingText: string): SuggestionCard[] {
  if (alreadyPresent(existingText, 'Prompting guidance', 'name the specific file', 'one task at a time')) return []
  if (sessions.length < 5) return []
  const matching = sessions.filter(s => SCOPE_PATTERNS.some(re => re.test(s.userRequest ?? '')))
  if (matching.length < 2) return []

  // Use cost only if the matching sessions themselves have cost data; fall back to turns otherwise
  const matchHasCost = matching.some(s => sessionCostUsd(s) > 0)
  const avgCost = sessions.reduce((s, sess) => s + sessionCostUsd(sess), 0) / sessions.length
  const avgTurns = sessions.filter(s => s.totalLlmCalls > 0).reduce((a, s) => a + s.totalLlmCalls, 0) /
    Math.max(1, sessions.filter(s => s.totalLlmCalls > 0).length)
  const useCost = matchHasCost && avgCost > 0
  const useTurns = !useCost && avgTurns > 0
  if (!useCost && !useTurns) return []

  const metric = (s: SessionSummaryCard) => useCost ? sessionCostUsd(s) : s.totalLlmCalls
  const baseline = useCost ? avgCost : avgTurns
  const matchAvg = matching.reduce((a, s) => a + metric(s), 0) / matching.length
  if (matchAvg < baseline * 1.4) return []

  const unit = useCost ? 'cost' : 'turns'
  const ratio = (matchAvg / baseline).toFixed(1)
  return [{
    id: 'prompting:scope',
    category: 'prompting',
    title: 'Add scope prompting guidance',
    evidence: `Traces with open-ended language run ${ratio}× avg ${unit} (${matching.length} of ${sessions.length} traces).`,
    suggestedText: [
      'Prompting guidance:',
      '- Always name the specific file and function. Don\'t say "refactor" — say "refactor [function] in [file]".',
      '- State the exact error message when reporting a bug, not just that something is broken.',
      '- One task at a time. Multi-part prompts ("fix X, then also do Y") should be split into separate traces.',
    ].join('\n'),
    inquiryText: INQUIRY_PREAMBLE + `I've noticed that prompts using open-ended language like "refactor" or "fix the bug" run at ${ratio}× the average ${unit} compared to more scoped prompts — across ${matching.length} of ${sessions.length} traces. What guidance would you recommend I add to my instruction file to encourage more targeted, scoped prompts from users?`,
    targetAgents: ['claude_code', 'copilot', 'codex'],
    priority: 'medium',
    evidenceSessions: matching.map(s => s.sessionId),
  }]
}

function getHighTurnSuggestions(sessions: SessionSummaryCard[], existingText: string): SuggestionCard[] {
  if (alreadyPresent(existingText, 'Before starting a task', 'what you want done', 'upfront')) return []
  if (sessions.length < 5) return []
  const withTurns = sessions.filter(s => s.totalLlmCalls > 0)
  if (withTurns.length < 5) return []
  const avg = withTurns.reduce((a, s) => a + s.totalLlmCalls, 0) / withTurns.length
  if (avg < 8) return []
  const high = withTurns.filter(s => s.totalLlmCalls > avg * 1.5)
  if (high.length / withTurns.length < 0.15) return []
  return [{
    id: 'behavior:high_turns',
    category: 'behavior',
    title: 'Reduce back-and-forth with clearer upfront context',
    evidence: `${high.length} of ${withTurns.length} traces (${pct(high.length, withTurns.length)}%) exceed 1.5× avg turn count (avg: ${avg.toFixed(0)} turns). High turn counts often indicate missing context or ambiguous scope.`,
    suggestedText: [
      'Before starting a task:',
      '- State what you want done, what files are involved, and what "done" looks like.',
      '- Include any constraints upfront (libraries to use, patterns to follow, things to avoid).',
      '- Paste relevant error messages or code snippets rather than describing them.',
    ].join('\n'),
    inquiryText: INQUIRY_PREAMBLE + `I've noticed that ${high.length} of ${withTurns.length} traces have turn counts more than 1.5× the average of ${avg.toFixed(0)} turns. This often signals that context or scope wasn't established clearly at the start. What would you recommend I add to my instruction file to prompt users to provide clearer upfront information before starting a task?`,
    targetAgents: ['claude_code', 'copilot', 'codex'],
    priority: 'medium',
    evidenceSessions: high.map(s => s.sessionId),
  }]
}

// Tool name aliases across agents
const BASH_TOOLS = new Set(['Bash', 'run_in_terminal', 'execute_command'])
const READ_TOOLS  = new Set(['Read', 'read_file', 'view_file'])

function getToolDisciplineSuggestions(sessions: SessionSummaryCard[], existingText: string): SuggestionCard[] {
  if (alreadyPresent(existingText, 'file-read tool', 'Read tool', 'cat, head, or tail')) return []
  if (sessions.length < 5) return []
  const heavy = sessions.filter(s => {
    const tc = s.toolCounts ?? {}
    const bash = Object.entries(tc).filter(([k]) => BASH_TOOLS.has(k)).reduce((a, [,v]) => a + v, 0)
    const read = Object.entries(tc).filter(([k]) => READ_TOOLS.has(k)).reduce((a, [,v]) => a + v, 0)
    return bash > 0 && read > 0 && bash > read * 3
  })
  if (heavy.length < 3) return []
  return [{
    id: 'behavior:tool_discipline',
    category: 'behavior',
    title: 'Prefer file-read tool over terminal for inspection',
    evidence: `Terminal calls exceed file-read 3× in ${heavy.length} of ${sessions.length} traces (${pct(heavy.length, sessions.length)}%).`,
    suggestedText: 'Prefer the dedicated file-read tool over running shell commands to inspect files. Use the terminal only for operations that cannot be done with a dedicated tool. Do not use cat, head, or tail to read file contents.',
    inquiryText: INQUIRY_PREAMBLE + `I've noticed that in ${heavy.length} of ${sessions.length} traces, Bash/terminal commands are used more than 3× as often as the file-reading tool to inspect file contents — cat, head, and similar shell commands instead of reading files directly. What instruction would you recommend I add to my instruction file to prevent this?`,
    targetAgents: ['claude_code', 'copilot', 'codex'],
    priority: 'low',
    evidenceSessions: heavy.map(s => s.sessionId),
  }]
}

function generateSuggestions(sessions: SessionSummaryCard[], existingText: string): SuggestionCard[] {
  if (sessions.length < 3) return []
  return [
    ...getHotFileSuggestions(sessions, existingText),
    ...getFrontLoadedDiscoverySuggestions(sessions, existingText),
    ...getLoopSuggestions(sessions, existingText),
    ...getScopeSuggestions(sessions, existingText),
    ...getHighTurnSuggestions(sessions, existingText),
    ...getToolDisciplineSuggestions(sessions, existingText),
  ]
}

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
    const bash = s.toolCounts?.['Bash'] ?? 0; const read = s.toolCounts?.['Read'] ?? 0
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


function InsufficientDataState({ workspace, count }: { workspace: string; count: number }) {
  return (
    <div style="padding:32px 24px;max-width:480px;margin:0 auto;text-align:center">
      <div style="font-size:12px;color:var(--muted);line-height:1.5">
        Not enough history yet — TraceRoost needs at least 3 sessions
        {workspace !== 'all' && <><span> in </span><strong style="color:var(--fg)">{workspace}</strong></>}
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
  card, dismissed, applied, onDismiss,
}: {
  card: SuggestionCard
  dismissed: boolean
  applied: boolean
  files: InstructionFile[]
  onApply: (id: string, targetFile: string, text: string) => void
  onDismiss: (id: string) => void
}) {
  if (dismissed || applied) return null

  const catColor = CAT_COLOR[card.category]

  return (
    <div style="border:1px solid var(--border);border-radius:6px;margin-bottom:10px;overflow:hidden">
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
        <button
          onClick={() => onDismiss(card.id)}
          style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:14px;padding:0 2px;line-height:1;flex-shrink:0"
          title="Dismiss"
        >×</button>
      </div>

      <div style="padding:10px 12px;border-top:1px solid var(--border);background:var(--card-bg);display:flex;flex-direction:column;gap:10px">
        <TextBlock label="Recommended addition:" text={card.suggestedText} />
        <TextBlock label="Ask your agent:" text={card.inquiryText} />
        <div>
          <button
            onClick={() => {
              evidenceSessionIds.value = new Set(card.evidenceSessions)
              evidenceSessionLabel.value = 'from instruction suggestion'
              evidenceSessionPrompt.value = null
              activeTab.value = 'sessions'
            }}
            style="padding:2px 8px;font-size:10px;border-radius:3px;cursor:pointer;border:1px solid var(--border);background:transparent;color:var(--muted);white-space:nowrap"
            title="View the sessions that triggered this suggestion"
          >View traces ↗</button>
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
            <div style="font-size:11px;color:var(--muted);margin-top:6px">Collecting data… (need 3 post-application sessions)</div>
          )}

          {hasAfter && (
            <div style="margin-top:8px;display:flex;flex-direction:column;gap:3px">
              <MetricRow label="Cost" before={beforeCost} after={afterCost} pct={diffPct(beforeCost, afterCost)} fmt={v => `$${v.toFixed(3)}`} />
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

// ── Prompt Analyzer panel ─────────────────────────────────────────────────────

// ── Main tab component ────────────────────────────────────────────────────────

export function Instructions() {
  const workspace = workspaceFilter.value
  const sessions = filteredSessions.value

  // Workspace-scoped sessions — use all visible sessions when no workspace is selected
  const wsSessions = workspace === 'all'
    ? sessions
    : sessions.filter(s => (s.workspace ?? '') === workspace)

  // Instruction files come from extension via message
  const files = instructionFiles.value
  const applied = appliedSuggestions.value.filter(a => a.workspace === workspace)
  const dismissed = dismissedIds.value

  // Generate suggestions from session data + existing instruction file content
  const existingText = files.map(f => f.content).join('\n')
  const appliedIds = new Set(applied.map(a => a.id))
  const suggestions = generateSuggestions(wsSessions, existingText)
    .filter(s => !appliedIds.has(s.id))

  // Request instruction files from extension when workspace changes
  useEffect(() => {
    if (workspace !== 'all' && vscode) {
      vscode.postMessage({ type: 'getInstructionFiles', workspace })
      vscode.postMessage({ type: 'getAppliedSuggestions', workspace })
      vscode.postMessage({ type: 'getDismissedSuggestions', workspace })
    }
  }, [workspace])

  function handleApply(id: string, targetFile: string, text: string) {
    const card = suggestions.find(s => s.id === id)
    if (!card) return
    if (vscode) {
      vscode.postMessage({
        type: 'applyInstructionSuggestion',
        id, workspace, targetFile, appliedText: text,
        category: card.category, title: card.title, suggestedText: card.suggestedText,
      })
    } else {
      // Standalone: optimistically add to applied list
      const nowMs = Date.now()
      appliedSuggestions.value = [
        ...appliedSuggestions.value,
        {
          id, workspace, category: card.category, title: card.title,
          suggestedText: card.suggestedText, appliedTo: targetFile,
          appliedText: text, appliedAt: new Date().toISOString(), appliedAtMs: nowMs,
          baselineCostAvg: 0, baselineTurnsAvg: 0, baselineInsufficient: true,
        },
      ]
    }
  }

  function handleDismiss(id: string) {
    dismissedIds.value = new Set([...dismissedIds.value, id])
    if (vscode) vscode.postMessage({ type: 'dismissInstructionSuggestion', id, workspace })
  }

  function handleRemove(id: string) {
    appliedSuggestions.value = appliedSuggestions.value.filter(a => a.id !== id)
    if (vscode) vscode.postMessage({ type: 'removeInstructionSuggestion', id, workspace })
  }

  if (wsSessions.length < 3) {
    return <InsufficientDataState workspace={workspace} count={wsSessions.length} />
  }

  const pendingSuggestions = suggestions.filter(s => !dismissed.has(s.id))
  const diag = pendingSuggestions.length === 0 && applied.length === 0 ? getDiagnostics(wsSessions) : null

  return (
    <div>
      <FileStatusBar files={files} />

      <div style="padding:12px 16px">
        {workspace === 'all' && (
          <div style="margin-bottom:12px;padding:8px 12px;font-size:11px;color:var(--muted);line-height:1.5;background:var(--card-bg);border:1px solid var(--border);border-radius:4px">
            Select a project above for tailored suggestions. Across all projects, only universal patterns surface.
          </div>
        )}
        {/* Pending suggestions */}
        {pendingSuggestions.length > 0 && (
          <>
            <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.3px;margin-bottom:8px;display:flex;align-items:center;gap:6px">
              Pending
              <span style="font-size:10px;background:var(--card-bg);border-radius:8px;padding:1px 6px;border:1px solid var(--border)">{pendingSuggestions.length}</span>
            </div>
            {pendingSuggestions.map(card => (
              <SuggestionCardView
                key={card.id}
                card={card}
                dismissed={dismissed.has(card.id)}
                applied={appliedIds.has(card.id)}
                files={files}
                onApply={handleApply}
                onDismiss={handleDismiss}
              />
            ))}
          </>
        )}

        {pendingSuggestions.length === 0 && applied.length === 0 && diag && (
          <div style="padding:16px 0">
            <div style="font-size:12px;color:var(--muted);text-align:center;margin-bottom:12px">
              No patterns detected yet in <strong style="color:var(--fg)">{wsSessions.length} traces</strong>.
            </div>
            <div style="border:1px solid var(--border);border-radius:6px;padding:10px 14px;font-size:11px;color:var(--muted)">
              <div style="font-weight:600;color:var(--fg);margin-bottom:6px">Data available</div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 16px">
                <span>Sources</span>
                <span style="color:var(--fg)">{Object.entries(diag.sources).map(([k,v]) => `${k}: ${v}`).join(', ') || 'none'}</span>
                <span>Sessions with file data</span>
                <span style={`color:${diag.withFiles > 0 ? 'var(--fg)' : '#e57373'}`}>{diag.withFiles} / {diag.sessionCount}</span>
                <span>Sessions with cost data</span>
                <span style={`color:${diag.withCost > 0 ? 'var(--fg)' : '#e57373'}`}>{diag.withCost} / {diag.sessionCount}</span>
                <span>Sessions with tool counts</span>
                <span style={`color:${diag.withToolCounts > 0 ? 'var(--fg)' : '#e57373'}`}>{diag.withToolCounts} / {diag.sessionCount}</span>
                <span>Most-touched file</span>
                <span style="color:var(--fg)">{diag.topFile ? `${diag.topFile.name} (${diag.topFile.count} sessions, ${pct(diag.topFile.count, diag.sessionCount)}%)` : 'none'}</span>
                <span>Loop signal types</span>
                <span style="color:var(--fg)">{diag.loopSignalTypes}</span>
                <span>Bash-heavy sessions</span>
                <span style="color:var(--fg)">{diag.bashHeavy}</span>
                <span>Avg turns per trace</span>
                <span style="color:var(--fg)">{diag.avgTurns > 0 ? diag.avgTurns.toFixed(1) : 'no data'}</span>
                <span>High-turn sessions</span>
                <span style="color:var(--fg)">{diag.highTurnCount} / {diag.sessionCount}{diag.avgTurns > 0 ? ` (need ≥15% and avg ≥8)` : ''}</span>
                <span>Open-ended prompts</span>
                <span style="color:var(--fg)">{diag.scopeMatches}{diag.scopeRatio !== null ? ` (${diag.scopeRatio.toFixed(2)}× avg ${diag.scopeRatioUnit}, need ≥1.4×)` : diag.scopeMatches > 0 ? ' (no cost or turn data)' : ''}</span>
              </div>
              <div style="margin-top:8px;font-size:10px;color:var(--muted)">
                Thresholds: hot file ≥20% · loop signal ≥20% · terminal-heavy ≥3 sessions · high turns ≥15% at avg≥8 · open-ended prompts ≥2 at 1.4× avg turns
              </div>
            </div>
          </div>
        )}

        {/* Applied suggestions */}
        {applied.length > 0 && (
          <div style="margin-top:16px">
            <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.3px;margin-bottom:8px;display:flex;align-items:center;gap:6px">
              Applied
              <span style="font-size:10px;background:var(--card-bg);border-radius:8px;padding:1px 6px;border:1px solid var(--border)">{applied.length}</span>
            </div>
            {(() => {
              // Aggregate impact summary
              const measured = applied.filter(rec => {
                const after = wsSessions.filter(s => s.startTime && Date.parse(s.startTime) >= rec.appliedAtMs)
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
              const costChange = avgChange(rec => {
                const before = wsSessions.filter(s => s.startTime && Date.parse(s.startTime) < rec.appliedAtMs).slice(0, 20)
                const after = wsSessions.filter(s => s.startTime && Date.parse(s.startTime) >= rec.appliedAtMs)
                return { before: avgOf(before, sessionCostUsd), after: avgOf(after, sessionCostUsd) }
              })
              const turnsChange = avgChange(rec => {
                const before = wsSessions.filter(s => s.startTime && Date.parse(s.startTime) < rec.appliedAtMs).slice(0, 20)
                const after = wsSessions.filter(s => s.startTime && Date.parse(s.startTime) >= rec.appliedAtMs)
                return { before: avgOf(before, s => s.totalLlmCalls), after: avgOf(after, s => s.totalLlmCalls) }
              })
              const improved = measured.filter(rec => {
                const before = wsSessions.filter(s => s.startTime && Date.parse(s.startTime) < rec.appliedAtMs).slice(0, 20)
                const after = wsSessions.filter(s => s.startTime && Date.parse(s.startTime) >= rec.appliedAtMs)
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
            })()}
            {applied.map(rec => (
              <AppliedCard
                key={rec.id}
                record={rec}
                sessions={wsSessions}
                onRemove={handleRemove}
                onViewBefore={ids => { evidenceSessionIds.value = ids; evidenceSessionLabel.value = 'from instruction suggestion'; evidenceSessionPrompt.value = null; activeTab.value = 'sessions' }}
                onViewAfter={ids => { evidenceSessionIds.value = ids; evidenceSessionLabel.value = 'from instruction suggestion'; evidenceSessionPrompt.value = null; activeTab.value = 'sessions' }}
              />
            ))}
          </div>
        )}

      </div>
    </div>
  )
}
