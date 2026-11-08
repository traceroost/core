import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { LogReader, type LogSessionResult, type OpenCodeSqlFactory } from '../logReader'
import { calcSessionCostUsd } from '../pricing'
import { ADAPTERS, adapterFor } from '../adapters/registry'
import { compareVersions } from '../adapters/health'
import { RECORDS_BY_LOG_KEY, atPath, classifyRecord, type FileObservation } from '../adapters/classify'

// The adapter contract suite (runbooks/AGENT_FORMAT_BREAK.md): every committed fixture under
// src/test/fixtures/agents/<adapter>/<version>/ parses with zero unknown records, records the
// agent version its manifest names, and adds up to its expected.json. A new agent version gets a
// new directory beside the old ones, which keep passing.
//
// UPDATE_AGENT_FIXTURES=1 rewrites each expected.json from what the parser produces now — for a
// new fixture, or after a deliberate parser change. Review the diff before committing it.

const FIXTURES = path.join(__dirname, '..', '..', '..', 'src', 'test', 'fixtures', 'agents')
const UPDATE = process.env['UPDATE_AGENT_FIXTURES'] === '1'

interface Manifest {
  adapter: string
  agentVersion: string
  source: 'capture' | 'synthetic'
  files: Array<{ path: string; logKey: string }>
}

interface Totals {
  traces: number
  turns: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreateTokens: number
  toolCalls: number
  costUsd: number
}

function fixtureDirs(): Array<{ adapter: string; version: string; dir: string }> {
  if (!fs.existsSync(FIXTURES)) return []
  return fs.readdirSync(FIXTURES).flatMap(adapter =>
    fs.readdirSync(path.join(FIXTURES, adapter))
      .filter(v => fs.existsSync(path.join(FIXTURES, adapter, v, 'manifest.json')))
      .map(version => ({ adapter, version, dir: path.join(FIXTURES, adapter, version) })))
}

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)])
}

type SqlDb = { run(sql: string): void; export(): Uint8Array; close(): void }
type SqlJs = { Database: new (data?: Uint8Array) => SqlDb }

async function loadSqlJs(): Promise<SqlJs> {
  const dir = path.dirname(require.resolve('sql.js'))
  const init = require('sql.js') as (cfg: { locateFile: (f: string) => string }) => Promise<SqlJs>
  return init({ locateFile: (f: string) => path.join(dir, f) })
}

/** Reads one fixture through a real LogReader: the files are copied to a temp directory (Codex
 *  holds a turn read from a file written within the last two seconds, so they're backdated) and
 *  an OpenCode SQL script is built into a database first. */
function readFixture(dir: string, manifest: Manifest, sql: SqlJs): { results: LogSessionResult[]; observations: FileObservation[] } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-adapter-contract-'))
  const observations: FileObservation[] = []
  const results: LogSessionResult[] = []
  const prevOpenCode = process.env['OPENCODE_DATA_DIR']
  try {
    fs.cpSync(path.join(dir, 'files'), path.join(tmp, 'files'), { recursive: true })
    const old = new Date(Date.now() - 60_000)
    for (const f of walk(tmp)) fs.utimesSync(f, old, old)
    const reader = new LogReader({ sqlFactory: sql as unknown as OpenCodeSqlFactory, observe: (_file, obs) => observations.push(obs) })
    for (const file of manifest.files) {
      const filePath = path.join(tmp, file.path)
      if (file.logKey === 'opencode') {
        // A capture commits the database itself; a synthetic fixture the SQL that builds one.
        let dataDir = path.dirname(filePath)
        if (filePath.endsWith('.sql')) {
          const db = new sql.Database()
          db.run(fs.readFileSync(filePath, 'utf8'))
          dataDir = path.join(tmp, 'opencode-data')
          fs.mkdirSync(dataDir, { recursive: true })
          fs.writeFileSync(path.join(dataDir, 'opencode.db'), Buffer.from(db.export()))
          db.close()
        }
        process.env['OPENCODE_DATA_DIR'] = dataDir
        results.push(...reader.scanOpenCode())
      } else {
        results.push(...reader.parseFile(filePath, file.logKey))
      }
    }
  } finally {
    if (prevOpenCode === undefined) delete process.env['OPENCODE_DATA_DIR']
    else process.env['OPENCODE_DATA_DIR'] = prevOpenCode
    fs.rmSync(tmp, { recursive: true, force: true })
  }
  return { results, observations }
}

