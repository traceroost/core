/**
 * Cursor CLI's vocabulary: `~/.cursor/projects/<ws>/agent-transcripts/**.jsonl`
 * (LogReader._parseCursorFile). Message lines carry a `role` and no `type`; they are named
 * `role:<role>`. Nothing in the transcript records the cursor-agent version.
 */

import type { KnownRecords } from '../types'

export const CURSOR_RECORDS: KnownRecords = {
  nameOf: r => {
    if (typeof r['type'] === 'string') return r['type']
    return typeof r['role'] === 'string' ? `role:${r['role']}` : null
  },
  consumed: {
    'role:user':      ['message'],
    'role:assistant': ['message'],
    turn_ended:       ['status'],
  },
  ignored: [],
  structural: ['message'],
}
