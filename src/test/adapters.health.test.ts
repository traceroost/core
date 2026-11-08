import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { observeRecords } from '../adapters/classify'
import { AdapterHealth, adapterHealthMessage, bannerWorthy, compareVersions, persistAdapterHealth, RECENT_MS, restoreAdapterHealth } from '../adapters/health'
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
  test('damage needs 5 records, or 1% of the version\'s records when that is fewer', () => {
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
  test('no data, then not verified (no committed real capture), then unrecognized — quietly', () => {
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
    // A record type TraceRoost doesn't know, with nothing it reads lost: Settings only, no banner.
    assert.deepStrictEqual(row().versions.map(v => [v.version, v.impact, v.banner]), [['2.2.0', 'skipped', false], ['2.1.310', 'none', false]])
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

// A Codex rollout like the VS Code extension's alpha builds write: records TraceRoost reads, some it
// doesn't, and no user_message — so no turns.
const codexAlpha = (turns: number | undefined) => ({
  ...observeRecords('codex', [
    { type: 'session_meta', payload: { id: 'x', cwd: '/r', cli_version: '0.162.0-alpha.17.2' } },
    { type: 'turn_context', payload: { model: 'm' } },
    { type: 'brand_new_record', payload: {} },
  ])!,
  ...(turns === undefined ? {} : { turns }),
})

suite('adapter health — loud only for recent data loss', () => {
  const DAY = 24 * 60 * 60 * 1000
  const codexRow = (h: AdapterHealth) => h.rows().find(r => r.key === 'codex')!

  test('a file that gave no turns is lost data: Missing data, and a banner while it is recent', () => {
    const h = new AdapterHealth(() => NOW)
    h.observeFile('/r1.jsonl', codexAlpha(0), NOW - DAY)
    const row = codexRow(h)
    assert.strictEqual(row.status, 'missing-data')
    assert.deepStrictEqual(row.versions.map(v => [v.impact, v.unreadFiles, v.lastImpactMs, v.banner]), [['loss', 1, NOW - DAY, true]])
  })

  test('the same loss in data older than RECENT_MS stays in Settings: Missing data, no banner', () => {
    const h = new AdapterHealth(() => NOW)
    h.observeFile('/r1.jsonl', codexAlpha(0), NOW - RECENT_MS - 1)
    h.observeFile('/r2.jsonl', codexAlpha(0), NOW - 30 * DAY)
    const row = codexRow(h)
    assert.strictEqual(row.status, 'missing-data')
    assert.deepStrictEqual(row.versions.map(v => [v.impact, v.unreadFiles, v.banner]), [['loss', 2, false]])
  })

  test('turns read, or an incomplete read, or a file of nothing TraceRoost reads: skipped, not lost', () => {
    for (const obs of [codexAlpha(3), codexAlpha(undefined)]) {
      const h = new AdapterHealth(() => NOW)
      h.observeFile('/r.jsonl', obs, NOW)
      assert.deepStrictEqual(codexRow(h).versions.map(v => [v.impact, v.banner]), [['skipped', false]])
      assert.strictEqual(codexRow(h).status, 'unrecognized')
    }
    // A Claude session opened and closed without a prompt: only metadata, some of it new.
    const h = new AdapterHealth(() => NOW)
    h.observeFile('/c.jsonl', { ...observeRecords('claude', [{ type: 'summary' }, { type: 'brand-new', version: '2.2.0' }])!, turns: 0 }, NOW)
    assert.deepStrictEqual(h.rows().find(r => r.key === 'claude')!.versions.map(v => [v.impact, v.unreadFiles]), [['skipped', 0]])
  })

  test('records TraceRoost reads missing a field it needs are lost data past the threshold', () => {
    const h = new AdapterHealth(() => NOW)
    const records = [
      { type: 'user', message: {}, timestamp: 't', uuid: 'u', version: '2.3.0' },
      ...Array.from({ length: 5 }, () => ({ type: 'assistant', message: {}, timestamp: 't' })),
    ]
    h.observeFile('/a.jsonl', { ...observeRecords('claude', records)!, turns: 1 }, NOW)
    const v = h.rows().find(r => r.key === 'claude')!.versions[0]
    assert.deepStrictEqual([v.damaged, v.unreadFiles, v.impact, v.banner], [5, 0, 'loss', true])
  })

  test('turn counts survive persist and restore', () => {
    const h = new AdapterHealth(() => NOW)
    h.observeFile('/r1.jsonl', codexAlpha(0), NOW)
    const back = new AdapterHealth(() => NOW)
    back.import(JSON.parse(JSON.stringify(h.export())))
    assert.deepStrictEqual(back.rows(), h.rows())
    assert.strictEqual(codexRow(back).versions[0].unreadFiles, 1)
  })
})

suite('adapter health — acceptance against a committed fixture', () => {
  // Replaying the Claude fixture with a record type renamed. Renaming `assistant` leaves its turns
  // without token usage: only Claude raises the banner; the report names the type, counts it and
  // shows its structure, and carries no value from any record of the fixture.
  const replay = (rename: (records: Array<Record<string, unknown>>) => void, check: (h: AdapterHealth, records: Array<Record<string, unknown>>) => void) => {
    const src = path.join(FIXTURES, 'claude', 'synthetic-2.1.310', 'files', '.claude', 'projects', '-repo')
    const file = fs.readdirSync(src).find(f => f.endsWith('.jsonl'))!
    const records = fs.readFileSync(path.join(src, file), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>)
    rename(records)
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-renamed-'))
    try {
      const target = path.join(tmp, file)
      fs.writeFileSync(target, records.map(r => JSON.stringify(r)).join('\n') + '\n')
      // Real time: the file was just written, so it is recent.
      const h = new AdapterHealth()
      new LogReader({ observe: (f, o, m) => h.observeFile(f, o, m) }).parseFile(target, 'claude')
      check(h, records)
    } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
  }

  test('one renamed record type with the sessions still read: Unrecognized data, no banner', () => {
    replay(records => { records.push({ type: 'brand_new_metadata', sessionId: 's' }) }, h => {
      const claude = h.rows().find(r => r.key === 'claude')!
      assert.strictEqual(claude.status, 'unrecognized')
      assert.deepStrictEqual(claude.versions.map(v => [v.impact, v.banner]), [['skipped', false]])
    })
  })

  test('a renamed record type that loses the sessions raises the banner for that agent only; Report this leaks no value', () => replay(records => {
    for (const r of records) if (r['type'] === 'assistant') r['type'] = 'assistant_v2'
  }, (h, records) => {
    const msg = adapterHealthMessage(h, '0.21.0')
    const flagged = msg.rows.filter(r => r.versions.some(v => v.banner))
    assert.deepStrictEqual(flagged.map(r => r.key), ['claude'])
    assert.strictEqual(flagged[0].status, 'missing-data')
    const v = flagged[0].versions[0]
    const renamed = records.filter(r => r['type'] === 'assistant_v2').length
    assert.deepStrictEqual([v.unknownNames, v.unreadFiles], [{ assistant_v2: renamed }, 1])
    const report = v.report!
    assert.ok(report && report === msg.rows[0].versions[0].report)
    assert.match(report.body, new RegExp(`\\| \`assistant_v2\` \\| ${renamed} \\|`))
    assert.match(report.body, /"usage": \{/)

    // Every string and number value in the fixture, except the closed vocabulary the report is
    // allowed to name: record types, key names and the agent version.
    // (`assistant` too: it's the renamed type, and inside `assistant_v2`.)
    const allowed = new Set(['2.1.310', 'assistant', ...records.map(r => String(r['type']))])
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
  }))

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
