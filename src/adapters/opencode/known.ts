/**
 * OpenCode's vocabulary: the `opencode.db` tables and JSON paths LogReader._parseOpenCodeDb
 * queries. A missing table or column stops the read outright, so the schema is checked first;
 * then each message is named by its role and each part by its `$.type`.
 */

import type { KnownRecords } from '../types'

/** Table → the columns the reader selects or filters on. */
export const OPENCODE_SCHEMA: Readonly<Record<string, readonly string[]>> = {
  session: ['id', 'parent_id', 'title', 'directory', 'model', 'time_created', 'tokens_input', 'tokens_output', 'tokens_reasoning', 'tokens_cache_read', 'tokens_cache_write'],
  message: ['id', 'session_id', 'data'],
  part:    ['session_id', 'message_id', 'data', 'time_created'],
}

/** A row as classification sees it: `{ table: 'message', role }` or `{ table: 'part', type }`. */
export const OPENCODE_RECORDS: KnownRecords = {
  nameOf: r => {
    if (r['table'] === 'message') return typeof r['role'] === 'string' ? `message:${r['role']}` : 'message'
    if (r['table'] === 'part') return typeof r['type'] === 'string' ? `part:${r['type']}` : 'part'
    return null
  },
  consumed: {
    'message:user':      [],
    'message:assistant': [],
    'part:text':         [],
    'part:tool':         [],
  },
  ignored: [
    'part:reasoning', 'part:step-start', 'part:step-finish', 'part:file', 'part:patch',
    'part:snapshot', 'part:agent', 'part:subtask', 'part:retry', 'part:compaction',
  ],
  structural: [],
}
