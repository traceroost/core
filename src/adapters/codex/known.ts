/**
 * Codex's vocabulary: `~/.codex/sessions/**\/rollout-*.jsonl` records (LogReader._parseCodexFile,
 * codexTurnRanges) and its OTLP log event names (OtlpIngest.processLogs, summarizers/codex.ts).
 * An `event_msg` is named by its payload type (`event_msg:token_count`); every `response_item` is
 * skipped, so it is named by its top-level type alone.
 *
 * From 0.167 (and the VS Code extension's 0.154–0.164 alphas) the prompt comes as an
 * `event_msg:item_completed` with a `UserMessage` item instead of `event_msg:user_message`
 * (LogReader codexPromptText). `token_usage_record` repeats token_count's usage per response.
 */

import type { KnownOtlp, KnownRecords } from '../types'

export const CODEX_RECORDS: KnownRecords = {
  nameOf: r => {
    const type = r['type']
    if (typeof type !== 'string') return null
    if (type !== 'event_msg') return type
    const payload = r['payload'] as Record<string, unknown> | undefined
    return typeof payload?.['type'] === 'string' ? `event_msg:${payload['type']}` : 'event_msg'
  },
  consumed: {
    session_meta:              ['payload.id', 'payload.cwd'],
    turn_context:              ['payload.model'],
    'event_msg:user_message':  ['payload.message'],
    'event_msg:token_count':   ['payload'],
    'event_msg:task_started':  [],
    'event_msg:turn_aborted':  [],
    'event_msg:item_completed': ['payload.item'],
  },
  ignored: [
    'response_item', 'compacted',
    'event_msg:agent_message', 'event_msg:agent_message_delta',
    'event_msg:agent_reasoning', 'event_msg:agent_reasoning_delta',
    'event_msg:agent_reasoning_raw_content', 'event_msg:agent_reasoning_section_break',
    'event_msg:task_complete', 'event_msg:turn_diff', 'event_msg:plan_update',
    'event_msg:exec_command_begin', 'event_msg:exec_command_end', 'event_msg:exec_command_output_delta',
    'event_msg:exec_approval_request', 'event_msg:apply_patch_approval_request',
    'event_msg:patch_apply_begin', 'event_msg:patch_apply_end',
    'event_msg:mcp_tool_call_begin', 'event_msg:mcp_tool_call_end',
    'event_msg:web_search_begin', 'event_msg:web_search_end',
    'event_msg:view_image_tool_call', 'event_msg:background_event', 'event_msg:stream_error',
    'event_msg:error', 'event_msg:warning', 'event_msg:context_compacted',
    'event_msg:entered_review_mode', 'event_msg:exited_review_mode',
    'event_msg:session_configured', 'event_msg:shutdown_complete',
    'world_state', 'token_usage_record', 'event_msg:thread_settings_applied',
  ],
  structural: ['payload', 'payload.info', 'payload.info.total_token_usage', 'payload.info.last_token_usage', 'payload.rate_limits', 'payload.rate_limits.primary', 'payload.rate_limits.secondary'],
  versionOf: r => {
    if (r['type'] !== 'session_meta') return null
    const v = (r['payload'] as Record<string, unknown> | undefined)?.['cli_version']
    return typeof v === 'string' && v ? v : null
  },
  reads: {
    'event_msg:item_completed': ['payload.item.type', 'payload.turn_id'],
    'event_msg:token_count': [
      'payload.info.total_token_usage.input_tokens', 'payload.info.total_token_usage.cached_input_tokens',
      'payload.info.total_token_usage.output_tokens',
    ],
  },
}

export const CODEX_OTLP: KnownOtlp = {
  consumed: [
    'codex.conversation_starts', 'codex.session_start', 'codex.user_prompt', 'codex.user_message', 'codex.prompt',
    'codex.api_request', 'codex.sse_event', 'codex.stream_event', 'codex.response', 'codex.completion',
    'codex.tool_decision', 'codex.tool_result', 'codex.turn',
  ],
  ignored: ['codex.websocket_event', 'codex.websocket_request', 'codex.websocket_connect'],
}
