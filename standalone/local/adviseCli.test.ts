import * as assert from 'assert'
import { runAdviseCli } from './adviseCli'

suite('adviseCli usage', () => {
  let log: typeof console.log
  setup(() => { log = console.log; console.log = () => { /* silence usage text */ } })
  teardown(() => { console.log = log })

  test('no action is a usage error (exit 1), like the other subcommands', async () => {
    assert.strictEqual(await runAdviseCli([]), 1)
    assert.strictEqual(await runAdviseCli(['--repo', '/tmp']), 1)
  })

  test('--apply with its id missing is a usage error, not an id of "--repo"', async () => {
    assert.strictEqual(await runAdviseCli(['--apply']), 1)
    assert.strictEqual(await runAdviseCli(['--apply', '--repo', '/tmp']), 1)
  })
})
