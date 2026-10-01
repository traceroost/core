/**
 * The standalone server's half of the Instructions tab — the same webview messages
 * src/dashboardPanel.ts handles (getInstructionFiles, get{Applied,Dismissed}Suggestions,
 * applyInstructionSuggestion, dismissInstructionSuggestion, removeInstructionSuggestion), answered
 * with the same reply messages. Kept free of http and server state so it can be unit tested; the
 * server's /api/instruction-files and /api/instructions/* routes call it, and the page's
 * acquireVsCodeApi polyfill re-dispatches the returned `messages` exactly as the extension host
 * would have posted them.
 *
 * Applied/dismissed records live in one JSON file (the extension keeps them in its SQLite
 * instruction_applied / instruction_dismissed tables; everything else this server persists is JSON).
 */
import * as fs from 'fs'
import * as path from 'path'
import { detectInstructionFiles, appendSuggestion, removeSuggestion } from '../src/instructionFiles'
import { computeBaseline } from '../src/instructionEffectiveness'
import type { AppliedSuggestion } from '../src/database/instructionRepository'
import type { SessionSummaryCard } from '../src/summarizers/summarizerTypes'
import { isStrictlyInside } from './pathGuard'

/** Largest request body the instruction routes accept (413 above it). A suggestion is a few
 *  hundred bytes of text; this leaves room for a hand-edited one without buffering anything huge. */
export const MAX_INSTRUCTION_BODY_BYTES = 256 * 1024

export interface DismissedSuggestion { id: string; workspace: string; dismissedAt: string }

export interface InstructionState {
  applied: AppliedSuggestion[]
  dismissed: DismissedSuggestion[]
}

export type WebviewMessage = Record<string, unknown>

export interface InstructionResult {
  /** HTTP status for the route's reply. */
  status: number
  /** Messages for the page to dispatch, as the extension host would have posted them. */
  messages: WebviewMessage[]
  /** Shown to the user — what the extension shows via showErrorMessage. */
  error?: string
  /** The workspace whose applied/dismissed records changed (extension: emitInstructionTelemetry). */
  changed?: string
}

export interface InstructionHost {
  /** The folder this server treats as open — the counterpart of the extension's
   *  vscode.workspace.workspaceFolders[0]. Files are resolved against it when set, and against the
   *  message's own `workspace` otherwise, exactly as dashboardPanel.ts falls back. */
  root: string | null
  sessions(): SessionSummaryCard[]
  load(): InstructionState
  save(state: InstructionState): void
  now?(): number
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

export function loadInstructionState(file: string): InstructionState {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<InstructionState>
    return {
      applied: Array.isArray(raw.applied) ? raw.applied : [],
      dismissed: Array.isArray(raw.dismissed) ? raw.dismissed : [],
    }
  } catch {
    return { applied: [], dismissed: [] }
  }
}

export function saveInstructionState(file: string, state: InstructionState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8')
  fs.renameSync(tmp, file)
}

/** Newest first, like InstructionRepository.getApplied. */
function appliedFor(state: InstructionState, workspace: string): AppliedSuggestion[] {
  return state.applied
    .filter(a => a.workspace === workspace)
    .sort((a, b) => b.appliedAt.localeCompare(a.appliedAt))
}

const ok = (messages: WebviewMessage[], changed?: string): InstructionResult => ({ status: 200, messages, changed })
const fail = (status: number, error: string): InstructionResult => ({ status, messages: [], error })

