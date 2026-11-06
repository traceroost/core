import * as assert from 'assert'
import * as fs from 'fs'
import * as path from 'path'
import { classifyOtlp, classifyRecord, observeOpenCodeDb, observeRecords, otlpAdapterOf, type SqlExec } from '../adapters/classify'
import { CLAUDE_RECORDS } from '../adapters/claude/known'
import { CODEX_RECORDS } from '../adapters/codex/known'
import { diffFingerprints, fingerprint } from '../adapters/fingerprint'
import { ADAPTERS, adapterForLogKey, agentKeyDir, agentKeyLabel } from '../adapters/registry'
import type { OtlpRecordView } from '../adapters/types'

const view = (o: Partial<OtlpRecordView>): OtlpRecordView => ({ name: '', serviceName: '', serviceVersion: '', genAiOperation: '', ...o })

suite('adapters — classifyRecord', () => {
  test('a consumed record with its required keys is known; an ignored one ignored; anything else unknown', () => {
    assert.deepStrictEqual(classifyRecord(CLAUDE_RECORDS, { type: 'user', message: {}, timestamp: 't', uuid: 'u' }), { cls: 'known', name: 'user' })
    assert.deepStrictEqual(classifyRecord(CLAUDE_RECORDS, { type: 'ai-title' }), { cls: 'ignored', name: 'ai-title' })
    assert.deepStrictEqual(classifyRecord(CLAUDE_RECORDS, { type: 'brand-new' }), { cls: 'unknown', name: 'brand-new' })
  })

  test('a consumed record missing a required key is unknown, named for the key', () => {
    assert.deepStrictEqual(
      classifyRecord(CLAUDE_RECORDS, { type: 'assistant', message: { content: [] }, timestamp: 't' }),
      { cls: 'unknown', name: 'assistant missing message.usage' })
  })

  test('a record with no type, or not an object, is unknown', () => {
    assert.strictEqual(classifyRecord(CLAUDE_RECORDS, { foo: 1 }).name, '(no type)')
    assert.strictEqual(classifyRecord(CLAUDE_RECORDS, [1, 2]).name, '(not an object)')
  })

  test('Codex names an event_msg by its payload type', () => {
    assert.strictEqual(classifyRecord(CODEX_RECORDS, { type: 'event_msg', payload: { type: 'token_count' } }).cls, 'known')
    assert.deepStrictEqual(classifyRecord(CODEX_RECORDS, { type: 'event_msg', payload: { type: 'item_completed' } }), { cls: 'unknown', name: 'event_msg:item_completed' })
    assert.strictEqual(classifyRecord(CODEX_RECORDS, { type: 'response_item', payload: { type: 'anything' } }).cls, 'ignored')
  })
})

suite('adapters — observeRecords', () => {
  test('counts by class, names unknowns, and takes the last version the file records', () => {
    const obs = observeRecords('claude', [
      { type: 'user', message: {}, timestamp: 't', uuid: 'u', version: '2.1.0' },
      { type: 'mystery', secret: 'do not keep me', version: '2.1.1' },
      { type: 'mystery' },
      { type: 'summary' },
    ])!
    assert.strictEqual(obs.adapter, 'claude')
    assert.strictEqual(obs.version, '2.1.1')
    assert.deepStrictEqual([obs.known, obs.ignored, obs.unknown], [1, 1, 2])
    assert.deepStrictEqual(obs.unknownNames, { mystery: 2 })
    assert.deepStrictEqual(obs.unknownFingerprints, { mystery: { secret: 'string', type: 'string', version: 'string' } })
  })

  test('an unparseable line counts as unknown except the last, which may still be being written', () => {
    const obs = observeRecords('cursor', [undefined, { role: 'user', message: {} }, undefined])!
    assert.deepStrictEqual(obs.unknownNames, { '(unparseable)': 1 })
    assert.strictEqual(obs.version, 'unknown')
  })

  test('maps both Copilot Chat file formats onto one adapter; an unknown log key gives nothing', () => {
    assert.strictEqual(observeRecords('copilot_vscode_json', [{ requests: [] }])!.adapter, 'copilot_vscode')
    assert.strictEqual(observeRecords('copilot_vscode', [{ kind: 0, v: {} }])!.adapter, 'copilot_vscode')
    assert.strictEqual(observeRecords('nope', [{}]), null)
  })
})

suite('adapters — observeOpenCodeDb', () => {
  const fakeDb = (tables: Record<string, string[]>, groups: Record<string, unknown[][]>, version?: string): SqlExec => ({
    exec(sql: string) {
      const pragma = sql.match(/PRAGMA table_info\((\w+)\)/)
      if (pragma) return tables[pragma[1]] ? [{ columns: ['cid', 'name'], values: tables[pragma[1]].map((c, i) => [i, c]) }] : []
      if (sql.includes('FROM message GROUP BY')) return [{ columns: ['r', 'n'], values: groups['message'] ?? [] }]
      if (sql.includes('FROM part GROUP BY')) return [{ columns: ['t', 'n'], values: groups['part'] ?? [] }]
      if (sql.includes('SELECT version')) return version ? [{ columns: ['version'], values: [[version]] }] : []
      throw new Error(`unexpected ${sql}`)
    },
  })
  const fullSession = ['id', 'parent_id', 'title', 'directory', 'model', 'time_created', 'tokens_input', 'tokens_output', 'tokens_reasoning', 'tokens_cache_read', 'tokens_cache_write']

  test('counts message roles and part types from GROUP BY rows, and reads session.version', () => {
    const obs = observeOpenCodeDb(fakeDb(
      { session: [...fullSession, 'version'], message: ['id', 'session_id', 'data'], part: ['session_id', 'message_id', 'data', 'time_created'] },
      { message: [['user', 2], ['assistant', 5]], part: [['text', 4], ['step-start', 3], ['hologram', 1]] },
      '1.4.2'))
    assert.deepStrictEqual([obs.known, obs.ignored, obs.unknown], [11, 3, 1])
    assert.deepStrictEqual(obs.unknownNames, { 'part:hologram': 1 })
    assert.strictEqual(obs.version, '1.4.2')
  })

  test('a missing table or column the reader needs is unknown', () => {
    const obs = observeOpenCodeDb(fakeDb({ session: fullSession.filter(c => c !== 'directory'), message: ['id', 'session_id', 'data'] }, {}))
    assert.deepStrictEqual(obs.unknownNames, { 'session.directory missing': 1, 'table part missing': 1 })
    assert.strictEqual(obs.version, 'unknown')
  })
})

