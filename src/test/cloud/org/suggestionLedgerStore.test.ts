import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { readLedger, recordApplied, recordDismissed, recordReverted } from '../../../cloud/org/suggestionLedgerStore'

suite('org/suggestionLedgerStore', () => {
  let home: string
  setup(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'al-ledger-')) })
  teardown(() => { fs.rmSync(home, { recursive: true, force: true }) })

  const file = () => path.join(home, '.traceroost', 'instruction-ledger.json')

  test('an absent or unreadable ledger reads as empty', () => {
    assert.deepStrictEqual(readLedger('/ws', home), { applied: [], dismissed: [], reverted: [] })
    fs.mkdirSync(path.dirname(file()), { recursive: true })
    fs.writeFileSync(file(), '{ not json')
    assert.deepStrictEqual(readLedger('/ws', home), { applied: [], dismissed: [], reverted: [] })
  })

  test('records apply / dismiss once per id, keyed by workspace', () => {
    recordApplied('/ws', 'hot_file:a', { id: 'hot_file:a', category: 'context', priority: 'high', targetAgents: ['claude_code'] }, home)
    recordApplied('/ws', 'hot_file:a', undefined, home)
    recordDismissed('/ws', 'loop:x', home)
    recordDismissed('/ws', 'loop:x', home)
    recordDismissed('/other', 'loop:y', home)
    const l = readLedger('/ws', home)
    assert.deepStrictEqual(l.applied.map(a => a.id), ['hot_file:a'])
    assert.strictEqual(l.applied[0].card?.priority, 'high', 'the first record (with its card) is kept')
    assert.ok(!Number.isNaN(Date.parse(l.applied[0].atIso)))
    assert.deepStrictEqual(l.dismissed.map(d => d.id), ['loop:x'])
    assert.deepStrictEqual(readLedger('/other', home).dismissed.map(d => d.id), ['loop:y'])
  })

  test('reverting moves an id out of applied, once', () => {
    recordApplied('/ws', 'a', undefined, home)
    recordApplied('/ws', 'b', undefined, home)
    recordReverted('/ws', 'a', home)
    recordReverted('/ws', 'a', home)
    recordReverted('/fresh', 'z', home)
    const l = readLedger('/ws', home)
    assert.deepStrictEqual(l.applied.map(a => a.id), ['b'])
    assert.deepStrictEqual(l.reverted.map(r => r.id), ['a'])
    assert.deepStrictEqual(readLedger('/fresh', home).reverted.map(r => r.id), ['z'])
  })

  test('the file is private to the user (POSIX)', function () {
    if (process.platform === 'win32') this.skip()
    recordDismissed('/ws', 'x', home)
    assert.strictEqual(fs.statSync(file()).mode & 0o777, 0o600)
  })
})
