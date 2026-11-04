import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { observeRecords } from '../adapters/classify'
import { AdapterHealth, adapterHealthMessage, bannerWorthy, compareVersions, persistAdapterHealth, restoreAdapterHealth } from '../adapters/health'
import { buildAgentReport } from '../adapters/report'
import { LogReader } from '../logReader'
import { OtlpIngest } from '../otlpIngest'

const FIXTURES = path.join(__dirname, '..', '..', '..', 'src', 'test', 'fixtures', 'agents')
const NOW = 1_780_000_000_000

const claudeOk = (version = '2.1.310') => observeRecords('claude', [
  { type: 'user', message: {}, timestamp: 't', uuid: 'u', version },
  { type: 'assistant', message: { usage: {} }, timestamp: 't' },
  { type: 'summary' },
])!

suite('adapter health — thresholds and versions', () => {
  test('the banner needs 5 unknown records, or 1% of the version\'s records when that is fewer', () => {
    assert.strictEqual(bannerWorthy({ known: 10, ignored: 0, unknown: 1 }), true)       // 1% of 11 rounds up to 1
    assert.strictEqual(bannerWorthy({ known: 1000, ignored: 0, unknown: 4 }), false)    // under 5 and under 1%
    assert.strictEqual(bannerWorthy({ known: 1000, ignored: 0, unknown: 5 }), true)
    assert.strictEqual(bannerWorthy({ known: 1000, ignored: 0, unknown: 0 }), false)
  })

  test('versions compare part by part; a release outranks its pre-release; unknown sorts first', () => {
    assert.ok(compareVersions('2.1.10', '2.1.9') > 0)
    assert.ok(compareVersions('0.162.0', '0.162.0-alpha.17') > 0)
    assert.ok(compareVersions('unknown', '0.0.1') < 0)
    assert.strictEqual(compareVersions('1.0.0', '1.0.0'), 0)
  })
})

suite('adapter health — status per agent', () => {
  test('no data, then not verified (no committed real capture), then unrecognized', () => {
    const h = new AdapterHealth(() => NOW)
    const row = () => h.rows().find(r => r.key === 'claude')!
    assert.strictEqual(row().status, 'no-data')
    h.observeFile('/a.jsonl', claudeOk(), NOW - 5000)
    assert.strictEqual(row().status, 'not-verified')
    assert.strictEqual(row().versionSeen, '2.1.310')
    assert.strictEqual(row().lastFilesMs, NOW - 5000)
    h.observeFile('/b.jsonl', observeRecords('claude', [{ type: 'brand-new', version: '2.2.0' }])!)
    assert.strictEqual(row().status, 'unrecognized')
    assert.strictEqual(row().versionSeen, '2.2.0')
    assert.deepStrictEqual(row().versions.map(v => [v.version, v.banner]), [['2.2.0', true], ['2.1.310', false]])
    assert.strictEqual(h.rows().find(r => r.key === 'codex')!.status, 'no-data')
  })

  test('a re-read file replaces its own entry instead of adding to it', () => {
    const h = new AdapterHealth(() => NOW)
    h.observeFile('/a.jsonl', claudeOk())
    h.observeFile('/a.jsonl', claudeOk())
    assert.strictEqual(h.rows().find(r => r.key === 'claude')!.versions[0].known, 2)
  })

  test('OTLP: an unknown event name from Claude Code flags Claude only; another emitter counts for nobody', () => {
    const h = new AdapterHealth(() => NOW)
    const ingest = new OtlpIngest({ addSpan: () => { /* drop */ }, injectSpanAttribute: () => false }, h)
    const resource = { attributes: [{ key: 'service.name', value: { stringValue: 'claude-code' } }, { key: 'service.version', value: { stringValue: '2.1.320' } }] }
    const log = (name: string) => ({ attributes: [{ key: 'event.name', value: { stringValue: name } }, { key: 'prompt', value: { stringValue: 'secret prompt text' } }] })
    ingest.processLogs({ resourceLogs: [{ resource, scopeLogs: [{ logRecords: [log('user_prompt'), log('api_request'), log('shiny_new_event')] }] }] })
    ingest.processTraces({ resourceSpans: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'my-web-app' } }] }, scopeSpans: [{ spans: [{ traceId: 't', spanId: 's', name: 'GET /' }] }] }] })
    const rows = h.rows()
    const claude = rows.find(r => r.key === 'claude')!
    assert.strictEqual(claude.status, 'unrecognized')
    assert.deepStrictEqual(claude.versions[0].unknownNames, { shiny_new_event: 1 })
    assert.deepStrictEqual(claude.versions[0].fingerprints['shiny_new_event'], { name: 'string', attributes: { 'event.name': 'string', prompt: 'string', 'service.name': 'string', 'service.version': 'string' } })
    assert.ok(claude.lastOtlpMs === NOW && claude.lastFilesMs === null)
    assert.ok(rows.filter(r => r.key !== 'claude').every(r => r.status === 'no-data'))
    assert.ok(!JSON.stringify(h.export()).includes('secret prompt text'))
  })

  test('persists to a sidecar without file paths, and restores', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-health-'))
    try {
      const h = new AdapterHealth(() => NOW)
      h.observeFile('/Users/someone/.claude/projects/x/session.jsonl', claudeOk())
      persistAdapterHealth(h, dir)
      const text = fs.readFileSync(path.join(dir, 'adapter-health.json'), 'utf8')
      assert.ok(!text.includes('/Users/someone') && !text.includes('session.jsonl'))
      const back = new AdapterHealth(() => NOW)
      restoreAdapterHealth(back, dir)
      assert.deepStrictEqual(back.rows(), h.rows())
      restoreAdapterHealth(new AdapterHealth(), path.join(dir, 'missing'))  // no throw
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})

