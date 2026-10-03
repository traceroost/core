// Instruction-file suggestion rules — the ONE definition of which suggestions exist, their IDs,
// thresholds and text. Byte-for-byte identical copies live at src/suggestionRules.ts (extension
// host: MCP server, instruction telemetry, `traceroost advise`) and media/src/suggestionRules.ts
// (the Instructions tab). Neither tsconfig can import across that boundary (see
// media/src/signalFormulas.ts for why), so the file is copied, and src/test/suggestionRules.test.ts
// fails if the two copies differ. Edit one, copy it over the other. Deliberately import-free: the
// caller passes the cost function (src/pricing.ts / media/src/pricing.ts's calcSessionCostUsd,
// themselves identical) so both sides score sessions the same way.

export type SuggestionCategory = 'context' | 'behavior' | 'prompting'
// Session source ids (the same ones the per-agent prompts file is named after). OpenCode reads
// AGENTS.md; the Cursor CLI reads .cursor/rules/*.mdc and AGENTS.md.
export type TargetAgent = 'claude_code' | 'copilot' | 'codex' | 'opencode' | 'cursor'

export interface SuggestionCard {
  id: string
  category: SuggestionCategory
  title: string
  evidence: string
  suggestedText: string
  /** A copy-paste prompt asking the user's own agent to recommend the wording instead. */
  inquiryText: string
  targetAgents: TargetAgent[]
  priority: 'high' | 'medium' | 'low'
  evidenceSessions: string[]  // sessionIds that triggered this
}

/** The session fields the rules read — structurally satisfied by both SessionSummaryCard types. */
export interface SuggestionSession {
  sessionId: string
  userRequest?: string
  filesRead?: string[]
  filesChanged?: string[]
  loopSignals?: Array<{ type: string }>
  toolCounts?: Record<string, number>
  totalLlmCalls: number
  /** Primary language id (src/language.ts) — only used to add context to evidence text. */
  language?: string
}

/** " Most (7 of 9) are `python` traces." when ≥60% of at least 3 sessions share one real primary
 *  language (not `none`/`other`/unrecorded) — context for the evidence line, never a trigger. */
export function dominantLanguageNote(sessions: SuggestionSession[]): string {
  if (sessions.length < 3) return ''
  const counts = new Map<string, number>()
  for (const s of sessions) {
    if (!s.language || s.language === 'none' || s.language === 'other') continue
    counts.set(s.language, (counts.get(s.language) ?? 0) + 1)
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]
  if (!top || top[1] / sessions.length < 0.6) return ''
  return ` Most (${top[1]} of ${sessions.length}) are \`${top[0]}\` traces — naming that stack's build and test commands upfront helps.`
}

function makeId(prefix: string, key: string): string {
  return `${prefix}:${key.replace(/[^a-z0-9]/gi, '_').toLowerCase()}`
}

function pct(n: number, total: number): number { return Math.round((n / total) * 100) }

const INQUIRY_PREAMBLE = 'This is a question about my agent instruction file — please do not make any code changes, just advise on what text to add.\n\n'

function alreadyPresent(existingText: string, ...keyPhrases: string[]): boolean {
  const lower = existingText.toLowerCase()
  return keyPhrases.some(p => lower.includes(p.toLowerCase()))
}

export function getHotFileSuggestions(sessions: SuggestionSession[], existingText: string): SuggestionCard[] {
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
      targetAgents: ['claude_code', 'codex', 'opencode', 'cursor'],
      priority: ids.length / sessions.length >= 0.4 ? 'high' : 'medium',
      evidenceSessions: ids,
    })
  }
  return results.sort((a, b) => b.evidenceSessions.length - a.evidenceSessions.length).slice(0, 6)
}

export function getFrontLoadedDiscoverySuggestions(sessions: SuggestionSession[], existingText: string): SuggestionCard[] {
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
      targetAgents: ['claude_code', 'codex', 'opencode', 'cursor'],
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

export function getLoopSuggestions(sessions: SuggestionSession[], existingText: string): SuggestionCard[] {
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
      targetAgents: ['claude_code', 'codex', 'opencode', 'cursor'],
      priority: ids.length / sessions.length >= 0.4 ? 'high' : 'medium',
      evidenceSessions: ids,
    })
  }
  return results
}

export const SCOPE_PATTERNS = [
  /\brefactor\b|\bclean[- ]up\b|\bimprove\b|\boptimize\b/i,
  /\bfix the bug\b|\bmake it work\b|\bit'?s broken\b/i,
  /\bfind all\b|\blook through\b|\bcheck everywhere\b/i,
  /;\s*also\b|\band then\b|\bfinally\b/i,
]

export function getScopeSuggestions<S extends SuggestionSession>(sessions: S[], existingText: string, sessionCostUsd: (s: S) => number): SuggestionCard[] {
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

  const metric = (s: S) => useCost ? sessionCostUsd(s) : s.totalLlmCalls
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
    targetAgents: ['claude_code', 'copilot', 'codex', 'opencode', 'cursor'],
    priority: 'medium',
    evidenceSessions: matching.map(s => s.sessionId),
  }]
}

export function getHighTurnSuggestions(sessions: SuggestionSession[], existingText: string): SuggestionCard[] {
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
    evidence: `${high.length} of ${withTurns.length} traces (${pct(high.length, withTurns.length)}%) exceed 1.5× avg turn count (avg: ${avg.toFixed(0)} turns). High turn counts often indicate missing context or ambiguous scope.${dominantLanguageNote(high)}`,
    suggestedText: [
      'Before starting a task:',
      '- State what you want done, what files are involved, and what "done" looks like.',
      '- Include any constraints upfront (libraries to use, patterns to follow, things to avoid).',
      '- Paste relevant error messages or code snippets rather than describing them.',
    ].join('\n'),
    inquiryText: INQUIRY_PREAMBLE + `I've noticed that ${high.length} of ${withTurns.length} traces have turn counts more than 1.5× the average of ${avg.toFixed(0)} turns. This often signals that context or scope wasn't established clearly at the start. What would you recommend I add to my instruction file to prompt users to provide clearer upfront information before starting a task?`,
    targetAgents: ['claude_code', 'copilot', 'codex', 'opencode', 'cursor'],
    priority: 'medium',
    evidenceSessions: high.map(s => s.sessionId),
  }]
}

// Tool name aliases across agents
export const BASH_TOOLS = new Set(['Bash', 'run_in_terminal', 'execute_command'])
export const READ_TOOLS  = new Set(['Read', 'read_file', 'view_file'])

export function getToolDisciplineSuggestions(sessions: SuggestionSession[], existingText: string): SuggestionCard[] {
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
    targetAgents: ['claude_code', 'copilot', 'codex', 'opencode', 'cursor'],
    priority: 'low',
    evidenceSessions: heavy.map(s => s.sessionId),
  }]
}

export function generateSuggestions<S extends SuggestionSession>(sessions: S[], existingText: string, sessionCostUsd: (s: S) => number): SuggestionCard[] {
  if (sessions.length < 3) return []
  return [
    ...getHotFileSuggestions(sessions, existingText),
    ...getFrontLoadedDiscoverySuggestions(sessions, existingText),
    ...getLoopSuggestions(sessions, existingText),
    ...getScopeSuggestions(sessions, existingText, sessionCostUsd),
    ...getHighTurnSuggestions(sessions, existingText),
    ...getToolDisciplineSuggestions(sessions, existingText),
  ]
}
