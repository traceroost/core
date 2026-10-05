import * as assert from 'assert'
import { topLevelAction, usageText } from './cliArgs'

suite('cli topLevelAction', () => {
  test('only no arguments at all starts the server', () => {
    assert.strictEqual(topLevelAction([]), 'server')
  })

  test('--version / -v print the version', () => {
    assert.strictEqual(topLevelAction(['--version']), 'version')
    assert.strictEqual(topLevelAction(['-v']), 'version')
  })

  test('--help / -h print the usage', () => {
    assert.strictEqual(topLevelAction(['--help']), 'help')
    assert.strictEqual(topLevelAction(['-h']), 'help')
  })

  test('an unknown flag is refused instead of starting the server', () => {
    assert.strictEqual(topLevelAction(['--port']), 'unknown-flag')
    assert.strictEqual(topLevelAction(['--verbose', '3000']), 'unknown-flag')
    assert.strictEqual(topLevelAction(['-x']), 'unknown-flag')
  })

  test('--explain-payload / --dry-run are recognised in any position', () => {
    assert.strictEqual(topLevelAction(['--explain-payload']), 'explain')
    assert.strictEqual(topLevelAction(['--last', '--dry-run']), 'explain')
  })

  test('a bare word is left to subcommand dispatch', () => {
    assert.strictEqual(topLevelAction(['service', 'status']), 'subcommand')
  })
})

suite('cli usageText', () => {
  test('the core edition hides cloud-only commands and options', () => {
    const core = usageText(false)
    for (const hidden of ['--reporter', 'repo hash', 'org <', 'cluster', '--explain-payload', '<hash']) {
      assert.ok(!core.includes(hidden), `core usage mentions ${hidden}`)
    }
    assert.ok(core.includes('traceroost find <trace/session id | repo name>'))
    assert.ok(core.includes('--version'))
  })

  test('the full edition lists them', () => {
    const full = usageText(true)
    for (const shown of ['--reporter', 'repo hash', 'org <link', 'cluster --repo', '--explain-payload']) {
      assert.ok(full.includes(shown), `full usage is missing ${shown}`)
    }
  })
})
