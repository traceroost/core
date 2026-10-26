import * as assert from 'assert'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { LogReader, tokenUsage } from '../logReader'
import { calcSessionCostUsd } from '../pricing'

// A usage field that isn't a number (a string, null, an object) used to be added as-is, so one
// odd line turned a trace's token totals into string concatenations ("1000x00") and its cost into
// NaN. Such a field now counts as 0.

suite('LogReader — non-numeric token counts', () => {
  let tmpDir: string
  setup(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-usage-')) })
  teardown(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  test('tokenUsage keeps only finite, non-negative numbers', () => {
    assert.deepStrictEqual(
      tokenUsage({ input_tokens: 10, output_tokens: '5', cache_read_input_tokens: null, x: NaN, y: -1, z: { a: 1 }, speed: 'fast' }),
      { input_tokens: 10 },
    )
    assert.strictEqual(tokenUsage(undefined), undefined)
    assert.strictEqual(tokenUsage('usage'), undefined)
    assert.strictEqual(tokenUsage([1, 2]), undefined)
  })

  test('a Claude Code line with a string token count yields numeric totals and a finite cost', () => {
    const filePath = path.join(tmpDir, 'sess.jsonl')
    fs.writeFileSync(filePath, [
      { type: 'user', cwd: '/w', timestamp: '2026-01-01T00:00:00.000Z', message: { content: 'fix it' } },
      { type: 'assistant', timestamp: '2026-01-01T00:00:05.000Z', message: { id: 'm1', model: 'claude-sonnet-4-6', content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 'x', cache_creation_input_tokens: null } } },
      { type: 'assistant', timestamp: '2026-01-01T00:00:06.000Z', message: { id: 'm2', model: 'claude-sonnet-4-6', content: [{ type: 'text', text: 'done' }],
        usage: { input_tokens: '7', output_tokens: 5 } } },
    ].map(l => JSON.stringify(l)).join('\n') + '\n')
    const results = new LogReader().parseFile(filePath, 'claude')
    assert.strictEqual(results.length, 1)
    const card = results[0].card
    assert.strictEqual(card.inputTokens, 100)
    assert.strictEqual(card.outputTokens, 25)
    assert.strictEqual(card.cacheReadTokens, 0)
    const cost = calcSessionCostUsd(card)
    assert.ok(Number.isFinite(cost) && cost > 0, `cost ${cost}`)
  })
})
