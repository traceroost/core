/**
 * Copilot CLI's vocabulary: `~/.copilot/session-state/<id>/events.jsonl` event `type`s
 * (LogReader._parseCopilotFile). Its OTLP spans are classified with Copilot Chat's (gen_ai
 * operations — see copilotVscode/known.ts).
 */

import type { KnownRecords } from '../types'

export const COPILOT_RECORDS: KnownRecords = {
  nameOf: r => (typeof r['type'] === 'string' ? r['type'] : null),
  consumed: {
    'session.start':     ['data'],
    'user.message':      ['data'],
    'assistant.message': ['data'],
    'session.shutdown':  ['data.modelMetrics'],
  },
  ignored: [
    'system.message', 'abort',
    'assistant.turn_start', 'assistant.turn_end',
    'hook.start', 'hook.end',
    'tool.execution_start', 'tool.execution_complete',
    'permission.requested', 'permission.completed',
    'external_tool.requested', 'external_tool.completed',
    'session.usage_record', 'session.usage_checkpoint', 'session.auto_mode_resolved',
    'session.permissions_changed', 'session.binary_asset',
    'subagent.deselected',
    'model.turn_started', 'model.turn_ended', 'model.model_call_started', 'model.model_call_success',
    'model.captured_assignment_context', 'model.message', 'model.response', 'model.messages_snapshot',
  ],
  structural: ['data', 'data.context', 'data.modelMetrics'],
  versionOf: r => {
    if (r['type'] !== 'session.start') return null
    const v = (r['data'] as Record<string, unknown> | undefined)?.['copilotVersion']
    return typeof v === 'string' && v ? v : null
  },
  reads: {
    'session.start':     ['data.copilotVersion', 'data.startTime', 'data.context.cwd', 'data.selectedModel'],
    'user.message':      ['data.transformedContent'],
    'assistant.message': ['data.toolRequests', 'data.model', 'data.outputTokens'],
  },
}
