/**
 * Builders for the AL 08 instruction-telemetry records.
 *
 * Same discipline as `buildSessionRollup.ts`: every output field named explicitly, no spread,
 * `src/forward/` imports no `SessionSummaryCard` or `SuggestionCard`. The prose fields
 * (`suggestedText`, `evidence`, `title`) are structurally unreachable from here — the inputs
 * below carry only the id, the enums, and numbers.
 */

import * as crypto from 'crypto'
import {
  toWireTargetAgent,
  type InstructionFileState,
  type InstructionFileKind,
  type FileFootprint,
  type SuggestionEvent,
  type SuggestionCategory,
  type SuggestionPriority,
  type SuggestionAction,
} from './schema'
import { repoHash, fileHash, type RepoKeyContext } from './repoKey'

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex')
}
function nonNegInt(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0
}
function normalizeTimestamp(t: string | undefined): string | undefined {
  if (!t) return undefined
  const d = new Date(t)
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
}

// ── InstructionFileState ────────────────────────────────────────────────────

export interface InstructionFileInput {
  present: boolean
  kind: InstructionFileKind
  /** repo-relative or absolute path of the instruction file. */
  path: string
  /** File content — hashed here; `content_hash` answers "did this change" and nothing else. */
  content: string
  lineCount: number
  lastModifiedIso?: string
}

export function buildInstructionFileState(input: InstructionFileInput, ctx: RepoKeyContext): InstructionFileState {
  const state: InstructionFileState = {
    repo_hash: repoHash(ctx),
    present: input.present,
    kind: input.kind,
  }
  const pathHash = fileHash(ctx, input.path)
  if (pathHash) state.path_hash = pathHash
  if (input.present) {
    state.content_hash = sha256(input.content)
    state.line_count = nonNegInt(input.lineCount)
    const lm = normalizeTimestamp(input.lastModifiedIso)
    if (lm) state.last_modified = lm
  }
  return state
}

// ── FileFootprint ───────────────────────────────────────────────────────────

export interface FileFootprintInput {
  path: string
  sessionsRead: number
  sessionsTotal: number
  earlyReads: number
  tokenSize: number
  coveredByInstructions: boolean
}

export function buildFileFootprints(inputs: FileFootprintInput[], ctx: RepoKeyContext): FileFootprint[] {
  const repo_hash = repoHash(ctx)
  const out: FileFootprint[] = []
  for (const f of inputs.slice(0, 300)) {
    const file_hash = fileHash(ctx, f.path)
    if (!file_hash) continue
    out.push({
      repo_hash,
      file_hash,
      sessions_read: nonNegInt(f.sessionsRead),
      sessions_total: nonNegInt(f.sessionsTotal),
      early_reads: nonNegInt(f.earlyReads),
      token_size: nonNegInt(f.tokenSize),
      covered_by_instructions: f.coveredByInstructions,
    })
  }
  return out
}

// ── SuggestionEvent ─────────────────────────────────────────────────────────

export interface SuggestionEventInput {
  /** The existing `SuggestionCard.id` — hashed here, never sent raw. */
  id: string
  category: SuggestionCategory
  priority: SuggestionPriority
  targetAgents: string[]
  action: SuggestionAction
  atIso: string
  baseline?: {
    costAvg?: number
    turnsAvg?: number
    errorRate?: number
    loopRate?: number
    insufficient?: boolean
  }
}

export function buildSuggestionEvents(inputs: SuggestionEventInput[], ctx: RepoKeyContext): SuggestionEvent[] {
  const repo_hash = repoHash(ctx)
  return inputs.slice(0, 200).map((e): SuggestionEvent => {
    const ev: SuggestionEvent = {
      repo_hash,
      suggestion_id: sha256(e.id),
      category: e.category,
      priority: e.priority,
      target_agents: e.targetAgents.map(toWireTargetAgent),
      action: e.action,
      at: normalizeTimestamp(e.atIso) ?? new Date(0).toISOString(),
    }
    if (e.baseline) {
      ev.baseline = {
        cost_avg: clampNum(e.baseline.costAvg, 0, 100000),
        turns_avg: clampNum(e.baseline.turnsAvg, 0, 100000),
        error_rate: clampNum(e.baseline.errorRate, 0, 100000),
        loop_rate: clampNum(e.baseline.loopRate, 0, 1),
        insufficient: e.baseline.insufficient ?? false,
      }
    }
    return ev
  })
}

function clampNum(n: number | undefined, lo: number, hi: number): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 0
  return Math.max(lo, Math.min(hi, Math.round(n * 10000) / 10000))
}
