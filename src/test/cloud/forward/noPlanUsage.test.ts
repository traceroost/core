import * as assert from 'assert'
import * as fs from 'fs'
import * as path from 'path'

// CLAUDE.md: plan-limit data (src/planUsage/**) is never sent to TraceRoost Cloud. Nothing that
// builds, queues or sends a cloud payload may reach it — this walks every cloud source directory
// and fails on any import of it, and checks the wire schema has no field that could carry it.

// mocha runs from the repo root.
const ROOT = process.cwd()
const CLOUD_DIRS = ['src/cloud', 'standalone/cloud', 'media/src/cloud']

function sourcesUnder(dir: string): string[] {
  const out: string[] = []
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourcesUnder(p))
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(p)
  }
  return out
}

suite('cloud never reaches plan-limit data', () => {
  test('no cloud source imports src/planUsage', () => {
    const files = CLOUD_DIRS.flatMap(d => sourcesUnder(path.join(ROOT, d)))
    assert.ok(files.length > 20, `expected the cloud sources, found ${files.length}`)
    const offenders = files.filter(f => /planUsage|getPlanUsageService/.test(fs.readFileSync(f, 'utf-8')))
    assert.deepStrictEqual(offenders.map(f => path.relative(ROOT, f)), [])
  })

  test('the wire schema has no plan, limit or quota field', () => {
    const schema = fs.readFileSync(path.join(ROOT, 'schema', 'rollup.v1.json'), 'utf-8')
    const keys = [...schema.matchAll(/"([a-z_]+)"\s*:/g)].map(m => m[1])
    assert.deepStrictEqual(keys.filter(k => /plan|limit|quota|window_kind|used_pct/.test(k)), [])
  })
})
