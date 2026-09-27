/**
 * Instruction Advisor — pure analysis over SessionSummaryCard[].
 * All inputs are workspace-pre-filtered; no I/O here.
 */

import type { SessionSummaryCard } from './summarizers/summarizerTypes'
import { calcSessionCostUsd } from './pricing'

export type SuggestionCategory = 'context' | 'behavior' | 'prompting'

export type TargetAgent = 'claude_code' | 'copilot' | 'codex'

export interface SuggestionCard {
  id: string
  category: SuggestionCategory
  title: string
  evidence: string
  suggestedText: string
  targetAgents: TargetAgent[]
  priority: 'high' | 'medium' | 'low'
  evidenceSessions: string[]  // sessionIds that triggered this
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function sessionCost(s: SessionSummaryCard): number {
  return calcSessionCostUsd(s)
}

function subsystemFromPath(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/')
  if (parts.length >= 2) return parts[parts.length - 2]
  return 'this area'
}

function roleFromFilename(name: string): string {
  const base = name.split('.')[0]
  const MAP: Record<string, string> = {
    types: 'shared type definitions',
    schema: 'data schema definitions',
    helpers: 'shared utility functions',
    utils: 'utility functions',
    config: 'configuration',
    constants: 'constants and enums',
    index: 'module entry point',
    db: 'database access layer',
    state: 'application state',
  }
  return MAP[base] ?? `${base} definitions`
}

function makeId(category: string, key: string): string {
  return `${category}:${key.replace(/[^a-z0-9]/gi, '_').toLowerCase()}`
}

// ── Suggestion generators ─────────────────────────────────────────────────────

export function getHotFileSuggestions(
  sessions: SessionSummaryCard[],
  existingInstructionText: string,
): SuggestionCard[] {
  if (sessions.length < 5) return []

  const fileFreq = new Map<string, string[]>()  // file → sessionIds
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

  const threshold = 0.4
  const results: SuggestionCard[] = []

  for (const [file, sessionIds] of fileFreq) {
    const pct = sessionIds.length / sessions.length
    if (pct < threshold) continue
    const basename = file.replace(/\\/g, '/').split('/').pop() ?? file
    // Skip if already mentioned in instruction files
    if (existingInstructionText.toLowerCase().includes(basename.toLowerCase())) continue
    // Skip very short/generic names
    if (basename.length < 4 || basename === 'index.ts' || basename === 'index.js') continue

    const pctLabel = Math.round(pct * 100)
    const subsystem = subsystemFromPath(file)
    const role = roleFromFilename(basename.split('.')[0])

    results.push({
      id: makeId('hot_file', file),
      category: 'context',
      title: `Add ${basename} to instruction file`,
      evidence: `Read in ${sessionIds.length} of ${sessions.length} sessions (${pctLabel}%). Each agent discovery adds ~2–3 turns.`,
      suggestedText: `Always read \`${file}\` before editing ${subsystem} — it contains ${role}.`,
      targetAgents: ['claude_code', 'codex'],
      priority: pct >= 0.6 ? 'high' : 'medium',
      evidenceSessions: sessionIds,
    })
  }

  return results.sort((a, b) => {
    const aCount = a.evidenceSessions.length
    const bCount = b.evidenceSessions.length
    return bCount - aCount
  }).slice(0, 6)
}

export function getLoopPreventionSuggestions(
  sessions: SessionSummaryCard[],
  _existingInstructionText: string,
): SuggestionCard[] {
  if (sessions.length < 5) return []

  const SIGNAL_TEXT: Record<string, string> = {
    exact_tool_repeat:
      'After reading a file, do not re-read it unless you have modified it. ' +
      'If a tool call produces no new information, stop and ask the user rather than retrying.',
    edit_revert_cycle:
      'Before editing any file, state the exact final state you intend to produce. ' +
      'Do not oscillate between two states — if a second edit would revert a prior one, stop and ask for clarification.',
    error_recurrence:
      'If the same error appears twice, do not attempt a third fix without pausing to verify ' +
      'that the package, function, or file path actually exists.',
    runaway_steps:
      'Each task must have an explicit stopping condition. If a task has no clear end state, ' +
      'ask before starting. Break multi-step work into one task at a time.',
    token_runaway:
      'If input context exceeds 80K tokens without producing a final result, stop and summarize ' +
      'what you have tried so the user can redirect you.',
  }

  const signalSessions = new Map<string, string[]>()
  for (const s of sessions) {
    for (const sig of s.loopSignals ?? []) {
      if (!signalSessions.has(sig.type)) signalSessions.set(sig.type, [])
      signalSessions.get(sig.type)!.push(s.sessionId)
    }
  }

  const results: SuggestionCard[] = []
  const threshold = 0.2

  for (const [type, sessionIds] of signalSessions) {
    const pct = sessionIds.length / sessions.length
    if (pct < threshold) continue
    const text = SIGNAL_TEXT[type]
    if (!text) continue
    const pctLabel = Math.round(pct * 100)

    results.push({
      id: makeId('loop', type),
      category: 'behavior',
      title: `Prevent ${type.replace(/_/g, ' ')} loops`,
      evidence: `Signal "${type}" detected in ${sessionIds.length} of ${sessions.length} sessions (${pctLabel}%).`,
      suggestedText: text,
      targetAgents: ['claude_code', 'codex'],
      priority: pct >= 0.4 ? 'high' : 'medium',
      evidenceSessions: sessionIds,
    })
  }

  return results
}

export function getFrontLoadedDiscoverySuggestions(
  sessions: SessionSummaryCard[],
  existingInstructionText: string,
): SuggestionCard[] {
  if (sessions.length < 8) return []

  // Files that appear in the first 3 turns of > 50% of sessions.
  // We approximate "first 3 turns" by checking filesRead (short-path basenames
  // that the agent reads early — this is heuristic since we don't track turn order per file).
  const fileFreq = new Map<string, string[]>()
  for (const s of sessions) {
    const seen = new Set<string>()
    for (const f of s.filesRead ?? []) {
      if (!seen.has(f)) {
        seen.add(f)
        if (!fileFreq.has(f)) fileFreq.set(f, [])
        fileFreq.get(f)!.push(s.sessionId)
      }
    }
  }

  const threshold = 0.5
  const candidates: Array<{ file: string; sessionIds: string[] }> = []

  for (const [file, sessionIds] of fileFreq) {
    if (sessionIds.length / sessions.length >= threshold) {
      const basename = file.replace(/\\/g, '/').split('/').pop() ?? file
      if (existingInstructionText.toLowerCase().includes(basename.toLowerCase())) continue
      candidates.push({ file, sessionIds })
    }
  }

  if (candidates.length < 2) return []

  const top = candidates.sort((a, b) => b.sessionIds.length - a.sessionIds.length).slice(0, 4)
  const allIds = new Set(top.flatMap(c => c.sessionIds))
  const pct = Math.round((allIds.size / sessions.length) * 100)

  // Infer subsystem from common path prefix
  const paths = top.map(c => c.file)
  const subsystem = subsystemFromPath(paths[0])
  const lines = top.map(c => {
    const basename = c.file.replace(/\\/g, '/').split('/').pop() ?? c.file
    return `- \`${c.file}\` — ${roleFromFilename(basename.split('.')[0])}`
  }).join('\n')

  return [{
    id: makeId('discovery', paths.join(',')),
    category: 'context',
    title: `Pre-load ${subsystem} entry points`,
    evidence: `These files appear early in ${pct}% of sessions — the agent always discovers them before doing useful work.`,
    suggestedText: `Key entry points for ${subsystem}:\n${lines}\nReview these before beginning any ${subsystem} task.`,
    targetAgents: ['claude_code', 'codex'],
    priority: 'medium',
    evidenceSessions: [...allIds],
  }]
}

const SCOPE_PATTERNS = [
  { re: /\brefactor\b|\bclean up\b|\bclean-up\b|\bimprove\b|\boptimize\b/i, label: 'open-ended refactor' },
  { re: /\bfix the bug\b|\bmake it work\b|\bit'?s broken\b/i,               label: 'fix without specifics' },
  { re: /\bfind all\b|\blook through\b|\bcheck everywhere\b/i,             label: 'discovery task' },
  { re: /;\s*also\b|and then\b|\bfinally\b/i,                              label: 'multi-part task' },
]

export function getScopeSuggestions(
  sessions: SessionSummaryCard[],
  _existingInstructionText: string,
): SuggestionCard[] {
  if (sessions.length < 8) return []

  const avgCost = sessions.reduce((s, sess) => s + sessionCost(sess), 0) / sessions.length
  if (avgCost === 0) return []

  const matchingSessions: string[] = []
  let matchCost = 0

  for (const s of sessions) {
    const req = s.userRequest ?? ''
    const matched = SCOPE_PATTERNS.some(p => p.re.test(req))
    if (matched) {
      matchingSessions.push(s.sessionId)
      matchCost += sessionCost(s)
    }
  }

  if (matchingSessions.length < 3) return []
  const matchAvg = matchCost / matchingSessions.length
  if (matchAvg < avgCost * 1.8) return []

  const pct = Math.round((matchingSessions.length / sessions.length) * 100)

  return [{
    id: 'prompting:scope',
    category: 'prompting',
    title: 'Add scope prompting guidance',
    evidence: `Sessions with open-ended language cost ${(matchAvg / avgCost).toFixed(1)}× average (${matchingSessions.length} of ${sessions.length} sessions, ${pct}%).`,
    suggestedText: [
      'Prompting guidance:',
      '- Always name the specific file and function. Don\'t say "refactor" — say "refactor [function] in [file]".',
      '- State the exact error message when reporting a bug, not just that something is broken.',
      '- One task at a time. Multi-part prompts ("fix X, then also do Y") should be split into separate sessions.',
    ].join('\n'),
    targetAgents: ['claude_code', 'copilot', 'codex'],
    priority: 'medium',
    evidenceSessions: matchingSessions,
  }]
}

export function getToolDisciplineSuggestions(
  sessions: SessionSummaryCard[],
  _existingInstructionText: string,
): SuggestionCard[] {
  if (sessions.length < 8) return []

  const heavyBashSessions: string[] = []
  for (const s of sessions) {
    const bash = s.toolCounts?.['Bash'] ?? 0
    const read = s.toolCounts?.['Read'] ?? 0
    if (bash > 0 && read > 0 && bash > read * 3) {
      heavyBashSessions.push(s.sessionId)
    }
  }

  if (heavyBashSessions.length < 8) return []

  const pct = Math.round((heavyBashSessions.length / sessions.length) * 100)

  return [{
    id: 'behavior:tool_discipline',
    category: 'behavior',
    title: 'Prefer Read tool over Bash for file inspection',
    evidence: `Bash calls exceed Read calls by 3× in ${heavyBashSessions.length} of ${sessions.length} sessions (${pct}%).`,
    suggestedText: 'Prefer the Read tool over Bash for file inspection. Use Bash only for shell operations that cannot be done with a dedicated tool. Do not use cat, head, or tail to read file contents.',
    targetAgents: ['claude_code', 'codex'],
    priority: 'low',
    evidenceSessions: heavyBashSessions,
  }]
}

// ── Master generator ──────────────────────────────────────────────────────────

export function generateSuggestions(
  sessions: SessionSummaryCard[],
  existingInstructionText: string,
): SuggestionCard[] {
  if (sessions.length < 5) return []

  return [
    ...getHotFileSuggestions(sessions, existingInstructionText),
    ...getLoopPreventionSuggestions(sessions, existingInstructionText),
    ...getFrontLoadedDiscoverySuggestions(sessions, existingInstructionText),
    ...getScopeSuggestions(sessions, existingInstructionText),
    ...getToolDisciplineSuggestions(sessions, existingInstructionText),
  ]
}
