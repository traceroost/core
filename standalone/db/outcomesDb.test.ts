import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { openOutcomesDb } from './outcomesDb'

suite('outcomesDb persistence', () => {
  let dir: string
  setup(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-outcomes-')) })
  teardown(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  test('save writes an owner-only file atomically and it reopens', async function () {
    const db = await openOutcomesDb(dir)
    if (!db) { this.skip(); return }
    db.raw.run("INSERT INTO claude_join (interaction_id, turn_key, status, decided_at) VALUES ('i', 't', 'joined', 1)")
    db.save()
    const file = path.join(dir, 'outcomes-cache.db')
    assert.ok(fs.existsSync(file))
    assert.deepStrictEqual(fs.readdirSync(dir), ['outcomes-cache.db'], 'no temp sibling left behind')
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600)
    const again = await openOutcomesDb(dir)
    assert.ok(again)
    const rows = again!.raw.exec('SELECT turn_key FROM claude_join')
    assert.deepStrictEqual(rows[0]?.values, [['t']])
  })

  test('a torn database file is moved aside, not overwritten by the next save', async function () {
    const file = path.join(dir, 'outcomes-cache.db')
    fs.writeFileSync(file, Buffer.from('SQLite format 3\0 torn'))
    const logs: string[] = []
    const db = await openOutcomesDb(dir, m => logs.push(m))
    if (!db) { this.skip(); return }
    db.save()
    const names = fs.readdirSync(dir).sort()
    assert.strictEqual(names.length, 2, names.join(','))
    assert.ok(names.some(n => /^outcomes-cache\.db\.corrupt-/.test(n)), names.join(','))
    assert.ok(logs.some(l => l.includes('could not be opened') && l.includes('moved it to')), logs.join('\n'))
  })
})