suite('adapters — OTLP', () => {
  test('attributes a record to an agent by service name or name prefix, or to none', () => {
    assert.strictEqual(otlpAdapterOf(view({ name: 'user_prompt', serviceName: 'claude-code' })), 'claude')
    assert.strictEqual(otlpAdapterOf(view({ name: 'claude_code.interaction' })), 'claude')
    assert.strictEqual(otlpAdapterOf(view({ name: 'codex.sse_event' })), 'codex')
    assert.strictEqual(otlpAdapterOf(view({ name: 'chat gpt-4o', genAiOperation: 'chat' })), 'copilot_vscode')
    assert.strictEqual(otlpAdapterOf(view({ name: 'chat', serviceName: 'github-copilot-cli', genAiOperation: 'chat' })), 'copilot')
    assert.strictEqual(otlpAdapterOf(view({ name: 'GET /health', serviceName: 'my-api' })), null)
  })

  test('classifies log names; Copilot by gen_ai operation; Codex spans always known', () => {
    assert.strictEqual(classifyOtlp('claude', view({ name: 'tool_result' }), 'log').cls, 'known')
    assert.strictEqual(classifyOtlp('claude', view({ name: 'api_request' }), 'log').cls, 'ignored')
    assert.deepStrictEqual(classifyOtlp('claude', view({ name: 'claude_code.new_thing' }), 'span'), { cls: 'unknown', name: 'claude_code.new_thing' })
    assert.strictEqual(classifyOtlp('copilot_vscode', view({ name: 'execute_tool read_file', genAiOperation: 'execute_tool' }), 'span').cls, 'known')
    assert.strictEqual(classifyOtlp('codex', view({ name: 'handle_responses' }), 'span').cls, 'known')
    assert.strictEqual(classifyOtlp('codex', view({ name: 'codex.new_event' }), 'log').cls, 'unknown')
  })
})

suite('adapters — fingerprint', () => {
  test('key names and value types only; descends only into structural paths', () => {
    const fp = fingerprint({
      type: 'assistant', timestamp: '2026-01-01', isSidechain: false,
      message: { usage: { input_tokens: 5, cache_creation: { a: 1 } }, content: [{ text: 'hi' }], meta: { deep: 'x' } },
      toolUseResult: { stdout: 'secret output' },
    }, CLAUDE_RECORDS)
    assert.deepStrictEqual(fp, {
      isSidechain: 'boolean',
      message: { content: 'array', meta: 'object', usage: { cache_creation: { a: 'number' }, input_tokens: 'number' } },
      timestamp: 'string', toolUseResult: 'object', type: 'string',
    })
    assert.ok(!JSON.stringify(fp).includes('secret'))
  })

  test('a key that looks like a path, URL or e-mail address is written <key>', () => {
    assert.deepStrictEqual(fingerprint({ '/Users/me/repo': 1, 'https://x.y': 2, 'a@b.co': 3, ok_key: 4 }, { structural: [] }),
      { '<key>': 'number', ok_key: 'number' })
  })

  test('diff lists added, removed and retyped keys', () => {
    assert.deepStrictEqual(
      diffFingerprints({ type: 'string', payload: { tokens: 'number', old: 'string' } }, { type: 'string', payload: { tokens: 'string', fresh: 'boolean' } }),
      ['+ payload.fresh: boolean', '- payload.old', '~ payload.tokens: number → string'])
    assert.deepStrictEqual(diffFingerprints({ a: 'string' }, { a: 'string' }), [])
  })
})

suite('adapters — registry', () => {
  test('labels and directories by LogReader key, both Copilot Chat formats as one agent', () => {
    assert.strictEqual(agentKeyLabel('claude'), 'Claude Code')
    assert.strictEqual(agentKeyLabel('copilot_vscode_json'), 'Copilot (VS Code)')
    assert.strictEqual(adapterForLogKey('copilot_vscode_json')?.key, 'copilot_vscode')
    assert.strictEqual(agentKeyDir('codex'), '~/.codex/sessions/')
    assert.strictEqual(agentKeyLabel('unheard_of'), 'unheard_of')
  })

  test('keys are unique and every LogReader key belongs to exactly one adapter', () => {
    assert.strictEqual(new Set(ADAPTERS.map(a => a.key)).size, ADAPTERS.length)
    const logKeys = ADAPTERS.flatMap(a => a.logKeys)
    assert.strictEqual(new Set(logKeys).size, logKeys.length)
  })

  test('one agent key list: the extension and the standalone server import the registry', () => {
    const root = path.join(__dirname, '..', '..', '..')
    const ext = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8')
    assert.ok(ext.includes("from './adapters/registry'"))
    assert.ok(!/AGENT_KEY_LABEL\s*[:=]/.test(ext), 'src/extension.ts carries its own label table again')
    assert.ok(fs.readFileSync(path.join(root, 'standalone', 'server.ts'), 'utf8').includes("from '../src/adapters/registry'"))
  })
})
