import * as assert from 'assert'
import { parseServerFlags, topLevelAction, usageText, SERVER_FLAGS } from './cliArgs'

suite('cli topLevelAction', () => {
  test('only no arguments at all starts the server', () => {
    assert.strictEqual(topLevelAction([]), 'server')
  })

  test('--version / -v print the version', () => {
    assert.strictEqual(topLevelAction(['--version']), 'version')
    assert.strictEqual(topLevelAction(['-v']), 'version')
  })

  test('help / --help / -h print the usage', () => {
    assert.strictEqual(topLevelAction(['--help']), 'help')
    assert.strictEqual(topLevelAction(['-h']), 'help')
    assert.strictEqual(topLevelAction(['help']), 'help')
  })

  test("the bare run's own flags start the server; a bad value or any other flag doesn't", () => {
    assert.strictEqual(topLevelAction(['--ui-port', '3100']), 'server')
    assert.strictEqual(topLevelAction(['--no-open', '--otlp-port', '4400', '--data-dir', '/tmp/x', '--mcp-port', '4401']), 'server')
    assert.strictEqual(topLevelAction(['--ui-port']), 'unknown-flag')
    assert.strictEqual(topLevelAction(['--ui-port', 'abc']), 'unknown-flag')
    assert.strictEqual(topLevelAction(['--ui-port', '70000']), 'unknown-flag')
    assert.strictEqual(topLevelAction(['--ui-port', '3100', '--verbose']), 'unknown-flag')
    assert.strictEqual(topLevelAction(['--data-dir', '--no-open']), 'unknown-flag')
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

suite('cli parseServerFlags', () => {
  test('maps each flag to the environment variable the server already reads', () => {
    assert.deepStrictEqual(parseServerFlags(['--ui-port', '3100', '--otlp-port', '4400', '--mcp-port', '4401', '--data-dir', '/d', '--no-open']), {
      ok: true,
      env: { UI_PORT: '3100', OTLP_PORT: '4400', MCP_PORT: '4401', DATA_DIR: '/d', TRACEROOST_NO_OPEN: '1' },
    })
    assert.deepStrictEqual(parseServerFlags([]), { ok: true, env: {} })
  })

  test('says what is wrong', () => {
    assert.deepStrictEqual(parseServerFlags(['--port', '1']), { ok: false, error: 'Unknown option: --port' })
    assert.deepStrictEqual(parseServerFlags(['--ui-port']), { ok: false, error: '--ui-port needs a value' })
    assert.strictEqual(parseServerFlags(['--otlp-port', '0']).ok, false)
  })
})

suite('cli usageText', () => {
  test('every command has a one-line description, and the help documents the bare run', () => {
    for (const cloud of [false, true]) {
      const lines = usageText(cloud).split('\n')
      const commands = lines.slice(lines.indexOf('Commands:') + 1, lines.indexOf('', lines.indexOf('Commands:')))
      assert.ok(commands.length >= 10, 'commands listed')
      for (let i = 0; i < commands.length; i += 2) {
        assert.match(commands[i], /^  traceroost/, `usage line: ${commands[i]}`)
        assert.match(commands[i + 1], /^ {6}\S/, `description under ${commands[i]}`)
      }
      const text = lines.join('\n')
      for (const command of ['service', 'find', 'trace', 'patterns', 'advise', 'cohort', 'help']) {
        assert.ok(commands.some(l => l.startsWith(`  traceroost ${command}`)), `${command} is listed`)
      }
      for (const flag of Object.keys(SERVER_FLAGS)) assert.ok(text.includes(flag), `${flag} documented`)
      for (const env of ['UI_PORT', 'OTLP_PORT', 'MCP_PORT', 'DATA_DIR', 'BIND_HOST', 'TRACEROOST_NO_OPEN', 'TRACEROOST_NO_AUTOCONFIG', 'TRACEROOST_NO_UPDATE_CHECK', 'TRACEROOST_MAX_SPANS', 'TRACEROOST_BUDGET_CAP_USD', 'TRACEROOST_LOG_LEVEL']) {
        assert.ok(text.includes(env), `Environment lists ${env}`)
      }
      assert.match(text, /opens it in your browser/)
      assert.match(text, /asks once before it changes any agent's settings/)
    }
  })

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
