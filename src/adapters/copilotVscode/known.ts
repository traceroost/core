/**
 * Copilot Chat (VS Code)'s vocabulary: `workspaceStorage/<hash>/chatSessions/` files
 * (LogReader._parseCopilotVSCodeFile / _parseCopilotVSCodeJsonFile) and the gen_ai spans Copilot
 * emits over OTLP (summarizers/copilot.ts). The delta log names a record by its `kind`; the older
 * whole-file JSON snapshot is one record, `snapshot`. Neither file records the extension version.
 */

import type { KnownOtlp, KnownRecords } from '../types'

export const COPILOT_VSCODE_RECORDS: KnownRecords = {
  nameOf: r => (typeof r['kind'] === 'number' ? `kind:${r['kind']}` : null),
  consumed: {
    'kind:0': ['v'],
    'kind:1': ['k'],
    'kind:2': ['k', 'v'],
  },
  ignored: [],
  structural: ['v'],
}

export const COPILOT_VSCODE_SNAPSHOT: KnownRecords = {
  nameOf: () => 'snapshot',
  consumed: { snapshot: ['requests'] },
  ignored: [],
  structural: [],
}

// Copilot's span names carry model and tool names (`chat gpt-4o`, `execute_tool read_file`), so
// its spans are named by `gen_ai.operation.name` instead.
export const COPILOT_OTLP: KnownOtlp = {
  consumed: ['invoke_agent', 'chat', 'execute_tool'],
  ignored: ['embeddings', 'text_completion', 'create_agent', 'copilotLanguageModelWrapper'],
}
