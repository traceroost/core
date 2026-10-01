import * as assert from 'assert'
import * as vscode from 'vscode'
import { exportSpans, exportSpansRedacted } from '../exportData'
import type { Span } from '../types'

function span(traceId: string, spanId: string, name: string, attrs: Record<string, string | number>, parentSpanId?: string): Span {
  return {
    traceId, spanId, parentSpanId, name,
    startTime: '1700000000000000000', endTime: '1700000001000000000',
    attributes: Object.entries(attrs).map(([key, v]) =>
      typeof v === 'string' ? { key, value: { stringValue: v } } : { key, value: { intValue: v } }),
  }
}

/** A Claude Code trace (root + one tool span), optionally tagged with the collector path it arrived on. */
function claudeTrace(traceId: string, collectorPath?: string): Span[] {
  const tag: Record<string, string> = collectorPath ? { '_traceroost.collector_path': collectorPath } : {}
  return [
    span(traceId, `${traceId}-root`, 'claude_code.interaction', { user_prompt: 'secret prompt', 'user.email': 'a@b.c', ...tag }),
    span(traceId, `${traceId}-tool`, 'claude_code.tool', { tool_name: 'Read', duration_ms: 3, ...tag }, `${traceId}-root`),
  ]
}

suite('exportData — writing export files', () => {
  const writes: Array<{ path: string; spans: Span[] }> = []
  const fsApi = vscode.workspace.fs as unknown as { writeFile: (uri: { path: string }, data: Uint8Array) => Promise<void> }
  const realWrite = fsApi.writeFile
  const base = vscode.Uri.file('/exports')

  setup(() => {
    writes.length = 0
    fsApi.writeFile = async (uri, data) => { writes.push({ path: uri.path, spans: JSON.parse(Buffer.from(data).toString('utf8')) as Span[] }) }
  })
  teardown(() => { fsApi.writeFile = realWrite })

  test('groups spans by collector endpoint and agent, one file each', async () => {
    const files = await exportSpans([...claudeTrace('t1'), ...claudeTrace('t2', '/v1/traces/../../etc')], base)
    assert.strictEqual(files.length, 2)
    assert.ok(files.every(f => /^export_claude_[A-Za-z0-9.-]+_\d{8}_\d{6}\.json$/.test(f)), files.join(', '))
    assert.ok(files.some(f => f.startsWith('export_claude_main_')), 'untagged spans go to the main endpoint')
    assert.ok(files.every(f => !f.includes('/') && !f.includes('..')), 'span-supplied paths cannot escape the folder')
    assert.deepStrictEqual(writes.map(w => w.path).sort(), files.map(f => `/exports/${f}`).sort())
    assert.deepStrictEqual(writes.map(w => w.spans.length), [2, 2])
  })

  test('spans whose trace produced no session are left out', async () => {
    const orphan = span('nope', 'x', 'some.unrelated.span', {})
    const files = await exportSpans([orphan], base)
    assert.deepStrictEqual(files, [])
    assert.deepStrictEqual(writes, [])
  })

  test('the redacted export replaces prompt and identity attributes but keeps metadata', async () => {
    const files = await exportSpansRedacted(claudeTrace('t1'), base)
    assert.strictEqual(files.length, 1)
    assert.ok(files[0].startsWith('export_redacted_claude_main_'))
    const attrs = writes[0].spans.flatMap(s => s.attributes)
    const value = (k: string) => attrs.find(a => a.key === k)?.value
    assert.deepStrictEqual(value('user_prompt'), { stringValue: '[redacted]' })
    assert.deepStrictEqual(value('user.email'), { stringValue: '[redacted]' })
    assert.deepStrictEqual(value('tool_name'), { stringValue: 'Read' })
    assert.ok(!JSON.stringify(writes[0].spans).includes('secret prompt'))
  })
})