function totalsOf(results: LogSessionResult[]): Totals {
  const t: Totals = { traces: 0, turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, toolCalls: 0, costUsd: 0 }
  for (const { card } of results) {
    t.traces++
    t.turns += card.turns
    t.inputTokens += card.inputTokens
    t.outputTokens += card.outputTokens
    t.cacheReadTokens += card.cacheReadTokens ?? 0
    t.cacheCreateTokens += card.cacheCreateTokens ?? 0
    t.toolCalls += card.totalToolCalls
    t.costUsd += calcSessionCostUsd(card)
  }
  t.costUsd = Math.round(t.costUsd * 1e6) / 1e6
  return t
}

suite('Adapter contracts — committed agent fixtures', () => {
  let sql: SqlJs
  suiteSetup(async () => { sql = await loadSqlJs() })

  const dirs = fixtureDirs()

  test('every adapter in the registry has at least one fixture, and every fixture an adapter', () => {
    const withFixtures = new Set(dirs.map(d => d.adapter))
    for (const a of ADAPTERS) assert.ok(withFixtures.has(a.key), `no fixture for ${a.key} under src/test/fixtures/agents/${a.key}/`)
    for (const d of dirs) assert.ok(adapterFor(d.adapter), `fixture directory ${d.adapter} names no adapter in registry.ts`)
  })

  for (const { adapter, version, dir } of dirs) {
    test(`${adapter} ${version}: zero unknown records, the recorded version, totals match expected.json`, () => {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as Manifest
      assert.strictEqual(manifest.adapter, adapter)
      const { results, observations } = readFixture(dir, manifest, sql)

      assert.ok(observations.length > 0, 'the reader observed no file')
      for (const obs of observations) {
        assert.strictEqual(obs.adapter, adapter)
        assert.deepStrictEqual(obs.unknownNames, {}, `unknown records in ${adapter} ${version} — extend ${adapter}/known.ts or fix the parser`)
        assert.ok(obs.known > 0, 'no record was classified known')
        assert.strictEqual(obs.version, manifest.agentVersion, 'the version the files record')
      }

      const totals = totalsOf(results)
      const expectedPath = path.join(dir, 'expected.json')
      if (UPDATE) fs.writeFileSync(expectedPath, JSON.stringify(totals, null, 2) + '\n')
      assert.ok(fs.existsSync(expectedPath), `${expectedPath} is missing — run with UPDATE_AGENT_FIXTURES=1 and review it`)
      assert.deepStrictEqual(totals, JSON.parse(fs.readFileSync(expectedPath, 'utf8')))
      assert.ok(totals.traces > 0, 'the fixture produced no trace')
    })

    test(`${adapter} ${version}: removing any name it uses from known.ts makes that record unknown`, () => {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as Manifest
      for (const file of manifest.files) {
        const known = RECORDS_BY_LOG_KEY[file.logKey]
        if (file.logKey === 'opencode') continue  // classified by SQL GROUP BY; covered in adapters.classify.test.ts
        const text = fs.readFileSync(path.join(dir, file.path), 'utf8')
        const records = file.path.endsWith('.jsonl') ? text.split('\n').filter(l => l.trim()).map(l => JSON.parse(l) as unknown) : [JSON.parse(text) as unknown]
        const names = new Set(records.map(r => classifyRecord(known, r).name))
        for (const name of names) {
          const { [name]: _dropped, ...consumed } = known.consumed
          const without = { ...known, consumed, ignored: known.ignored.filter(n => n !== name) }
          const record = records.find(r => classifyRecord(known, r).name === name)
          assert.strictEqual(classifyRecord(without, record).cls, 'unknown', `${name} still classified without its known.ts entry`)
        }
      }
    })
  }

  test('fixtures carry no home directory, e-mail address or token-shaped string', () => {
    const bad: Array<[RegExp, string]> = [
      [/\/Users\/[^/<\s"]+|\/home\/[^/<\s"]+|[A-Za-z]:\\\\?Users\\\\?[^\\<\s"]+/, 'home directory'],
      [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, 'e-mail address'],
      [/\b(sk-[A-Za-z0-9_-]{16,}|sk-ant-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abp]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/, 'token-shaped string'],
    ]
    for (const file of walk(FIXTURES)) {
      const text = fs.readFileSync(file, 'utf8')
      for (const [re, what] of bad) {
        const m = text.match(re)
        assert.ok(!m, `${path.relative(FIXTURES, file)} contains a ${what}: ${m?.[0]}`)
      }
    }
  })

  // known.ts `reads` is what the CI format check (tests/e2e/fingerprint-diff.mjs) holds a new
  // capture to: a misspelt path would never be found, and so never fail it.
  test('every path known.ts reads is on a record it consumes, and the fixtures carry it', () => {
    for (const [logKey, known] of Object.entries(RECORDS_BY_LOG_KEY)) {
      const seen = new Set<string>()
      for (const { dir } of fixtureDirs()) {
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as Manifest
        for (const f of manifest.files.filter(x => x.logKey === logKey && x.path.endsWith('.jsonl'))) {
          for (const line of fs.readFileSync(path.join(dir, f.path), 'utf8').split('\n').filter(l => l.trim())) {
            let r: Record<string, unknown>
            try { r = JSON.parse(line) as Record<string, unknown> } catch { continue }
            const name = known.nameOf(r)
            for (const p of (name && known.reads?.[name]) || []) if (atPath(r, p) !== undefined && atPath(r, p) !== null) seen.add(`${name} ${p}`)
          }
        }
      }
      for (const [name, paths] of Object.entries(known.reads ?? {})) {
        assert.ok(name in known.consumed, `${logKey}: reads names \`${name}\`, which known.ts doesn't consume`)
        for (const p of paths) assert.ok(seen.has(`${name} ${p}`), `${logKey}: no fixture's \`${name}\` carries \`${p}\` — misspelt?`)
      }
    }
  })

  // runbooks/AGENT_FORMAT_BREAK.md step 3 ends with "set `lastVerifiedVersion`" — but the only
  // thing checking it was adapters.classify.test.ts's README drift test, and both sides of that
  // derive from registry.ts: when it says null the README says "none yet", they agree, and
  // nothing fails. That is how #407 committed a real, tested codex 0.167.0 capture while leaving
  // the public support matrix reading "none yet". This ties the field to the fixtures instead.
  test('lastVerifiedVersion names the newest committed real capture for each adapter', () => {
    const newestCapture = new Map<string, string>()
    for (const { adapter, dir } of fixtureDirs()) {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as Manifest
      if (manifest.source !== 'capture') continue
      const prev = newestCapture.get(adapter)
      if (!prev || compareVersions(manifest.agentVersion, prev) > 0) newestCapture.set(adapter, manifest.agentVersion)
    }
    for (const a of ADAPTERS) {
      const newest = newestCapture.get(a.key) ?? null
      assert.strictEqual(
        a.lastVerifiedVersion, newest,
        newest
          ? `${a.key}: a real capture of ${newest} is committed, so registry.ts lastVerifiedVersion should be '${newest}', not ${JSON.stringify(a.lastVerifiedVersion)} — then paste supportMatrixMarkdown() into the README (runbooks/AGENT_FORMAT_BREAK.md step 3)`
          : `${a.key}: no fixture has source 'capture', so lastVerifiedVersion should be null, not ${JSON.stringify(a.lastVerifiedVersion)}`)
    }
  })

  test('the fixture corpus stays under 5 MB', () => {
    const bytes = walk(FIXTURES).reduce((n, f) => n + fs.statSync(f).size, 0)
    assert.ok(bytes < 5 * 1024 * 1024, `${(bytes / 1024 / 1024).toFixed(1)} MB — prune middle versions, keep the oldest supported and the latest`)
  })
})