suite('adapter health — acceptance against a committed fixture', () => {
  // Replaying the Claude fixture with one record's `type` renamed: only Claude is flagged, past the
  // banner threshold; the report names it, counts it and shows its structure, and carries no value
  // from any record of the fixture.
  test('a renamed record type raises the banner for that agent only; Report this leaks no value', () => {
    const src = path.join(FIXTURES, 'claude', 'synthetic-2.1.310', 'files', '.claude', 'projects', '-repo')
    const file = fs.readdirSync(src).find(f => f.endsWith('.jsonl'))!
    const records = fs.readFileSync(path.join(src, file), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>)
    const victim = records.findIndex(r => r['type'] === 'assistant')
    records[victim] = { ...records[victim], type: 'assistant_v2' }

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-renamed-'))
    try {
      const target = path.join(tmp, file)
      fs.writeFileSync(target, records.map(r => JSON.stringify(r)).join('\n') + '\n')
      const h = new AdapterHealth(() => NOW)
      new LogReader({ observe: (f, o, m) => h.observeFile(f, o, m) }).parseFile(target, 'claude')

      const msg = adapterHealthMessage(h, '0.21.0')
      const flagged = msg.rows.filter(r => r.versions.some(v => v.banner))
      assert.deepStrictEqual(flagged.map(r => r.key), ['claude'])
      const v = flagged[0].versions[0]
      assert.deepStrictEqual(v.unknownNames, { assistant_v2: 1 })
      const report = v.report!
      assert.ok(report && report === msg.rows[0].versions[0].report)
      assert.match(report.body, /\| `assistant_v2` \| 1 \|/)
      assert.match(report.body, /"usage": \{/)

      // Every string and number value in the fixture, except the closed vocabulary the report is
      // allowed to name: record types, key names and the agent version.
      const allowed = new Set(['2.1.310', ...records.map(r => String(r['type']))])
      const keys = (x: unknown): void => {
        if (Array.isArray(x)) x.forEach(keys)
        else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) { allowed.add(k); keys(v) }
      }
      records.forEach(keys)
      const values = new Set<string>()
      const collect = (x: unknown): void => {
        if (typeof x === 'string' || typeof x === 'number') { const s = String(x); if (s.length >= 3 && !allowed.has(s)) values.add(s) }
        else if (Array.isArray(x)) x.forEach(collect)
        else if (x && typeof x === 'object') Object.values(x).forEach(collect)
      }
      records.forEach(collect)
      assert.ok(values.size > 20)
      const decodedUrl = decodeURIComponent(report.url.replace(/\+/g, ' '))
      for (const value of values) {
        assert.ok(!report.body.includes(value), `the report body contains the fixture value ${JSON.stringify(value)}`)
        assert.ok(!decodedUrl.includes(value), `the report URL contains the fixture value ${JSON.stringify(value)}`)
      }
    } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
  })

  test('a report too big for the issue form drops structures first and stays under the URL limit', () => {
    const h = new AdapterHealth(() => NOW)
    const many = Array.from({ length: 40 }, (_, i) => ({ type: `new_type_${i}`, version: '2.2.0', payload: Object.fromEntries(Array.from({ length: 30 }, (_, k) => [`field_${k}`, k])) }))
    h.observeFile('/x.jsonl', observeRecords('claude', many)!)
    const row = h.rows().find(r => r.key === 'claude')!
    const report = buildAgentReport(row, '2.2.0', { traceroostVersion: '0.21.0', os: 'darwin arm64' })!
    assert.ok(report.url.length <= 7500, `${report.url.length}`)
    assert.match(report.body, /left out to fit the issue form/)
    assert.match(report.body, /new_type_39/)
  })
})
