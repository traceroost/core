/**
 * Antigravity CLI's (`agy`) vocabulary: the per-step transcript lines in
 * `~/.gemini/antigravity-cli/brain/<uuid>/.system_generated/logs/transcript.jsonl`, named by their
 * `type` (the CORTEX step type without its prefix), and the tables LogReader reads from the
 * conversation's SQLite database (`conversations/<uuid>.db`).
 *
 * Best-effort: no real agy capture is committed. Every name here comes from agentsview's parser
 * and its tests (third-party evidence) — see README → Antigravity and the "must confirm" list
 * there. A step type not listed is reported as unknown, which is exactly the signal a real
 * capture's first `traceroost doctor` run should give.
 *
 * Version: no transcript line records the agy version, so `versionOf` is absent. The database's
 * schema fingerprint is the only version signal (antigravitySchemaVersion in classify.ts): a
 * known fingerprint maps to an agy version range, any other reads `agy-schema:<12 hex>`.
 */

import type { KnownRecords } from '../types'

export const ANTIGRAVITY_RECORDS: KnownRecords = {
  nameOf: r => (typeof r['type'] === 'string' && r['type'] ? r['type'] : null),
  consumed: {
    // A turn opens here; `content` (the prompt, possibly in a <USER_REQUEST> envelope) is optional
    // — history.jsonl's `display` stands in.
    USER_INPUT:       ['step_index'],
    // Assistant text, reasoning and tool calls; any of them may be absent on a given step.
    PLANNER_RESPONSE: ['step_index'],
  },
  ignored: [
    // Injected context and bookkeeping — never a turn opener.
    'CONVERSATION_HISTORY', 'SYSTEM_MESSAGE', 'CHECKPOINT', 'ERROR_MESSAGE',
    // Tool-execution steps: the call itself is read from the planner step's `tool_calls`; these
    // lines carry no structured result, exit code or call id. Only the step types agentsview's
    // parser and tests name — any other is reported unknown until a real capture lists it.
    'RUN_COMMAND', 'VIEW_FILE', 'CODE_ACTION', 'GREP_SEARCH', 'LIST_DIRECTORY',
  ],
  // Closed-vocabulary values only; `content`, `thinking` and `tool_calls` hold free text.
  structural: [],
  reads: {
    USER_INPUT:       ['content', 'created_at', 'source'],
    PLANNER_RESPONSE: ['content', 'thinking', 'tool_calls', 'created_at'],
  },
}

/** Table → the columns LogReader selects from the conversation database. */
export const ANTIGRAVITY_SCHEMA: Readonly<Record<string, readonly string[]>> = {
  steps:             ['idx', 'step_type'],
  gen_metadata:      ['idx', 'data'],
  executor_metadata: ['idx', 'data'],
}

/** `steps.step_type` (CortexStepType) values with an established name. Others are tool or system
 *  steps; the transcript, when present, names them. */
export const ANTIGRAVITY_STEP_USER_INPUT = 14
export const ANTIGRAVITY_STEP_PLANNER_RESPONSE = 15

/** Known schema fingerprints (sha256 over `sqlite_master.sql` rows + `PRAGMA user_version`, see
 *  antigravitySchemaFingerprint in classify.ts) → the agy versions that wrote them. From
 *  agentsview's version table; one baseline, older than the 1.1.x builds its field numbers came
 *  from, so a current agy may already show an unlisted fingerprint. */
export const ANTIGRAVITY_SCHEMA_VERSIONS: Readonly<Record<string, string>> = {
  '1ca98426f561fe73223c8620a238405030fdb3014444d970e1300a6009f72f43': '1.0.7–1.0.10',
}
