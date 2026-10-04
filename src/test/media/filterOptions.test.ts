import * as assert from 'assert'
import './domShim'
import { makeCard, makeSummary } from './fixtures'
import {
  sessionSummary, selectedAgentFilter, languageFilter, availableLanguages, availableAgents, showAgentFilter,
  AGENT_FILTER_ORDER,
} from '../../../media/src/state'

// The Agent pills and the Language dropdown offer only what loaded traces actually have
// (state.ts availableAgents / availableLanguages), so an empty option is never shown.
suite('media — filter options come from loaded traces', () => {
  setup(() => {
    sessionSummary.value = makeSummary([])
    selectedAgentFilter.value = 'all'
    languageFilter.value = 'all'
  })
  teardown(() => {
    selectedAgentFilter.value = 'all'
    languageFilter.value = 'all'
  })

  test('languages: primary and secondary both count, listed in allowlist order', () => {
    sessionSummary.value = makeSummary([
      makeCard({ sessionId: 'a', language: 'python', languageSecondary: 'shell' }),
      makeCard({ sessionId: 'b', language: 'typescript', languageSecondary: null }),
      makeCard({ sessionId: 'c', language: 'none', languageSecondary: null }),
      makeCard({ sessionId: 'old' }), // stored before language tracking: adds nothing
    ])
    assert.deepStrictEqual(availableLanguages.value, ['typescript', 'python', 'shell', 'none'])
  })

  test('languages: no traces means no options; a selected language stays listed', () => {
    assert.deepStrictEqual(availableLanguages.value, [])
    languageFilter.value = 'dart'
    assert.deepStrictEqual(availableLanguages.value, ['dart'])
  })

  test('languages: read from every loaded trace, not the filtered set', () => {
    sessionSummary.value = makeSummary([
      makeCard({ sessionId: 'a', language: 'go', source: 'codex' }),
      makeCard({ sessionId: 'b', language: 'rust', source: 'claude_code' }),
    ])
    selectedAgentFilter.value = 'codex'
    languageFilter.value = 'go'
    assert.deepStrictEqual(availableLanguages.value, ['go', 'rust'])
  })

  test('agents: only sources with traces, in pill order', () => {
    sessionSummary.value = makeSummary([
      makeCard({ sessionId: 'a', source: 'cursor' }),
      makeCard({ sessionId: 'b', source: 'claude_code' }),
      makeCard({ sessionId: 'c', source: 'claude_code' }),
      makeCard({ sessionId: 'd', source: 'copilot' }),
    ])
    assert.deepStrictEqual(availableAgents.value, ['copilot', 'claude_code', 'cursor'])
    // Every agent with data gets a pill.
    sessionSummary.value = makeSummary(AGENT_FILTER_ORDER.map((source, i) => makeCard({ sessionId: String(i), source })))
    assert.deepStrictEqual(availableAgents.value, [...AGENT_FILTER_ORDER])
  })

  test('agents: the pill row hides with one agent and shows with two', () => {
    sessionSummary.value = makeSummary([makeCard({ sessionId: 'a', source: 'codex' })])
    assert.deepStrictEqual(availableAgents.value, ['codex'])
    assert.strictEqual(showAgentFilter.value, false)
    sessionSummary.value = makeSummary([
      makeCard({ sessionId: 'a', source: 'codex' }),
      makeCard({ sessionId: 'b', source: 'opencode' }),
    ])
    assert.strictEqual(showAgentFilter.value, true)
  })

  test('agents: a selected agent with no traces stays listed and keeps the row visible', () => {
    sessionSummary.value = makeSummary([makeCard({ sessionId: 'a', source: 'claude_code' })])
    selectedAgentFilter.value = 'opencode'
    assert.deepStrictEqual(availableAgents.value, ['claude_code', 'opencode'])
    assert.strictEqual(showAgentFilter.value, true)
    sessionSummary.value = makeSummary([])
    assert.deepStrictEqual(availableAgents.value, ['opencode'])
    assert.strictEqual(showAgentFilter.value, true)
  })
})