export function handleInstructionMessage(msg: unknown, host: InstructionHost): InstructionResult {
  if (typeof msg !== 'object' || msg === null) return fail(400, 'message object required')
  const m = msg as Record<string, unknown>
  const type = str(m.type)
  const workspace = str(m.workspace)
  const id = str(m.id)
  const wsRoot = host.root ?? workspace

  if (type === 'getInstructionFiles') {
    if (!wsRoot) return fail(400, 'workspace is required')
    return ok([{ type: 'instructionFiles', files: detectInstructionFiles(wsRoot) }])
  }
  if (type === 'getAppliedSuggestions') {
    if (!workspace) return fail(400, 'workspace is required')
    return ok([{ type: 'appliedSuggestions', records: appliedFor(host.load(), workspace) }])
  }
  if (type === 'getDismissedSuggestions') {
    if (!workspace) return fail(400, 'workspace is required')
    const ids = host.load().dismissed.filter(d => d.workspace === workspace).map(d => d.id)
    return ok([{ type: 'dismissedSuggestions', ids }])
  }

  if (!id || !workspace) return fail(400, 'id and workspace are required')

  if (type === 'applyInstructionSuggestion') {
    const targetFile = m.targetFile
    const appliedText = str(m.appliedText)
    // targetFile names an instruction file in the workspace (CLAUDE.md, AGENTS.md, …);
    // `../../.bashrc` or an absolute path elsewhere must not become a write target.
    if (!targetFile || typeof targetFile !== 'string' || !isStrictlyInside(wsRoot, targetFile)) {
      return fail(400, `TraceRoost: Refusing to apply suggestion — ${String(targetFile)} is outside the workspace.`)
    }
    if (!appliedText) return fail(400, 'appliedText is required')
    try {
      appendSuggestion(path.resolve(wsRoot, targetFile), appliedText, id)
      const nowMs = host.now?.() ?? Date.now()
      const sessions = host.sessions().filter(s => (s.workspace ?? '') === workspace)
      const baseline = computeBaseline(sessions, nowMs)
      const appliedAt = new Date(nowMs).toISOString()
      const state = host.load()
      // INSERT OR REPLACE on id, as InstructionRepository.recordApplied does.
      state.applied = state.applied.filter(a => a.id !== id)
      state.applied.push({
        id, workspace,
        category: str(m.category), title: str(m.title), suggestedText: str(m.suggestedText),
        appliedTo: targetFile, appliedText, appliedAt, appliedAtMs: nowMs,
        baselineCostAvg: baseline.costAvg,
        baselineTurnsAvg: baseline.turnsAvg,
        baselineErrorRate: baseline.errorRate,
        baselineLoopRate: baseline.loopRate,
        baselineInsufficient: baseline.insufficient,
      })
      host.save(state)
      return ok([
        { type: 'appliedSuggestions', records: appliedFor(state, workspace) },
        { type: 'instructionApplied', id },
      ], workspace)
    } catch (err) {
      return fail(500, `TraceRoost: Failed to apply suggestion — ${err}`)
    }
  }

  if (type === 'dismissInstructionSuggestion') {
    const state = host.load()
    // INSERT OR IGNORE, as InstructionRepository.recordDismissed does.
    if (!state.dismissed.some(d => d.id === id && d.workspace === workspace)) {
      state.dismissed.push({ id, workspace, dismissedAt: new Date(host.now?.() ?? Date.now()).toISOString() })
      host.save(state)
    }
    return ok([], workspace)
  }

  if (type === 'removeInstructionSuggestion') {
    const state = host.load()
    const applied = state.applied.find(a => a.id === id && a.workspace === workspace)
    // Nothing recorded: the extension does nothing either.
    if (!applied) return ok([])
    // appliedTo was checked on the way in; check again rather than trust a hand-edited state file.
    if (!isStrictlyInside(wsRoot, applied.appliedTo)) {
      return fail(400, `TraceRoost: Refusing to remove suggestion — ${applied.appliedTo} is outside the workspace.`)
    }
    try {
      removeSuggestion(path.resolve(wsRoot, applied.appliedTo), id, applied.appliedText)
    } catch (err) {
      return fail(500, `TraceRoost: Failed to remove suggestion — ${err}`)
    }
    state.applied = state.applied.filter(a => a.id !== id)
    host.save(state)
    return ok([{ type: 'appliedSuggestions', records: appliedFor(state, workspace) }], workspace)
  }

  return fail(400, `unknown message type: ${type}`)
}
