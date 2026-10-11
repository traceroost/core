/**
 * Builder for the AL 08 instruction-telemetry record (`instruction_files` — the only one sent;
 * `file_footprints` and `suggestion_events` were dropped, see org/instructionTelemetry.ts).
 *
 * Same discipline as `buildSessionRollup.ts`: every output field named explicitly, no spread,
 * `src/forward/` imports no `SessionSummaryCard` or `SuggestionCard`. The prose fields
 * (`suggestedText`, `evidence`, `title`) are structurally unreachable from here — the inputs
 * below carry only the id, the enums, and numbers.
 */

import { type InstructionFileState, type InstructionFileKind } from './schema'
import { repoHash, fileHash, instructionContentHash, type RepoKeyContext } from '../../repoKey'

// Mirrors #/$defs/count's `maximum` in schema/rollup.v1.json, as buildSessionRollup.ts does: a
// clamped count loses a little precision on one field; an out-of-range one fails validation and
// loses the whole payload.
const MAX_COUNT = 100_000_000
function nonNegInt(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.min(MAX_COUNT, Math.round(n)) : 0
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
  /** File content — HMAC'd under the repo key here; `content_hash` answers "did this change" and
   *  nothing else. */
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
    state.content_hash = instructionContentHash(ctx, input.content)
    state.line_count = nonNegInt(input.lineCount)
    const lm = normalizeTimestamp(input.lastModifiedIso)
    if (lm) state.last_modified = lm
  }
  return state
}
