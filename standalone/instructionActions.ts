/**
 * The standalone server's half of the Instructions tab — the same webview messages
 * src/dashboardPanel.ts handles (getInstructionFiles, get{Applied,Dismissed}Suggestions,
 * applyInstructionSuggestion, dismissInstructionSuggestion, removeInstructionSuggestion), answered
 * with the same reply messages. Kept free of http and server state so it can be unit tested; the
 * server's /api/instruction-files and /api/instructions/* routes call it, and the page's
 * acquireVsCodeApi polyfill re-dispatches the returned `messages` exactly as the extension host
 * would have posted them.
 *
 * Unlike the extension, which acts only on the folder its window has open, this server serves every
 * repo on the machine: each message names its workspace, and the workspace must be one the
 * recorded sessions actually ran in (knownWorkspace) — never an arbitrary path from the page.
 *
 * Applied/dismissed records live in one JSON file (the extension keeps them in its SQLite
 * instruction_applied / instruction_dismissed tables; everything else this server persists is JSON),
 * keyed by (workspace, id): the same suggestion id (e.g. behavior:high_turns) can be applied in
 * several repos independently.
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
  /** Every recorded session; their `workspace` values are the only folders this server reads
   *  instruction files from or writes them into. */
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

/** `workspace` is the exact folder of at least one recorded session. That, not anything the page
 *  sends, is what makes it a place this server may read or write instruction files in. */
export function knownWorkspace(workspace: string, sessions: SessionSummaryCard[]): boolean {
  return workspace !== '' && path.isAbsolute(workspace) && sessions.some(s => s.workspace === workspace)
}

function folderExists(dir: string): boolean {
  try { return fs.statSync(dir).isDirectory() } catch { return false }
}

const unknownWorkspace = (workspace: string): InstructionResult =>
  fail(400, `TraceRoost: ${workspace} is not a workspace in the recorded sessions.`)
const missingFolder = (workspace: string): InstructionResult =>
  fail(409, `TraceRoost: ${workspace} no longer exists on this machine.`)

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

  if (type === 'getInstructionFiles') {
    if (!workspace) return fail(400, 'workspace is required')
    if (!knownWorkspace(workspace, host.sessions())) return unknownWorkspace(workspace)
    // A repo that has since been moved or deleted: nothing to list, and the page hides Apply.
    if (!folderExists(workspace)) return ok([{ type: 'instructionFiles', workspace, files: [], missing: true }])
    return ok([{ type: 'instructionFiles', workspace, files: detectInstructionFiles(workspace) }])
  }
  if (type === 'getAppliedSuggestions') {
    if (!workspace) return fail(400, 'workspace is required')
    return ok([{ type: 'appliedSuggestions', workspace, records: appliedFor(host.load(), workspace) }])
  }
  if (type === 'getDismissedSuggestions') {
    if (!workspace) return fail(400, 'workspace is required')
    const ids = host.load().dismissed.filter(d => d.workspace === workspace).map(d => d.id)
    return ok([{ type: 'dismissedSuggestions', workspace, ids }])
  }

  if (!id || !workspace) return fail(400, 'id and workspace are required')
  if (!knownWorkspace(workspace, host.sessions())) return unknownWorkspace(workspace)

  if (type === 'applyInstructionSuggestion') {
    const targetFile = m.targetFile
    const appliedText = str(m.appliedText)
    // targetFile names an instruction file in the workspace (CLAUDE.md, AGENTS.md, …);
    // `../../.bashrc` or an absolute path elsewhere must not become a write target.
    if (!targetFile || typeof targetFile !== 'string' || !isStrictlyInside(workspace, targetFile)) {
      return fail(400, `TraceRoost: Refusing to apply suggestion — ${String(targetFile)} is outside the workspace.`)
    }
    if (!appliedText) return fail(400, 'appliedText is required')
    // Don't recreate a deleted repo's folder just to hold one instruction file.
    if (!folderExists(workspace)) return missingFolder(workspace)
    try {
      appendSuggestion(path.resolve(workspace, targetFile), appliedText, id)
      const nowMs = host.now?.() ?? Date.now()
      const sessions = host.sessions().filter(s => (s.workspace ?? '') === workspace)
      const baseline = computeBaseline(sessions, nowMs)
      const appliedAt = new Date(nowMs).toISOString()
      const state = host.load()
      // INSERT OR REPLACE, as InstructionRepository.recordApplied does — but on (workspace, id), so
      // applying a suggestion in one repo leaves another repo's record of the same id alone.
      state.applied = state.applied.filter(a => !(a.id === id && a.workspace === workspace))
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
        { type: 'appliedSuggestions', workspace, records: appliedFor(state, workspace) },
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
    if (!isStrictlyInside(workspace, applied.appliedTo)) {
      return fail(400, `TraceRoost: Refusing to remove suggestion — ${applied.appliedTo} is outside the workspace.`)
    }
    // The block can't be taken out of a file that isn't there (an unmounted drive, a moved repo);
    // keep the record rather than forget text that may still be in it.
    if (!folderExists(workspace)) return missingFolder(workspace)
    try {
      removeSuggestion(path.resolve(workspace, applied.appliedTo), id, applied.appliedText)
    } catch (err) {
      return fail(500, `TraceRoost: Failed to remove suggestion — ${err}`)
    }
    state.applied = state.applied.filter(a => a !== applied)
    host.save(state)
    return ok([{ type: 'appliedSuggestions', workspace, records: appliedFor(state, workspace) }], workspace)
  }

  return fail(400, `unknown message type: ${type}`)
}
