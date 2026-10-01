import * as assert from 'assert'
import './domShim'
import { getOutputTokens } from '../../../media/src/utils'
import { extractTokenCounts } from '../../summarizers/helpers'
import type { Span } from '../../types'

function span(attrs: Record<string, number>): Span {
  return {
    traceId: 't', spanId: 's', name: 'codex.sse_event', startTime: '0', endTime: '0',
    attributes: Object.entries(attrs).map(([key, v]) => ({ key, value: { intValue: v } })),
  } as Span
}

suite('media/utils getOutputTokens — parity with src/summarizers/helpers.ts', () => {
  test('Codex reasoning_token_count is a breakdown of output_token_count, never added on top', () => {
    const s = span({ output_token_count: 500, reasoning_token_count: 300 })
    assert.strictEqual(getOutputTokens(s), 500)
    assert.strictEqual(getOutputTokens(s), extractTokenCounts(s).output)
  })

  test('agrees with src on every output-token key and their precedence', () => {
    const cases: Array<Record<string, number>> = [
      { 'gen_ai.usage.output_tokens': 10, output_tokens: 20 },
      { output_tokens: 20, completion_tokens: 30 },
      { completion_tokens: 30 },
      { 'codex.turn.token_usage.output_tokens': 40, output_token_count: 50 },
      { output_token_count: 50, reasoning_token_count: 7 },
      { reasoning_token_count: 7 },
      {},
    ]
    for (const attrs of cases) {
      const s = span(attrs)
      assert.strictEqual(getOutputTokens(s), extractTokenCounts(s).output, JSON.stringify(attrs))
    }
  })
})
