import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  loadSelectedEnvironment,
  saveSelectedEnvironment,
  clearSelectedEnvironment,
} from '../../../cloud/org/environmentSelection'

suite('org/environmentSelection', () => {
  let home: string
  setup(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'al-team-env-')) })
  teardown(() => { fs.rmSync(home, { recursive: true, force: true }) })

  test('returns null when nothing is stored (no side effects, no throw)', () => {
    assert.strictEqual(loadSelectedEnvironment(home), null)
    assert.strictEqual(fs.existsSync(path.join(home, '.traceroost', 'team-env.json')), false)
  })

  test('save then load round-trips', () => {
    saveSelectedEnvironment('test', home)
    assert.strictEqual(loadSelectedEnvironment(home), 'test')
  })

  test('clear deletes the selection and is idempotent', () => {
    saveSelectedEnvironment('stage', home)
    clearSelectedEnvironment(home)
    assert.strictEqual(loadSelectedEnvironment(home), null)
    clearSelectedEnvironment(home) // no throw the second time
  })

  test('a malformed / unknown environment name loads as null, not thrown', () => {
    fs.mkdirSync(path.join(home, '.traceroost'), { recursive: true })
    fs.writeFileSync(path.join(home, '.traceroost', 'team-env.json'), JSON.stringify({ environment: 'nope' }))
    assert.strictEqual(loadSelectedEnvironment(home), null)
  })
})
