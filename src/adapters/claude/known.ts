/**
 * Claude Code's vocabulary: `~/.claude/projects/**.jsonl` record `type`s (read by
 * LogReader._parseClaudeFile, segmented by claudeTurns.ts) and its OTLP names (summarizers/claude.ts,
 * OtlpIngest.processLogs). Classification only — the parsing stays in logReader.ts.
 */

import type { KnownOtlp, KnownRecords } from '../types'

export const CLAUDE_RECORDS: KnownRecords = {
  nameOf: r => (typeof r['type'] === 'string' ? r['type'] : null),
  consumed: {
    user:      ['message', 'timestamp', 'uuid'],
    assistant: ['message', 'message.usage', 'timestamp'],
  },
  // Written by Claude Code alongside the conversation; none carries usage or the prompt.
  ignored: [
    'system', 'summary', 'progress', 'attachment', 'mode',
    'file-history-snapshot', 'file-history-delta', 'queue-operation',
    'last-prompt', 'ai-title', 'custom-title', 'agent-name', 'pr-link',
    'cost-state', 'api-request', 'api-request-blob', 'api-request-shape', 'atis-latch',
    'fork-context-ref', 'session-owner', 'tools-used',
  ],
  structural: ['message', 'message.usage', 'message.usage.cache_creation', 'message.usage.server_tool_use'],
  versionOf: r => (typeof r['version'] === 'string' && r['version'] ? r['version'] : null),
  reads: {
    assistant: [
      'message.model', 'message.usage.input_tokens', 'message.usage.output_tokens',
      'message.usage.cache_read_input_tokens', 'message.usage.cache_creation_input_tokens',
    ],
  },
}

// Log event names arrive as `event.name` without the prefix (`tool_result`) or, in the body, with
// it; both spellings are listed.
export const CLAUDE_OTLP: KnownOtlp = {
  consumed: [
    'claude_code.interaction', 'claude_code.llm_request', 'claude_code.tool', 'claude_code.tool.blocked_on_user',
    'tool_result', 'claude_code.tool_result',
  ],
  ignored: [
    'claude_code.tool.execution',
    'user_prompt', 'claude_code.user_prompt',
    'api_request', 'claude_code.api_request',
    'api_error', 'claude_code.api_error',
    'tool_decision', 'claude_code.tool_decision',
  ],
}
