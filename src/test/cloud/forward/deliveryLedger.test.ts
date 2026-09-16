import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { DeliveryLedger, ledgerPath } from '../../../cloud/forward/deliveryLedger'

suite('forward/deliveryLedger', () => {
  let home: string
  setup(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'al-ledger-')) })
  teardown(() => { fs.rmSync(home, { recursive: true, force: true }) })

  test('a key is not delivered until markDelivered is called', () => {
    const ledger = new DeliveryLedger(home)
    assert.strictEqual(ledger.isDelivered('session:a'), false)
    ledger.markDelivered('session:a')
    assert.strictEqual(ledger.isDelivered('session:a'), true)
  })

  test('survives a restart — a fresh instance reads the same file', () => {
    new DeliveryLedger(home).markDelivered('session:a')
    assert.strictEqual(new DeliveryLedger(home).isDelivered('session:a'), true)
  })

  test('markDelivered is idempotent', () => {
    const ledger = new DeliveryLedger(home)
    ledger.markDelivered('session:a')
    ledger.markDelivered('session:a')
    const raw = JSON.parse(fs.readFileSync(ledgerPath(home), 'utf-8')) as string[]
    assert.strictEqual(raw.filter(k => k === 'session:a').length, 1)
  })

  test('the file is user-only (0600)', () => {
    new DeliveryLedger(home).markDelivered('session:a')
    const mode = fs.statSync(ledgerPath(home)).mode & 0o777
    assert.strictEqual(mode, 0o600)
  })

  test('an unrecorded key on a fresh install (no file yet) is not delivered', () => {
    assert.strictEqual(new DeliveryLedger(home).isDelivered('session:a'), false)
  })

  test('oldest-first eviction past the cap', () => {
    const ledger = new DeliveryLedger(home, 3)
    ledger.markDelivered('a')
    ledger.markDelivered('b')
    ledger.markDelivered('c')
    ledger.markDelivered('d') // evicts 'a'
    assert.strictEqual(ledger.isDelivered('a'), false)
    assert.strictEqual(ledger.isDelivered('b'), true)
    assert.strictEqual(ledger.isDelivered('d'), true)
  })

  test('a torn/corrupt file is treated as empty rather than throwing', () => {
    fs.mkdirSync(path.dirname(ledgerPath(home)), { recursive: true })
    fs.writeFileSync(ledgerPath(home), '{not valid json')
    const ledger = new DeliveryLedger(home)
    assert.strictEqual(ledger.isDelivered('session:a'), false)
    ledger.markDelivered('session:a') // must not throw, and must recover to a valid file
    assert.strictEqual(new DeliveryLedger(home).isDelivered('session:a'), true)
  })
})
