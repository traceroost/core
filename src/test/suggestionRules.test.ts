import * as assert from 'assert'
import * as fs from 'fs'
import * as path from 'path'
import { generateSuggestions, type SuggestionSession } from '../suggestionRules'

suite('suggestionRules — one rule set for host and webview', () => {
  test('src/suggestionRules.ts and media/src/suggestionRules.ts are byte-identical', () => {
    const root = path.resolve(__dirname, '../../..')
    assert.strictEqual(
      fs.readFileSync(path.join(root, 'media/src/suggestionRules.ts'), 'utf8'),
      fs.readFileSync(path.join(root, 'src/suggestionRules.ts'), 'utf8'),
    )
  })

  const session = (i: number, over: Partial<SuggestionSession> = {}): SuggestionSession => ({
    sessionId: `s${i}`, userRequest: 'add a flag', filesRead: [], filesChanged: [], loopSignals: [], toolCounts: {}, totalLlmCalls: 10, ...over,
  })

  test('high_turns fires, with the same ID the Instructions tab applies it under', () => {
    const sessions = [
      ...Array.from({ length: 8 }, (_, i) => session(i)),
      session(8, { totalLlmCalls: 60 }), session(9, { totalLlmCalls: 60 }),
    ]
    const ids = generateSuggestions(sessions, '', () => 0).map(s => s.id)
    assert.ok(ids.includes('behavior:high_turns'), ids.join(','))
  })

  test('discovery suggestions are keyed per file', () => {
    const sessions = Array.from({ length: 8 }, (_, i) => session(i, { filesRead: ['src/config/settings.ts'] }))
    const cards = generateSuggestions(sessions, '', () => 0)
    assert.ok(cards.some(c => c.id === 'discovery:src_config_settings_ts'))
    assert.ok(cards.every(c => c.inquiryText.length > 0))
  })

  test('a suggestion already reflected in the instruction file is suppressed', () => {
    const sessions = Array.from({ length: 8 }, (_, i) => session(i, { filesRead: ['src/config/settings.ts'] }))
    const cards = generateSuggestions(sessions, 'see settings.ts first', () => 0)
    assert.ok(!cards.some(c => c.id.includes('settings_ts')))
  })
})
